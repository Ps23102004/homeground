// ============================================================================
// Headless physics harness.  npx tsx src/game/test-physics.ts
//
// Asserts real physical behaviour on synthetic terrain: downhill acceleration,
// terminal speed against the analytic solution, no tunnelling at max speed,
// never falling through the ground, pumping working on a flat, air + landing,
// steering, road-vs-grass, and wall deflection.
// ============================================================================

import assert from "node:assert/strict";
import type { Building, Road, TilePayload } from "../types.js";
import { Board, NEUTRAL_INPUT, type InputState } from "./board.js";
import { WorldCollider } from "./collider.js";
import { TUNING } from "./tuning.js";

const HALF = 500;

function tile(
  h: (x: number, z: number) => number,
  opts: { spacing?: number; buildings?: Building[]; roads?: Road[] } = {},
): TilePayload {
  const spacing = opts.spacing ?? 10;
  const n = (HALF * 2) / spacing + 1;
  const elevations = new Array<number>(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      elevations[j * n + i] = h(-HALF + i * spacing, -HALF + j * spacing);
    }
  }
  return {
    origin: { lat: 0, lon: 0 },
    radiusMeters: HALF,
    terrain: { width: n, depth: n, spacing, originX: -HALF, originZ: -HALF, elevations },
    buildings: opts.buildings ?? [],
    roads: opts.roads ?? [],
    generatedAt: new Date(0).toISOString(),
  };
}

/** A wide road running along the +X axis so the rider is never on grass. */
const eastRoad: Road = {
  centerline: [
    { x: -HALF, z: 0 },
    { x: HALF, z: 0 },
  ],
  widthMeters: 24,
  tag: "residential",
  osmTags: {},
};

function box(x0: number, z0: number, x1: number, z1: number, height = 8): Building {
  return {
    footprint: [
      { x: x0, z: z0 },
      { x: x1, z: z0 },
      { x: x1, z: z1 },
      { x: x0, z: z1 },
    ],
    height,
    tag: "residential",
    osmTags: {},
  };
}

const input = (over: Partial<InputState> = {}): InputState => ({ ...NEUTRAL_INPUT, ...over });

function boardOn(payload: TilePayload): Board {
  return new Board(new WorldCollider(payload));
}

/** Steps at a fixed 60 Hz, calling `each` after every frame. */
function run(b: Board, seconds: number, inp: InputState | ((t: number) => InputState), each?: (t: number) => void): void {
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const t = i * dt;
    b.update(dt, typeof inp === "function" ? inp(t) : inp);
    each?.(t + dt);
  }
}

let passed = 0;
function ok(name: string, extra = ""): void {
  passed++;
  console.log(`PASS  ${name}${extra ? "  — " + extra : ""}`);
}

// ---------------------------------------------------------------------------
// 1. Accelerates downhill under gravity alone.
// ---------------------------------------------------------------------------
{
  const grade = 0.08;
  const b = boardOn(tile((x) => -grade * x, { roads: [eastRoad] }));
  b.reset(-200, 0, 0); // facing +X, downhill
  const samples: number[] = [];
  run(b, 4, input(), (t) => {
    if (Math.abs(t % 1) < 1 / 120) samples.push(b.groundSpeed);
  });
  assert.ok(b.groundSpeed > 4, `expected >4 m/s after 4s, got ${b.groundSpeed.toFixed(2)}`);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! > samples[i - 1]!, `speed must keep rising: ${samples.join(", ")}`);
  }
  ok("accelerates downhill", `${b.groundSpeed.toFixed(2)} m/s after 4s on an 8% grade`);
}

