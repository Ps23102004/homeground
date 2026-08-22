// ============================================================================
// Spring-damped chase camera. Most of what makes speed feel like speed:
// pullback, FOV bloom and yaw lag all scale with velocity.
// ============================================================================

import type { PerspectiveCamera } from "three";
import { TUNING } from "./tuning.js";
import type { Board } from "./board.js";
import type { Collider } from "./collider.js";

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** 0..1 -> 0..1, fast out of the gate and a long settle. */
function easeOutQuint(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u * u * u;
}

export class ChaseCamera {
  private p = { x: 0, y: 0, z: 0 };
  private v = { x: 0, y: 0, z: 0 };
  private look = { x: 0, y: 0, z: 0 };
  private yaw = 0;
  private fov = TUNING.camFovBase;
  private intro = 0;
  private introDur = 1;
  /** Distance travelled, in metres — drives the road buzz so the shake is tied
   *  to ground covered rather than to wall-clock time. */
  private rolled = 0;

  constructor(private camera: PerspectiveCamera, private collider: Collider) {}

  /**
   * Arrive from a drone shot instead of cutting straight to the chase seat.
   *
   * The spawn frame is the single worst frame in the tile — the run heuristic
   * puts you at the top of a hill, which in practice is a wide junction with
   * the buildings set back, so a ground-level camera opens on an empty road.
   * From 30 m up the same spot is a neighbourhood: roofs, shadows across the
   * carriageway, the hill falling away. This flies that view down into the
   * riding seat, which is also the only moment the tilt-shift gets to be the
   * point (see the focus sweep in main.ts).
   *
   * Returns nothing; `progress` drives everything else that has to sweep.
   */
  beginIntro(seconds = 2.1): void {
    this.intro = seconds;
    this.introDur = Math.max(0.001, seconds);
  }

  /** 0 while the intro is running, 1 once the camera is fully in the seat. */
  get introProgress(): number {
    return this.intro <= 0 ? 1 : easeOutQuint(1 - this.intro / this.introDur);
  }

  snapTo(board: Board): void {
    const t = TUNING;
    this.yaw = board.yaw;
    this.p.x = board.pos.x - Math.cos(board.yaw) * t.camDistance;
    this.p.z = board.pos.z - Math.sin(board.yaw) * t.camDistance;
    this.p.y = board.pos.y + t.camHeight;
    this.v.x = this.v.y = this.v.z = 0;
    this.look.x = board.pos.x;
    this.look.y = board.pos.y + t.camLookHeight;
    this.look.z = board.pos.z;
    this.fov = t.camFovBase;
    this.intro = 0;
    this.rolled = 0;
    this.apply(0);
  }

  update(dt: number, board: Board, tuck: boolean): void {
    const t = TUNING;
    const h = Math.min(dt, 1 / 30);
    const speed = board.groundSpeed;

    this.yaw += wrapPi(board.yaw - this.yaw) * Math.min(1, t.camYawLag * h);

    const dist = Math.min(t.camDistanceMax, t.camDistance + t.camDistancePerSpeed * speed);
    const dx = board.pos.x - Math.cos(this.yaw) * dist;
    const dz = board.pos.z - Math.sin(this.yaw) * dist;
    const dy = board.pos.y + t.camHeight;

    // Critically-damped-ish spring toward the desired seat.
    const k = t.camStiffness;
    const c = 2 * t.camDamping * Math.sqrt(k);
    this.v.x += ((dx - this.p.x) * k - this.v.x * c) * h;
    this.v.y += ((dy - this.p.y) * k - this.v.y * c) * h;
    this.v.z += ((dz - this.p.z) * k - this.v.z * c) * h;
    this.p.x += this.v.x * h;
    this.p.y += this.v.y * h;
    this.p.z += this.v.z * h;

    // Never let the lens sink into a hill.
    const floor = this.collider.heightAt(this.p.x, this.p.z) + t.camMinClearance;
    if (this.p.y < floor) {
      this.p.y = floor;
      if (this.v.y < 0) this.v.y = 0;
    }

    // Road buzz. Applied to the eye only, never the look target: shaking the
    // aim point is what makes a chase camera nauseating.
    this.rolled += speed * h;
    if (board.grounded && t.camBuzz > 0) {
      const a = (t.camBuzz * Math.min(1, speed / t.maxSpeed));
      this.p.y += a * (Math.sin(this.rolled * 5.7) * 0.6 + Math.sin(this.rolled * 13.1) * 0.4);
    }

    const lx = board.pos.x + Math.cos(board.yaw) * t.camLookAhead;
    const lz = board.pos.z + Math.sin(board.yaw) * t.camLookAhead;
    const ly = board.pos.y + t.camLookHeight;
    const lk = Math.min(1, 12 * h);
    this.look.x += (lx - this.look.x) * lk;
    this.look.y += (ly - this.look.y) * lk;
    this.look.z += (lz - this.look.z) * lk;

    const targetFov = Math.min(
      t.camFovMax,
      t.camFovBase + t.camFovPerSpeed * speed + (tuck ? t.camFovTuckBonus : 0),
    );
    this.fov += (targetFov - this.fov) * Math.min(1, t.camFovResponse * h);

    if (this.intro > 0) {
      this.intro = Math.max(0, this.intro - dt);
      this.applyIntro(board, this.introProgress);
      return;
    }

    this.apply(board.lean);
  }

  /**
   * Blend the settled seat toward a high, swung-round drone pose as `k` -> 0.
   * The drone offset is recomputed from the board every frame rather than
   * captured once, so the shot tracks a rider who is already rolling.
   */
  private applyIntro(board: Board, k: number): void {
    const t = TUNING;
    const swing = (1 - k) * t.introSwingRadians;
    const back = t.camDistance + (1 - k) * (t.introDistance - t.camDistance);
    const yaw = this.yaw + swing;

    const dx = board.pos.x - Math.cos(yaw) * back;
    const dz = board.pos.z - Math.sin(yaw) * back;
    const dy = board.pos.y + t.camHeight + (1 - k) * (t.introHeight - t.camHeight);

    const cx = this.p.x + (dx - this.p.x) * (1 - k);
    const cy = this.p.y + (dy - this.p.y) * (1 - k);
    const cz = this.p.z + (dz - this.p.z) * (1 - k);

    // Keep the spring's own state at the drone pose too, so when the intro
    // ends there is nothing left to snap: k has already carried it home.
    this.p.x = cx;
    this.p.y = cy;
    this.p.z = cz;

    const cam = this.camera;
    cam.position.set(cx, cy, cz);
    cam.up.set(0, 1, 0);
    // Aim at the rider during the drone, easing to the normal look-ahead.
    cam.lookAt(
      board.pos.x + (this.look.x - board.pos.x) * k,
      board.pos.y + t.camLookHeight + (this.look.y - board.pos.y - t.camLookHeight) * k,
      board.pos.z + (this.look.z - board.pos.z) * k,
    );
    cam.rotateZ(board.lean * TUNING.camRoll * k);

    const fov = t.introFov + (this.fov - t.introFov) * k;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  private apply(lean: number): void {
    const cam = this.camera;
    cam.position.set(this.p.x, this.p.y, this.p.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(this.look.x, this.look.y, this.look.z);
    if (lean !== 0) cam.rotateZ(lean * TUNING.camRoll);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
  }
}
