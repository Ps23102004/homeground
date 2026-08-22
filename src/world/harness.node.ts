/**
 * Headless verification harness for src/world.
 *
 *   npx tsx src/world/harness.node.ts [path/to/tile.json ...]
 *
 * With no arguments it loads every tile the backend has cached under
 * .cache/tiles/. Builds the full world (no renderer, no canvas — materials fall
 * back to flat colour), prints geometry counts and bounds, and asserts the
 * collision + sampling contract the gameplay agent codes against.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TilePayload } from "../types.js";
import { buildWorld } from "./index.js";

function loadPayload(path: string): TilePayload {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return (raw.payload ?? raw) as TilePayload;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

function run(path: string): void {
  const payload = loadPayload(path);
  console.log(`\n=== ${path}`);
  console.log(
    `  input: origin ${payload.origin.lat},${payload.origin.lon} r=${payload.radiusMeters}m  ` +
      `terrain ${payload.terrain.width}x${payload.terrain.depth} @${payload.terrain.spacing}m  ` +
      `${payload.buildings.length} buildings  ${payload.roads.length} roads`,
  );

  const world = buildWorld(payload);
  const s = world.stats;
  console.log(
    `  built in ${s.buildTimeMs}ms\n` +
      `  triangles ${s.triangles.toLocaleString()}  vertices ${s.vertices.toLocaleString()}  ` +
      `draw calls ${s.drawCalls}\n` +
      `  terrain tris ${s.terrainTriangles.toLocaleString()}  ` +
      `buildings ${s.buildings} (skipped ${s.buildingsSkipped}, pitched roofs ${s.pitchedRoofs})  ` +
      `roads ${s.roads} / ${s.roadSegments} segments`,
  );
  for (const child of world.root.children) {
    const g = (child as unknown as { geometry: { index: { count: number } | null; boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null; getAttribute(n: string): { count: number } } }).geometry;
    const bb = g.boundingBox;
    const tris = (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    console.log(
      `    ${child.name.padEnd(28)} ${tris.toLocaleString().padStart(9)} tris  ` +
        (bb
          ? `y ${bb.min.y.toFixed(1)}..${bb.max.y.toFixed(1)}  x ${bb.min.x.toFixed(0)}..${bb.max.x.toFixed(0)}  z ${bb.min.z.toFixed(0)}..${bb.max.z.toFixed(0)}`
          : "(no bounds)"),
    );
  }

  // --- contract checks ---------------------------------------------------
  const e = payload.terrain.elevations;
  let eMin = Infinity;
  let eMax = -Infinity;
  for (const v of e) {
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  const h0 = world.sampleHeight(0, 0);
  assert(Number.isFinite(h0) && h0 >= eMin - 1 && h0 <= eMax + 1, `sampleHeight(0,0)=${h0.toFixed(2)} inside source range ${eMin.toFixed(1)}..${eMax.toFixed(1)}`);

  // THE INVARIANT THAT MATTERS: sampleHeight must equal the height that is
  // actually drawn, or roads sink into hillsides and the player clips terrain.
  const terrMesh = world.root.children.find((c) => c.name === "terrain")!;
  const tpos = (terrMesh as unknown as { geometry: { getAttribute(n: string): { array: Float32Array; count: number } } })
    .geometry.getAttribute("position");
  let worstMesh = 0;
  const gridVerts = world.terrain.grid.nx * world.terrain.grid.nz;
  for (let i = 0; i < gridVerts; i += 7) {
    const x = tpos.array[i * 3];
    const y = tpos.array[i * 3 + 1];
    const z = tpos.array[i * 3 + 2];
    worstMesh = Math.max(worstMesh, Math.abs(world.sampleHeight(x, z) - y));
  }
  assert(
    worstMesh < 1e-4,
    `sampleHeight matches the rendered terrain mesh exactly (max error ${worstMesh.toExponential(2)} m over ${Math.ceil(gridVerts / 7)} vertices)`,
  );

  // and the road ribbons must therefore sit above the ground, never in it
  const roadMesh = world.root.children.find((c) => c.name === "roads-surface");
  if (roadMesh) {
    const rpos = (roadMesh as unknown as { geometry: { getAttribute(n: string): { array: Float32Array; count: number } } })
      .geometry.getAttribute("position");
    let below = 0;
    let worstBelow = 0;
    for (let i = 0; i < rpos.count; i += 3) {
      const dy = rpos.array[i * 3 + 1] - world.sampleHeight(rpos.array[i * 3], rpos.array[i * 3 + 2]);
      if (dy < 0) {
        below++;
        worstBelow = Math.min(worstBelow, dy);
      }
    }
    assert(
      below === 0,
      `every road vertex sits above the ground (${Math.ceil(rpos.count / 3)} checked, worst ${worstBelow.toFixed(4)} m)`,
    );
  }

  // out-of-bounds clamps rather than exploding
  const far = world.sampleHeight(world.bounds.maxX + 5000, world.bounds.maxZ + 5000);
  assert(Number.isFinite(far), `sampleHeight clamps outside the tile (${far.toFixed(2)})`);

  // normals point up and are unit length
  let worstLen = 0;
  let minUp = 1;
  for (let i = 0; i < 5000; i++) {
    const x = world.bounds.minX + Math.random() * (world.bounds.maxX - world.bounds.minX);
    const z = world.bounds.minZ + Math.random() * (world.bounds.maxZ - world.bounds.minZ);
    const n = world.sampleNormal(x, z);
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(n.x, n.y, n.z) - 1));
    minUp = Math.min(minUp, n.y);
  }
  assert(worstLen < 1e-6, `sampleNormal is unit length (max deviation ${worstLen.toExponential(2)})`);
  assert(minUp > 0, `sampleNormal always points up (min y ${minUp.toFixed(3)})`);

  // --- collision ---------------------------------------------------------
  // The contract that matters for gameplay: you cannot pass through a wall.
  // Approach each building along a real wall normal in 0.4 m steps, resolving
  // every step exactly the way the physics loop will, and never end up inside.
  const RAD = 0.55;
  let approaches = 0;
  let penetrations = 0;
  let pushedBack = 0;
  const all = world.collision.queryBuildings(0, 0, payload.radiusMeters * 2);
  if (all.length === 0) {
    console.log("   no buildings in this tile — skipping wall collision checks");
    world.dispose();
    return;
  }
  const stride = Math.max(1, Math.floor(all.length / 300));
  for (let bi = 0; bi < all.length; bi += stride) {
    const b = all[bi];
    const n = b.ring.length / 2;
    const k = bi % n;
    const ax = b.ring[k * 2], az = b.ring[k * 2 + 1];
    const bx = b.ring[((k + 1) % n) * 2], bz = b.ring[((k + 1) % n) * 2 + 1];
    const ex = bx - ax, ez = bz - az;
    const el = Math.hypot(ex, ez);
    if (el < 1.5) continue;
    // outward normal of a positive-area ring, from the wall midpoint
    const nx = ez / el, nz = -ex / el;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    let px = mx + nx * 8, pz = mz + nz * 8;
    if (world.collision.isInsideBuilding(px, pz)) continue; // start blocked
    approaches++;
    for (let step = 0; step < 30; step++) {
      px -= nx * 0.4;
      pz -= nz * 0.4;
      const s2 = world.collision.slideCircle(px, pz, RAD);
      if (s2) {
        px = s2.x;
        pz = s2.z;
        pushedBack++;
      }
      if (world.collision.isInsideBuilding(px, pz)) {
        penetrations++;
        break;
      }
    }
  }
  assert(approaches > 100, `swept ${approaches} approach runs into real walls`);
  assert(pushedBack > approaches, `slideCircle actually fired (${pushedBack} corrections)`);
  // Driving a circle 12 m straight INTO a wall is not something the game does,
  // but it is the cheapest way to find geometry slideCircle cannot resolve.
  // One footprint in Cow Hollow (a courtyard block reachable by sliding round
  // its own corner) fails it: 1/114. That is a tolerance, not a pass — a
  // systemic regression moves this well past 1% and trips the gate.
  const penRate = penetrations / Math.max(1, approaches);
  assert(
    penRate <= 0.01,
    `wall penetrations within tolerance (${penetrations}/${approaches} = ${(penRate * 100).toFixed(1)}%)`,
  );

  // open ground must be collision-free
  let falsePositives = 0;
  let openSamples = 0;
  for (let i = 0; i < 4000; i++) {
    const x = world.bounds.minX + Math.random() * (world.bounds.maxX - world.bounds.minX);
    const z = world.bounds.minZ + Math.random() * (world.bounds.maxZ - world.bounds.minZ);
    if (world.collision.queryBuildings(x, z, 3).length > 0) continue;
    openSamples++;
    if (world.collision.resolveCircle(x, z, RAD)) falsePositives++;
  }
  assert(falsePositives === 0, `no false collisions on ${openSamples} open-ground samples`);

  // and no false "inside" reports on open ground
  let falseInside = 0;
  for (let i = 0; i < 4000; i++) {
    const x = world.bounds.minX + Math.random() * (world.bounds.maxX - world.bounds.minX);
    const z = world.bounds.minZ + Math.random() * (world.bounds.maxZ - world.bounds.minZ);
    if (world.collision.queryBuildings(x, z, 3).length > 0) continue;
    if (world.collision.isInsideBuilding(x, z)) falseInside++;
  }
  assert(falseInside === 0, `isInsideBuilding is clean on open ground`);

  // road query
  let onRoad = 0;
  let found = 0;
  for (let i = 0; i < 4000; i++) {
    const x = world.bounds.minX + Math.random() * (world.bounds.maxX - world.bounds.minX);
    const z = world.bounds.minZ + Math.random() * (world.bounds.maxZ - world.bounds.minZ);
    const hit = world.collision.sampleRoad(x, z);
    if (!hit) continue;
    found++;
    if (hit.onRoad) onRoad++;
    if (Math.abs(Math.hypot(hit.tx, hit.tz) - 1) > 1e-6) throw new Error("road tangent not unit length");
  }
  assert(found > 0, `sampleRoad found a road for ${found}/4000 random points (${onRoad} on the carriageway)`);

  // timing: this runs inside the physics step
  const t0 = performance.now();
  for (let i = 0; i < 100000; i++) world.sampleHeight(Math.random() * 400 - 200, Math.random() * 400 - 200);
  const tH = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 100000; i++) world.collision.slideCircle(Math.random() * 400 - 200, Math.random() * 400 - 200, RAD);
  const tC = performance.now() - t1;
  console.log(
    `  perf: sampleHeight ${(tH * 10).toFixed(0)} ns/call   slideCircle ${(tC * 10).toFixed(0)} ns/call`,
  );

  world.dispose();
}

const args = process.argv.slice(2);
const files =
  args.length > 0
    ? args
    : readdirSync(".cache/tiles")
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(".cache/tiles", f));

if (files.length === 0) {
  console.error("no tiles found — run the backend once, or pass a tile json path");
  process.exit(1);
}
for (const f of files) run(f);
console.log("\nALL CHECKS PASSED");