// ---------------------------------------------------------------------------
// 2. Reaches terminal speed, and it matches the analytic balance
//    rollingFriction*v + airDrag*v^2 = g*sin(theta).
// ---------------------------------------------------------------------------
{
  const grade = 0.08;
  const b = boardOn(tile((x) => -grade * x, { spacing: 10, roads: [eastRoad] }));
  b.reset(-480, 0, 0);
  let prev = 0;
  let converged = 0;
  run(b, 120, input(), (t) => {
    // The slope is uniform, so wrap back up the hill instead of running off the
    // 1 km tile — same physics, unbounded track.
    if (b.pos.x > 400) b.pos.x -= 800;
    if (Math.abs(t % 1) < 1 / 120) {
      if (Math.abs(b.groundSpeed - prev) < 0.02) converged++;
      prev = b.groundSpeed;
    }
  });
  const theta = Math.atan(grade);
  const a = TUNING.airDrag;
  const bb = TUNING.rollingFriction;
  const c = -TUNING.gravity * Math.sin(theta);
  const analytic = (-bb + Math.sqrt(bb * bb - 4 * a * c)) / (2 * a);
  const err = Math.abs(b.groundSpeed - analytic) / analytic;
  assert.ok(converged > 30, `speed never settled (converged samples: ${converged})`);
  assert.ok(err < 0.1, `terminal ${b.groundSpeed.toFixed(2)} vs analytic ${analytic.toFixed(2)}`);
  ok(
    "reaches terminal speed",
    `${b.groundSpeed.toFixed(2)} m/s vs analytic ${analytic.toFixed(2)} m/s (${(err * 100).toFixed(1)}% err)`,
  );
}

// ---------------------------------------------------------------------------
// 3. Does not tunnel through a wall at max speed (velocity re-injected every
//    frame so the collider is hit at TUNING.maxSpeed, not a decayed speed).
// ---------------------------------------------------------------------------
{
  const wallX = 40;
  const b = boardOn(tile(() => 0, { buildings: [box(wallX, -60, wallX + 6, 60)], roads: [eastRoad] }));
  b.reset(0, 0, 0);
  let worstX = -Infinity;
  const limit = wallX - TUNING.riderRadius;
  run(
    b,
    3,
    input(),
    () => {
      worstX = Math.max(worstX, b.pos.x);
      b.vel.x = TUNING.maxSpeed;
      b.vel.z = 0;
    },
  );
  assert.ok(
    worstX <= limit + 0.05,
    `tunnelled: reached x=${worstX.toFixed(3)}, wall face at ${limit.toFixed(3)}`,
  );
  ok("no tunnelling at max speed", `held at x=${worstX.toFixed(3)} vs wall face ${limit.toFixed(3)} @ ${TUNING.maxSpeed} m/s`);
}

// ---------------------------------------------------------------------------
// 4. Never falls through the ground on rough terrain with active input.
// ---------------------------------------------------------------------------
{
  const h = (x: number, z: number) => -0.05 * x + 3 * Math.sin(x / 20) * Math.cos(z / 25);
  const payload = tile(h, { spacing: 5, roads: [eastRoad] });
  const col = new WorldCollider(payload);
  const b = new Board(col);
  b.reset(-300, 0, 0);
  let worstSink = 0;
  let sawAir = false;
  run(
    b,
    25,
    (t) => input({ steer: Math.sin(t * 1.7), throttle: t % 3 < 1.5 }),
    () => {
      const ground = col.heightAt(b.pos.x, b.pos.z);
      worstSink = Math.max(worstSink, ground - b.pos.y);
      if (!b.grounded) sawAir = true;
      assert.ok(Number.isFinite(b.pos.x + b.pos.y + b.pos.z), "position went non-finite");
    },
  );
  assert.ok(worstSink < 0.05, `sank ${worstSink.toFixed(3)} m below the terrain`);
  ok("never sinks through terrain", `max penetration ${worstSink.toFixed(4)} m over 25s of rough riding${sawAir ? " (incl. air time)" : ""}`);
}

