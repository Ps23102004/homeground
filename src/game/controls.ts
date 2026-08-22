// ============================================================================
// Input. Keyboard + touch, both producing the same InputState.
//
//   A / ArrowLeft      lean left
//   D / ArrowRight     lean right
//   W / ArrowUp / Space  push (tap on flats) and pump (hold while carving)
//   S / ArrowDown      footbrake
//   Shift              tuck (less drag, wider lens)
//   R                  respawn at the top of the run
//
//   touch: left  40% of the screen = lean left
//          right 40% of the screen = lean right
//          middle strip            = push / pump
//          two fingers anywhere    = brake
// ============================================================================

import { TUNING } from "./tuning.js";
import type { InputState } from "./board.js";

export class Controls {
  readonly state: InputState = {
    steer: 0,
    throttle: false,
    brake: false,
    tuck: false,
    pushEdge: false,
  };
  /** Set when the player asks for a respawn; the Game consumes it. */
  respawnRequested = false;
  /** True while the player is driving with touch (UI can show the zones). */
  touchActive = false;

  private keys = new Set<string>();
  private touches = new Map<number, number>(); // id -> normalized x
  private prevThrottle = false;
  private el: HTMLElement | null = null;

  attach(el: HTMLElement): void {
    this.el = el;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    el.addEventListener("touchstart", this.onTouch, { passive: false });
    el.addEventListener("touchmove", this.onTouch, { passive: false });
    el.addEventListener("touchend", this.onTouch, { passive: false });
    el.addEventListener("touchcancel", this.onTouch, { passive: false });
  }

  detach(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    const el = this.el;
    if (el) {
      el.removeEventListener("touchstart", this.onTouch);
      el.removeEventListener("touchmove", this.onTouch);
      el.removeEventListener("touchend", this.onTouch);
      el.removeEventListener("touchcancel", this.onTouch);
    }
    this.el = null;
    this.keys.clear();
    this.touches.clear();
  }

  /** Call once per frame, before Board.update. */
  poll(): InputState {
    const s = this.state;
    const k = this.keys;
    let steer = (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    let throttle = k.has("KeyW") || k.has("ArrowUp") || k.has("Space");
    let brake = k.has("KeyS") || k.has("ArrowDown");
    const tuck = k.has("ShiftLeft") || k.has("ShiftRight");

    if (this.touches.size > 0) {
      this.touchActive = true;
      const zone = TUNING.touchSteerZone;
      let left = false;
      let right = false;
      let mid = false;
      for (const nx of this.touches.values()) {
        if (nx < zone) left = true;
        else if (nx > 1 - zone) right = true;
        else mid = true;
      }
      // Two fingers on the same side = brake; that's the only free gesture left.
      if (this.touches.size >= 2 && left && right) brake = true;
      else steer = (right ? 1 : 0) - (left ? 1 : 0);
      throttle = throttle || mid || left || right;
      if (this.touches.size >= 2 && mid) brake = true;
    }

    s.steer = steer;
    s.throttle = throttle;
    s.brake = brake;
    s.tuck = tuck;
    s.pushEdge = throttle && !this.prevThrottle;
    this.prevThrottle = throttle;
    return s;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "KeyR") this.respawnRequested = true;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.touches.clear();
  };

  private onTouch = (e: TouchEvent): void => {
    e.preventDefault();
    this.touches.clear();
    const w = window.innerWidth || 1;
    for (let i = 0; i < e.touches.length; i++) {
      const t = e.touches[i]!;
      this.touches.set(t.identifier, t.clientX / w);
    }
    if (this.touches.size === 0) this.touchActive = false;
  };
}
