// ============================================================================
// Homeground gameplay — public surface.
//
//   const game = new Game(tile, camera, renderer.domElement);
//   game.setRun(run);            // RunCandidate from /api/tile, or null
//   scene.add(game.root);
//   ... each frame: game.update(dt);
//
// Everything that decides how it FEELS lives in ./tuning.ts.
// ============================================================================

import { Group, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from "three";
import type { RunCandidate, TilePayload } from "../types.js";
import { Board, NEUTRAL_INPUT, type InputState } from "./board.js";
import {
  WorldCollider,
  colliderFromWorld,
  isWorldLike,
  type Collider,
  type Surface,
  type WorldLike,
} from "./collider.js";
import { ChaseCamera } from "./camera.js";
import { Controls } from "./controls.js";
import { createRiderMesh, type RiderMesh } from "./rider.js";
import { TUNING } from "./tuning.js";

export { TUNING } from "./tuning.js";
export { Board, NEUTRAL_INPUT } from "./board.js";
export type { InputState } from "./board.js";
export { WorldCollider, colliderFromWorld } from "./collider.js";
export type { Collider, Surface, WallHit, WorldLike } from "./collider.js";
export { ChaseCamera } from "./camera.js";
export { Controls } from "./controls.js";
export { createRiderMesh } from "./rider.js";
export type { RiderMesh } from "./rider.js";

/** How much of the carve lean goes into the deck vs the rider's body. */
const DECK_LEAN_SHARE = 0.35;

export class Game {
  readonly root = new Group();
  readonly collider: Collider;
  readonly board: Board;
  readonly controls = new Controls();
  readonly chase: ChaseCamera;
  readonly rider: RiderMesh;
  run: RunCandidate | null = null;

  private spawn = { x: 0, z: 0, yaw: 0 };
  private m = new Matrix4();
  private q = new Quaternion();
  private qRoll = new Quaternion();
  private vF = new Vector3();
  private vU = new Vector3();
  private vR = new Vector3();
  private surf: Surface = { y: 0, nx: 0, ny: 1, nz: 0, onRoad: false };
  private wheelSpin = 0;
  private attached = false;

  /** `source` is the built World from src/world (preferred — the board then
   *  rides exactly what you can see) or the raw TilePayload (headless / before
   *  the world is built). */
  constructor(source: TilePayload | WorldLike, camera: PerspectiveCamera, dom?: HTMLElement) {
    this.collider = isWorldLike(source) ? colliderFromWorld(source) : new WorldCollider(source);
    this.board = new Board(this.collider);
    this.chase = new ChaseCamera(camera, this.collider);
    this.rider = createRiderMesh();
    this.root.add(this.rider.root);
    this.setRun(null);
    if (dom) {
      this.controls.attach(dom);
      this.attached = true;
    }
  }

  /** Spawn at the top of the heuristic's best run. Null falls back to the
   *  address itself, facing whichever way the terrain drops. */
  setRun(run: RunCandidate | null): void {
    this.run = run;
    if (run) {
      this.spawn.x = run.spawn.x;
      this.spawn.z = run.spawn.z;
      this.spawn.yaw = run.spawnYawRadians;
    } else {
      this.collider.surfaceAt(0, 0, this.surf);
      const grade = Math.hypot(this.surf.nx, this.surf.nz);
      this.spawn.x = 0;
      this.spawn.z = 0;
      this.spawn.yaw = grade > 1e-3 ? Math.atan2(this.surf.nz, this.surf.nx) : 0;
    }
    this.respawn();
  }

  respawn(): void {
    this.board.reset(this.spawn.x, this.spawn.z, this.spawn.yaw);
    this.chase.snapTo(this.board);
    this.syncMesh();
  }

  update(dt: number): void {
    const input: InputState = this.attached ? this.controls.poll() : NEUTRAL_INPUT;
    if (this.controls.respawnRequested) {
      this.controls.respawnRequested = false;
      this.respawn();
      return;
    }
    this.board.update(dt, input);
    this.chase.update(dt, this.board, input.tuck);
    this.wheelSpin -= (this.board.groundSpeed / 0.035) * Math.min(dt, 1 / 30);
    this.syncMesh();
  }

  /** km/h, for the HUD. */
  get speedKmh(): number {
    return this.board.groundSpeed * 3.6;
  }

  dispose(): void {
    if (this.attached) this.controls.detach();
    this.attached = false;
  }

  private syncMesh(): void {
    const b = this.board;
    this.root.position.set(b.pos.x, b.pos.y, b.pos.z);
    this.vF.set(b.forward.x, b.forward.y, b.forward.z);
    this.vU.set(b.up.x, b.up.y, b.up.z);
    this.vR.set(b.right.x, b.right.y, b.right.z);
    this.m.makeBasis(this.vF, this.vU, this.vR);
    this.q.setFromRotationMatrix(this.m);
    this.qRoll.setFromAxisAngle(this.vF, b.lean * DECK_LEAN_SHARE);
    this.root.quaternion.copy(this.qRoll).multiply(this.q);

    this.rider.body.rotation.x = b.lean * (1 - DECK_LEAN_SHARE);
    // Crouch on landing impact and while bailed — reads instantly at speed.
    const crouch = b.bailTimer > 0 ? 0.45 : b.grounded ? 0 : 0.15;
    this.rider.body.scale.y = 1 - crouch * 0.5;
    for (const w of this.rider.wheels) w.rotation.z = this.wheelSpin;
  }
}

/** Re-exported so a debug panel can list every knob with its current value. */
export function tuningEntries(): [string, number][] {
  return Object.entries(TUNING) as [string, number][];
}