// ---------------------------------------------------------------------------
// 5. Air time on a crest, and it lands again.
// ---------------------------------------------------------------------------
{
  // A 10% grade with 44 m rollers — the sort of crest that actually beats
  // v^2*curvature > g once you're moving.
  const h = (x: number) => -0.1 * x + 2.2 * Math.sin(x / 7);
  const col = new WorldCollider(tile(h, { spacing: 4, roads: [eastRoad] }));
  const b = new Board(col);
  b.reset(-420, 0, 0);
  let launches = 0;
  let landings = 0;
  let maxAir = 0;
  let wasAir = false;
  run(b, 30, input({ tuck: true }), () => {
    if (b.justLaunched) launches++;
    if (wasAir && b.grounded) landings++;
    maxAir = Math.max(maxAir, b.airTime);
    wasAir = !b.grounded;
  });
  assert.ok(launches > 0, "never left the ground on a rolling crest");
  assert.ok(landings > 0, "left the ground and never came back down");
  ok("air time and landings", `${launches} launches, ${landings} landings, longest air ${maxAir.toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
// 6. Pumping makes a dead-flat street rideable (the honest answer to suburbia).
// ---------------------------------------------------------------------------
{
  // Wide asphalt: we're testing pumping, not whether hard carves run you onto
  // the grass (they do, and that's correct).
  const plaza = { ...eastRoad, widthMeters: 400 };
  const b = boardOn(tile(() => 0, { roads: [plaza] }));
  b.reset(0, 0, 0);
  run(b, 14, (t) => input({ steer: Math.sin(t * 2.2) * 0.9, throttle: true }));
  assert.ok(b.groundSpeed > 4, `pumping on a flat only reached ${b.groundSpeed.toFixed(2)} m/s`);

  const idle = boardOn(tile(() => 0, { roads: [plaza] }));
  idle.reset(0, 0, 0);
  // reset() hands out TUNING.spawnSpeed so nobody ever spawns parked; zero it
  // here, because what this case tests is that NO input generates NO speed.
  idle.vel.x = idle.vel.z = 0;
  run(idle, 14, input());
  assert.ok(idle.groundSpeed < 0.3, `should be stationary without input, got ${idle.groundSpeed.toFixed(2)}`);
  ok("pumping generates speed on a flat", `${b.groundSpeed.toFixed(2)} m/s pumping vs ${idle.groundSpeed.toFixed(2)} m/s idle`);
}

// ---------------------------------------------------------------------------
// 7. Steering actually curves the line, and turn radius grows with speed.
// ---------------------------------------------------------------------------
{
  const mk = () => {
    const b = boardOn(tile(() => 0, { roads: [{ ...eastRoad, widthMeters: 400 }] }));
    b.reset(0, 0, 0);
    return b;
  };
  const slow = mk();
  slow.vel.x = 5;
  run(slow, 2, input({ steer: 1 }));
  const fast = mk();
  fast.vel.x = 20;
  run(fast, 2, input({ steer: 1 }));
  assert.ok(slow.yaw > 0.5, `steering right should raise yaw, got ${slow.yaw.toFixed(2)}`);
  assert.ok(fast.yaw > 0.2, `no turn at speed: ${fast.yaw.toFixed(2)}`);
  assert.ok(slow.yaw > fast.yaw, `turn radius must widen with speed (${slow.yaw.toFixed(2)} vs ${fast.yaw.toFixed(2)})`);
  ok("speed-dependent turn radius", `2s full steer: ${slow.yaw.toFixed(2)} rad @5 m/s vs ${fast.yaw.toFixed(2)} rad @20 m/s`);
}

// ---------------------------------------------------------------------------
// 8. The road is the fun line: grass costs you real speed.
// ---------------------------------------------------------------------------
{
  const grade = 0.08;
  const onRoad = boardOn(tile((x) => -grade * x, { roads: [eastRoad] }));
  onRoad.reset(-200, 0, 0);
  run(onRoad, 10, input());
  const offRoad = boardOn(tile((x) => -grade * x));
  offRoad.reset(-200, 0, 0);
  run(offRoad, 10, input());
  assert.ok(
    onRoad.groundSpeed > offRoad.groundSpeed * 1.5,
    `road ${onRoad.groundSpeed.toFixed(2)} vs grass ${offRoad.groundSpeed.toFixed(2)}`,
  );
  ok("road beats grass", `${onRoad.groundSpeed.toFixed(2)} m/s on asphalt vs ${offRoad.groundSpeed.toFixed(2)} m/s off it`);
}

// ---------------------------------------------------------------------------
// 9. Scraping a wall deflects you along it instead of dead-stopping.
// ---------------------------------------------------------------------------
{
  // Wall along +X at z = 6; approach it at a shallow angle.
  const col = new WorldCollider(
    tile(() => 0, { buildings: [box(-100, 6, 300, 40)], roads: [{ ...eastRoad, widthMeters: 40 }] }),
  );
  const b = new Board(col);
  const angle = 0.45;
  b.reset(0, 0, angle);
  b.vel.x = Math.cos(angle) * 16;
  b.vel.z = Math.sin(angle) * 16;
  let before = 0;
  let contactAt = -1;
  let after = 0;
  run(b, 2.2, input(), (t) => {
    if (before === 0 && b.pos.z > 6 - TUNING.riderRadius - 0.06) {
      before = b.groundSpeed;
      contactAt = t;
    }
    // A glancing brush, not a 2-second grind: sample 0.4 s after first contact.
    if (contactAt >= 0 && after === 0 && t >= contactAt + 0.4) after = b.groundSpeed;
    assert.ok(b.pos.z <= 6 - TUNING.riderRadius + 0.05, `went through the wall: z=${b.pos.z.toFixed(3)}`);
  });
  assert.ok(before > 0, "never actually reached the wall");
  assert.ok(after > before * 0.45, `wall killed the run: ${before.toFixed(2)} -> ${after.toFixed(2)} m/s in 0.4s`);
  assert.ok(b.pos.x > 12, `should have slid along the wall, only reached x=${b.pos.x.toFixed(1)}`);
  ok(
    "scrapes and deflects along a wall",
    `${before.toFixed(1)} -> ${after.toFixed(1)} m/s over 0.4s of contact, slid to x=${b.pos.x.toFixed(1)}`,
  );
}

// ---------------------------------------------------------------------------
// 10. Braking works, a blown landing bails, a clean one sticks.
// ---------------------------------------------------------------------------
{
  const b = boardOn(tile(() => 0, { roads: [eastRoad] }));
  b.reset(0, 0, 0);
  b.vel.x = 18;
  run(b, 1.5, input({ brake: true }));
  assert.ok(b.groundSpeed < 2, `footbrake left ${b.groundSpeed.toFixed(2)} m/s after 1.5s`);

  // Land sideways from height -> bail.
  const col = new WorldCollider(tile(() => 0, { roads: [eastRoad] }));
  const air = new Board(col);
  air.reset(0, 0, 0);
  air.grounded = false;
  air.pos.y = 12;
  air.vel.x = 0;
  air.vel.z = 18; // travelling due south while facing due east
  let bailed = false;
  let bailImpact = 0;
  run(air, 3, input(), () => {
    if (air.justBailed) {
      bailed = true;
      bailImpact = air.groundSpeed;
    }
  });
  assert.ok(bailed, "landing sideways from 12 m should bail");

  // Same drop, but pointing where you're going: stick it.
  const clean = new Board(col);
  clean.reset(0, 0, 0);
  clean.grounded = false;
  clean.pos.y = 3;
  clean.vel.x = 12;
  let cleanBail = false;
  run(clean, 3, input(), () => {
    if (clean.justBailed) cleanBail = true;
  });
  assert.ok(!cleanBail, "a straight 3 m drop should be stuck, not bailed");
  assert.ok(clean.groundSpeed > 8, `stuck landing should keep speed, got ${clean.groundSpeed.toFixed(2)}`);
  ok(
    "brake, bail, and stick",
    `brake 18 -> ${b.groundSpeed.toFixed(2)} m/s; sideways 12 m landing bailed to ${bailImpact.toFixed(1)} m/s; straight 3 m landing stuck at ${clean.groundSpeed.toFixed(1)} m/s`,
  );
}

console.log(`\n${passed}/10 physics checks passed.`);
