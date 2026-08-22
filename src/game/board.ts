// ============================================================================
// The board. A capsule-on-heightfield integrator with carving, pumping,
// swept wall collision, air time and landings.
//
// Deliberately three.js-free so the whole thing runs headless in the test
// harness (src/game/test-physics.ts). Rendering reads the exposed basis.
// ============================================================================

import { TUNING } from "./tuning.js";
import type { Collider, Surface, WallHit } from "./collider.js";

export interface InputState {
  /** -1 hard left .. +1 hard right. */
  steer: number;
  /** Pump/push held. */
  throttle: boolean;
  /** Footbrake held. */
  brake: boolean;
  /** Tuck (reduces drag, widens FOV). */
  tuck: boolean;
  /** Rising edge of throttle this frame — one foot push. */
  pushEdge: boolean;
}

export const NEUTRAL_INPUT: InputState = {
  steer: 0,
  throttle: false,
  brake: false,
  tuck: false,
  pushEdge: false,
};

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Board {
  // --- state read by the renderer / camera ---
  pos = { x: 0, y: 0, z: 0 };
  vel = { x: 0, y: 0, z: 0 };
  /** Heading. 0 = +X (east), increasing toward +Z (south) — matches RunCandidate. */
  yaw = 0;
  /** Visual carve lean, radians. */
  lean = 0;
  grounded = true;
  onRoad = false;
  airTime = 0;
  bailTimer = 0;
  /** Set for one step when a landing was blown. */
  justBailed = false;
  /** Set for one step when the board left the ground. */
  justLaunched = false;
  /** Orthonormal basis: forward, up (terrain normal), right. */
  forward = { x: 1, y: 0, z: 0 };
  up = { x: 0, y: 1, z: 0 };
  right = { x: 0, y: 0, z: 1 };

  private steer = 0;
  private pushCd = 0;
  private acc = 0;
  private surf: Surface = { y: 0, nx: 0, ny: 1, nz: 0, onRoad: false };
  private hit: WallHit = { x: 0, z: 0, nx: 0, nz: 0 };

  constructor(private collider: Collider) {}

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  get groundSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  reset(x: number, z: number, yaw: number): void {
    this.pos.x = x;
    this.pos.z = z;
    this.pos.y = this.collider.heightAt(x, z) + TUNING.rideHeight;
    this.vel.x = Math.cos(yaw) * TUNING.spawnSpeed;
    this.vel.y = 0;
    this.vel.z = Math.sin(yaw) * TUNING.spawnSpeed;
    this.yaw = yaw;
    this.lean = 0;
    this.steer = 0;
    this.grounded = true;
    this.bailTimer = 0;
    this.airTime = 0;
    this.acc = 0;
    this.pushCd = 0;
  }

  update(dt: number, input: InputState): void {
    const t = TUNING;
    this.justBailed = false;
    this.justLaunched = false;
    this.acc += Math.min(dt, 0.25);
    let n = 0;
    let edge = input.pushEdge;
    while (this.acc >= t.fixedStep && n < t.maxSubsteps) {
      this.step(t.fixedStep, input, edge);
      edge = false; // a push is one impulse, not one per substep
      this.acc -= t.fixedStep;
      n++;
    }
    if (n >= t.maxSubsteps) this.acc = 0; // drop the backlog after a stall
  }

  private step(h: number, input: InputState, pushEdge: boolean): void {
    const t = TUNING;
    this.pushCd = Math.max(0, this.pushCd - h);
    this.bailTimer = Math.max(0, this.bailTimer - h);
    this.steer += (clamp(input.steer, -1, 1) - this.steer) * Math.min(1, t.steerResponse * h);

    if (this.grounded) this.groundStep(h, input, pushEdge);
    else this.airStep(h, input);

    const leanTarget = this.steer * t.leanMax * clamp(this.groundSpeed / 8, 0, 1);
    this.lean += (leanTarget - this.lean) * Math.min(1, t.leanResponse * h);
    this.updateBasis(h);
  }

  private groundStep(h: number, input: InputState, pushEdge: boolean): void {
    const t = TUNING;
    const s = this.collider.surfaceAt(this.pos.x, this.pos.z, this.surf);
    this.onRoad = s.onRoad;

    // Forward projected onto the slope plane.
    let fx = Math.cos(this.yaw);
    let fz = Math.sin(this.yaw);
    let fy = 0;
    const fn = fx * s.nx + fz * s.nz;
    fx -= s.nx * fn;
    fy = -s.ny * fn;
    fz -= s.nz * fn;
    const fl = Math.hypot(fx, fy, fz);
    if (fl > 1e-5) {
      fx /= fl;
      fy /= fl;
      fz /= fl;
    } else {
      fx = Math.cos(this.yaw);
      fy = 0;
      fz = Math.sin(this.yaw);
    }
    // right = forward x normal  (yaw 0 faces +X east => right is +Z south)
    const rx = fy * s.nz - fz * s.ny;
    const ry = fz * s.nx - fx * s.nz;
    const rz = fx * s.ny - fy * s.nx;

    const pitch0 = Math.asin(Math.max(-1, Math.min(1, fy)));

    let vf = this.vel.x * fx + this.vel.y * fy + this.vel.z * fz;
    let vr = this.vel.x * rx + this.vel.y * ry + this.vel.z * rz;

    // Gravity projected onto the slope: this is the whole point of the product.
    const g = t.gravity;
    const gtx = g * s.ny * s.nx;
    const gty = -g + g * s.ny * s.ny;
    const gtz = g * s.ny * s.nz;
    vf += (gtx * fx + gty * fy + gtz * fz) * h;
    vr += (gtx * rx + gty * ry + gtz * rz) * h;

    // Pump / push — how a flat suburban street stays rideable.
    if (this.bailTimer <= 0) {
      const speedNow = Math.hypot(vf, vr);
      if (input.throttle) {
        const carve = Math.min(1, Math.abs(this.steer));
        const fade = clamp(1 - speedNow / t.pumpMaxSpeed, 0, 1);
        vf += t.pumpPower * (t.pumpStraightFloor + (1 - t.pumpStraightFloor) * carve) * fade * h;
      }
      if (
        pushEdge &&
        this.pushCd <= 0 &&
        speedNow < t.pushMaxSpeed &&
        Math.abs(this.steer) < 0.35
      ) {
        vf += t.pushImpulse;
        this.pushCd = t.pushCooldown;
      }
    }

    // Rolling resistance + drag + brake.
    const speed = Math.hypot(vf, vr);
    let lin = t.rollingFriction + (s.onRoad ? 0 : t.offroadFriction);
    if (this.bailTimer > 0) lin += 2.5; // sliding down the road on your hip
    const quad = t.airDrag * (input.tuck ? t.tuckDragScale : 1);
    let decel = lin * speed + quad * speed * speed;
    if (input.brake) decel += t.brakeDecel;
    if (speed > 1e-4) {
      const scale = Math.max(0, 1 - (decel * h) / speed);
      vf *= scale;
      vr *= scale;
    }

    // Grip: scrub sideways velocity. Falls off at speed + full steer = drift.
    const sp2 = Math.hypot(vf, vr);
    const driftF = clamp((sp2 - t.driftSpeed) / t.driftSpeed, 0, 1) * Math.abs(this.steer);
    let gripRate = t.grip * (1 - driftF * (1 - t.driftGripFloor));
    if (input.brake) gripRate *= t.brakeGripScale;
    vr -= vr * Math.min(1, gripRate * h);

    // Steering. Radius grows with speed; no pivoting on the spot.
    const turnRate = t.maxTurnRate / (1 + t.turnSpeedFalloff * sp2);
    const gate = clamp(sp2 / t.minTurnSpeed, 0, 1);
    const auth = this.bailTimer > 0 ? t.bailSteerScale : 1;
    this.yaw += this.steer * turnRate * gate * auth * h;

    // Dead stop instead of jittering forever on a flat.
    if (sp2 < t.minRollSpeed && !input.throttle && Math.abs(gtx * fx + gty * fy + gtz * fz) < 0.4) {
      vf = 0;
      vr = 0;
    }

    this.vel.x = fx * vf + rx * vr;
    this.vel.y = fy * vf + ry * vr;
    this.vel.z = fz * vf + rz * vr;
    this.clampSpeed();

    this.advance(h);

    // Ground follow. You leave the ground when the crest is tighter than your
    // speed can track: v^2 * curvature > gravity. Curvature comes from the
    // change in slope-pitch over the distance travelled, measured against the
    // SMOOTHED normals (central differences), so heightfield interpolation
    // kinks don't fire it. Physical, and independent of the substep size.
    const gy = this.collider.heightAt(this.pos.x, this.pos.z) + t.rideHeight;
    const gap = this.pos.y - gy;
    const horiz = Math.hypot(this.vel.x, this.vel.z) * h;
    let launched = false;
    if (gap > 0 && horiz > 1e-5) {
      const s1 = this.collider.surfaceAt(this.pos.x, this.pos.z, this.surf);
      const pitch1 = this.pitchOn(s1.nx, s1.ny, s1.nz);
      const curvature = (pitch0 - pitch1) / horiz;
      const v = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
      launched = curvature * v * v > t.gravity * t.launchEase;
    }
    if (launched) {
      this.grounded = false;
      this.justLaunched = true;
      this.airTime = 0;
    } else {
      this.pos.y = gy;
    }
  }

  /** Climb angle of the heading once projected onto a plane with this normal.
   *  Negative going downhill. */
  private pitchOn(nx: number, ny: number, nz: number): number {
    let fx = Math.cos(this.yaw);
    let fz = Math.sin(this.yaw);
    const fn = fx * nx + fz * nz;
    const fy = -ny * fn;
    fx -= nx * fn;
    fz -= nz * fn;
    const l = Math.hypot(fx, fy, fz);
    return l > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, fy / l))) : 0;
  }

  private airStep(h: number, input: InputState): void {
    const t = TUNING;
    this.airTime += h;
    this.vel.y -= t.gravity * h;
    const sp = this.speed;
    if (sp > 1e-4) {
      const quad = t.airDrag * (input.tuck ? t.tuckDragScale : 1);
      const scale = Math.max(0, 1 - quad * sp * h);
      this.vel.x *= scale;
      this.vel.y *= scale;
      this.vel.z *= scale;
    }
    this.yaw += this.steer * t.maxTurnRate * t.airSteer * h;
    this.clampSpeed();

    this.advance(h);

    const gy = this.collider.heightAt(this.pos.x, this.pos.z) + t.rideHeight;
    if (this.pos.y <= gy) this.land(gy);
  }

  private land(gy: number): void {
    const t = TUNING;
    this.pos.y = gy;
    this.grounded = true;
    const s = this.collider.surfaceAt(this.pos.x, this.pos.z, this.surf);
    const vn = this.vel.x * s.nx + this.vel.y * s.ny + this.vel.z * s.nz;
    const impact = Math.max(0, -vn);

    const hs = Math.hypot(this.vel.x, this.vel.z);
    let mismatch = 0;
    if (hs > 2) mismatch = Math.abs(wrapPi(Math.atan2(this.vel.z, this.vel.x) - this.yaw));

    // Kill the into-slope component either way.
    this.vel.x -= s.nx * vn;
    this.vel.y -= s.ny * vn;
    this.vel.z -= s.nz * vn;

    if (impact > t.landBailSpeed || mismatch > t.landStickAngle) {
      this.bailTimer = t.bailTime;
      this.justBailed = true;
      this.vel.x *= t.bailSpeedKeep;
      this.vel.y *= t.bailSpeedKeep;
      this.vel.z *= t.bailSpeedKeep;
      if (hs > 0.5) this.yaw = Math.atan2(this.vel.z, this.vel.x);
    } else {
      // Knees compress: a big drop costs you speed even when you stick it.
      const scrub = 1 - t.landAbsorb * clamp(impact / t.landBailSpeed, 0, 1);
      this.vel.x *= scrub;
      this.vel.y *= scrub;
      this.vel.z *= scrub;
    }
  }

  /** Move by vel*h in micro-steps small enough that a wall cannot be skipped,
   *  resolving each one. Max micro-step is 0.6*radius, so any wall crossing the
   *  path leaves the circle overlapping it at some point. */
  private advance(h: number): void {
    const t = TUNING;
    const dist = this.speed * h;
    const steps = Math.min(16, Math.max(1, Math.ceil(dist / (t.riderRadius * 0.6))));
    const sh = h / steps;
    let scraped = false;
    for (let i = 0; i < steps; i++) {
      this.pos.x += this.vel.x * sh;
      this.pos.y += this.vel.y * sh;
      this.pos.z += this.vel.z * sh;
      if (this.collider.pushOut(this.pos.x, this.pos.z, this.pos.y, t.riderRadius, this.hit)) {
        this.pos.x = this.hit.x;
        this.pos.z = this.hit.z;
        const vn = this.vel.x * this.hit.nx + this.vel.z * this.hit.nz;
        if (vn < 0) {
          this.vel.x -= this.hit.nx * vn * (1 + t.wallBounce);
          this.vel.z -= this.hit.nz * vn * (1 + t.wallBounce);
        }
        const k = Math.exp(-t.wallFriction * sh);
        this.vel.x *= k;
        this.vel.z *= k;
        scraped = true;
      }
    }
    // Scraping a wall turns you along it instead of leaving you facing into it.
    if (scraped) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (hs > 1) {
        const target = Math.atan2(this.vel.z, this.vel.x);
        this.yaw += wrapPi(target - this.yaw) * Math.min(1, t.wallAlign * h);
      }
    }
  }

  private clampSpeed(): void {
    const sp = this.speed;
    if (sp > TUNING.maxSpeed) {
      const k = TUNING.maxSpeed / sp;
      this.vel.x *= k;
      this.vel.y *= k;
      this.vel.z *= k;
    }
  }

  private updateBasis(h: number): void {
    // Up chases the terrain normal on the ground, world-up in the air.
    const tx = this.grounded ? this.surf.nx : 0;
    const ty = this.grounded ? this.surf.ny : 1;
    const tz = this.grounded ? this.surf.nz : 0;
    const k = Math.min(1, 10 * h);
    this.up.x += (tx - this.up.x) * k;
    this.up.y += (ty - this.up.y) * k;
    this.up.z += (tz - this.up.z) * k;
    const ul = Math.hypot(this.up.x, this.up.y, this.up.z) || 1;
    this.up.x /= ul;
    this.up.y /= ul;
    this.up.z /= ul;

    let fx = Math.cos(this.yaw);
    let fz = Math.sin(this.yaw);
    const fn = fx * this.up.x + fz * this.up.z;
    let fy = -this.up.y * fn;
    fx -= this.up.x * fn;
    fz -= this.up.z * fn;
    const fl = Math.hypot(fx, fy, fz) || 1;
    this.forward.x = fx / fl;
    this.forward.y = fy / fl;
    this.forward.z = fz / fl;

    this.right.x = this.forward.y * this.up.z - this.forward.z * this.up.y;
    this.right.y = this.forward.z * this.up.x - this.forward.x * this.up.z;
    this.right.z = this.forward.x * this.up.y - this.forward.y * this.up.x;
  }
}
