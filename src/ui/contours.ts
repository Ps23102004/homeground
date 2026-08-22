/**
 * The signature element: a live topographic contour field.
 *
 * This is not decoration for its own sake — it is the same thing the product
 * does. A scalar elevation field is sampled on a grid and traced with marching
 * squares, exactly like the terrain heightfield the backend ships. Every fifth
 * line is an index contour, the real cartographic convention.
 *
 * `focus` (0..1) blends a steep radial cone into the field and tightens the
 * contour interval — the page visibly "zooms into a hill" while the world loads.
 */

/** Edge pairs to join per marching-squares case. Edges: 0=top 1=right 2=bottom 3=left. */
const CASES: readonly number[][] = [
  [], [3, 2], [2, 1], [3, 1],
  [0, 1], [0, 3, 2, 1], [0, 2], [0, 3],
  [0, 3], [0, 2], [0, 1, 2, 3], [0, 1],
  [3, 1], [2, 1], [3, 2], [],
];

const CELL_PX = 15; // CSS px between grid samples
const FRAME_MS = 1000 / 30; // contours are ambient; 30fps is plenty and cheap

export interface ContourField {
  /** 0 = wide calm survey, 1 = tight cone centred on the page. Eased internally. */
  setFocus(v: number): void;
  /** Fade the whole layer (0..1). Used to hand the frame budget to three.js. */
  fade(to: number): void;
  /** Stop the RAF loop and release the observer. */
  stop(): void;
}

export function createContourField(canvas: HTMLCanvasElement): ContourField {
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return { setFocus() {}, fade() {}, stop() {} };

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let cols = 0;
  let rows = 0;
  let grid = new Float32Array(0);
  let w = 0;
  let h = 0;
  let focus = 0;
  let focusTarget = 0;
  let raf = 0;
  let last = 0;
  let t = 0;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || window.innerWidth;
    h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.max(2, Math.ceil(w / CELL_PX) + 1);
    rows = Math.max(2, Math.ceil(h / CELL_PX) + 1);
    grid = new Float32Array(cols * rows);
  };

  /**
   * Elevation in arbitrary units. The ridge terms are driven by CSS-pixel
   * position so contour density stays identical on a phone and a 27" display;
   * only the focus cone uses normalised coords, so it stays centred and round.
   */
  const sample = (px: number, py: number, nu: number, nv: number): number => {
    const x = px / 290;
    const y = py / 290;
    const ridge =
      Math.sin(x * 1.05 + t * 0.17) * 1.0 +
      Math.sin(y * 0.83 - t * 0.12) * 0.85 +
      Math.sin(x * 0.47 + y * 0.61 - t * 0.09) * 1.25 +
      Math.sin(x * 1.61 - y * 1.27 + t * 0.05) * 0.34;
    if (focus <= 0.001) return ridge;
    const cone = -Math.hypot(nu - 0.5, nv - 0.5) * 7.5;
    return ridge * (1 - 0.62 * focus) + cone * focus;
  };

  const draw = () => {
    ctx.clearRect(0, 0, w, h);
    if (cols < 2 || rows < 2) return;

    const sx = w / (cols - 1);
    const sy = h / (rows - 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let r = 0; r < rows; r++) {
      const nv = r / (rows - 1);
      const py = r * sy;
      for (let c = 0; c < cols; c++) {
        const val = sample(c * sx, py, c / (cols - 1), nv);
        grid[r * cols + c] = val;
        if (val < lo) lo = val;
        if (val > hi) hi = val;
      }
    }

    const step = 0.46 - 0.28 * focus; // contour interval tightens as we focus
    const first = Math.ceil(lo / step);
    const lastLevel = Math.floor(hi / step);

    for (let li = first; li <= lastLevel; li++) {
      const level = li * step;
      const index = ((li % 5) + 5) % 5 === 0; // every 5th line is an index contour
      ctx.beginPath();
      ctx.lineWidth = index ? 1.3 : 0.9;
      // Alpha here is fighting the page vignette, which sits on top of this
      // canvas. At the old 0.17/0.19 the field was technically animating and
      // visually absent — the one bold element on the page, invisible.
      ctx.strokeStyle = index
        ? `rgba(255, 157, 74, ${0.3 + 0.3 * focus})`
        : `rgba(132, 158, 192, ${0.26 + 0.12 * focus})`;

      for (let r = 0; r < rows - 1; r++) {
        const base = r * cols;
        const next = base + cols;
        for (let c = 0; c < cols - 1; c++) {
          const a = grid[base + c];      // top-left
          const b = grid[base + c + 1];  // top-right
          const d = grid[next + c + 1];  // bottom-right
          const e = grid[next + c];      // bottom-left

          let idx = 0;
          if (a > level) idx |= 8;
          if (b > level) idx |= 4;
          if (d > level) idx |= 2;
          if (e > level) idx |= 1;
          const seg = CASES[idx];
          if (seg.length === 0) continue;

          // ponytail: saddle cases (5, 10) are resolved arbitrarily rather than by
          // centre-sampling. At a 15px cell the difference is sub-pixel. Upgrade to
          // centre-value disambiguation only if visible crossings ever appear.
          for (let s = 0; s < seg.length; s += 2) {
            const p0 = edge(seg[s], c, r, a, b, d, e, level, sx, sy);
            const p1 = edge(seg[s + 1], c, r, a, b, d, e, level, sx, sy);
            ctx.moveTo(p0[0], p0[1]);
            ctx.lineTo(p1[0], p1[1]);
          }
        }
      }
      ctx.stroke();
    }
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    t += dt;
    focus += (focusTarget - focus) * Math.min(dt * 1.9, 1);
    draw();
  };

  resize();
  const ro = new ResizeObserver(() => {
    resize();
    draw();
  });
  ro.observe(canvas);

  if (reduced) {
    draw();
  } else {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  return {
    setFocus(v) {
      focusTarget = Math.max(0, Math.min(1, v));
      if (reduced) {
        focus = focusTarget;
        draw();
      }
    },
    fade(to) {
      canvas.style.opacity = String(to);
      if (to <= 0) {
        // hand the whole frame budget to three.js while the world is on screen
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        // CSS transitions are frozen while a tab is hidden, which can leave the
        // field stuck part-faded ON TOP of the game. Belt and braces: hide it
        // outright once the fade has had its time.
        setTimeout(() => {
          if (canvas.style.opacity === "0") canvas.style.visibility = "hidden";
        }, 950);
      } else if (!raf && !reduced) {
        canvas.style.visibility = "";
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else {
        canvas.style.visibility = "";
      }
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
    },
  };
}

/** Interpolated point on one cell edge, in CSS pixels. */
function edge(
  which: number,
  c: number,
  r: number,
  a: number,
  b: number,
  d: number,
  e: number,
  level: number,
  sx: number,
  sy: number,
): [number, number] {
  switch (which) {
    case 0:  return [(c + frac(a, b, level)) * sx, r * sy];
    case 1:  return [(c + 1) * sx, (r + frac(b, d, level)) * sy];
    case 2:  return [(c + frac(e, d, level)) * sx, (r + 1) * sy];
    default: return [c * sx, (r + frac(a, e, level)) * sy];
  }
}

function frac(v0: number, v1: number, level: number): number {
  const denom = v1 - v0;
  return Math.abs(denom) < 1e-9 ? 0.5 : (level - v0) / denom;
}
