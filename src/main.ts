// ============================================================================
// Homeground — app entry. Wires UI -> API -> worldgen -> gameplay -> HUD.
//
//   address -> /api/geocode -> /api/tile -> buildWorld -> new Game -> render
//
// The renderer is created once, lazily, and reused across worlds; only the
// scene contents are torn down when you go back to the address field.
// ============================================================================

import { PerspectiveCamera, Scene } from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { GeoResponse, RunCandidate, ShareState, TilePayload } from "./types.js";
import { Game, TUNING } from "./game/index.js";
import {
  buildWorld,
  configureRenderer,
  createLookDev,
  createPostFX,
  type LookDev,
  type PostFX,
  type World,
} from "./world/index.js";
import { createUI, readShareState } from "./ui/index.js";

type TileResponse = TilePayload & {
  runs?: RunCandidate[];
  elevationDataset?: string;
  queryLocal?: { x: number; z: number };
  cache?: string;
};

const app = document.getElementById("app")!;
const ui = createUI(app, {
  onSubmit: (address) => void start(address),
  onRestart: () => {
    teardown();
    history.replaceState(null, "", location.pathname);
    ui.showLanding();
  },
});

// --------------------------------------------------------------------- state

const scene = new Scene();
const camera = new PerspectiveCamera(62, 1, 0.6, 4200);
let renderer: WebGPURenderer | null = null;
let post: PostFX | null = null;
let world: World | null = null;
let look: LookDev | null = null;
let game: Game | null = null;
let running = false;
let generation = 0; // bumps on every start/teardown so stale loads can't land

// --------------------------------------------------------------------- api

async function api<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw Object.assign(new Error(detail), { status: res.status });
  }
  return (await res.json()) as T;
}

// ----------------------------------------------------------------- renderer

/** Created once. Returns null if the browser can draw neither WebGPU nor WebGL2. */
async function ensureRenderer(): Promise<WebGPURenderer | null> {
  if (renderer) return renderer;
  try {
    const { WebGPURenderer } = await import("three/webgpu");
    const r = new WebGPURenderer({ antialias: true });
    configureRenderer(r);
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.domElement.style.display = "block";
    app.appendChild(r.domElement);
    await r.init();
    renderer = r;
    // Sizing MUST happen after init(): a 0x0 swapchain never recovers, and
    // innerWidth can genuinely be 0 at module-eval time in some browsers.
    resize();
    addEventListener("resize", resize);
    const isWebGPU = (r as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend
      ?.isWebGPUBackend;
    if (isWebGPU === false) {
      ui.notice("WebGPU unavailable — running on WebGL2.");
    }
    return r;
  } catch (err) {
    console.error("[homeground] renderer init failed", err);
    ui.showError("no-webgl", String(err));
    return null;
  }
}

let lastW = 0;
let lastH = 0;
function resize(): void {
  if (!renderer) return;
  const w = innerWidth || document.documentElement.clientWidth;
  const h = innerHeight || document.documentElement.clientHeight;
  if (w < 1 || h < 1 || (w === lastW && h === lastH)) return;
  lastW = w;
  lastH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// -------------------------------------------------------------------- flow

async function start(address: string): Promise<void> {
  teardown();
  const gen = ++generation;
  ui.showLoading(address);
  try {
    const geo = await api<GeoResponse>(`/api/geocode?q=${encodeURIComponent(address)}`);
    if (gen !== generation) return;
    ui.showLoading(geo.displayName);
    await load(geo.lat, geo.lon, geo.displayName, gen);
  } catch (err) {
    if (gen !== generation) return;
    reportError(err);
  }
}

async function load(lat: number, lon: number, label: string, gen: number): Promise<void> {
  ui.setStage("terrain");
  const tile = await api<TileResponse>(`/api/tile?lat=${lat}&lon=${lon}`);
  if (gen !== generation) return;

  if (!tile.buildings?.length) {
    ui.showError("no-buildings", "0 building footprints within 1 km");
    return;
  }
  const elev = tile.terrain?.elevations ?? [];
  if (elev.length < 4 || elev.every((v) => v === elev[0])) {
    // The backend refuses to ship a fake plane, but if a future source ever
    // does, say so instead of dropping the player into a featureless void.
    ui.showError("upstream", "elevation source returned a flat/empty grid");
    return;
  }
  ui.setStage("terrain", `${tile.elevationDataset ?? "elevation"} · ${elev.length} samples`);

  const r = await ensureRenderer();
  if (!r || gen !== generation) return;

  ui.setStage("buildings", `${tile.buildings.length.toLocaleString()} footprints`);
  await nextFrame(); // let the loading UI paint before the ~300ms build blocks
  if (gen !== generation) return;

  world = buildWorld(tile);
  scene.add(world.root);
  look = createLookDev(scene, {
    radiusMeters: tile.radiusMeters,
    sunAzimuthDeg: sunAzimuthFor(tile.runs?.[0] ?? null),
  });

  ui.setStage("run", runNote(tile.runs));
  game = new Game(world, camera, r.domElement);
  scene.add(game.root);
  game.setRun(tile.runs?.[0] ?? null);

  if (!post) post = await createPostFX(r, scene, camera);
  if (gen !== generation) return;

  // The reveal: arrive on a drone shot with the tilt-shift wound all the way
  // in, then fly down into the riding seat as the focus band opens up.
  game.chase.beginIntro(reducedMotion() ? 0 : TUNING.introSeconds);

  const share: ShareState = { lat, lon, addr: label };
  ui.enterGame(share);
  // Someone opening a shared link has never seen this before and there is no
  // menu to read. One transient line is the whole tutorial — held back until
  // the drone shot has landed, so it isn't competing with the reveal.
  const controlsHint = matchMedia("(pointer: coarse)").matches
    ? "Tap either edge to carve · middle to push · two fingers to brake"
    : "A / D carve · W push and pump · S brake · Shift tuck · R restart";
  window.setTimeout(() => {
    if (gen === generation) ui.notice(controlsHint);
  }, reducedMotion() ? 400 : TUNING.introSeconds * 1000 + 250);
  loop();
}

/**
 * Aim the key light ACROSS the run, three-quarters behind.
 *
 * The look-dev default is a fixed south-west, which is a coin flip per street:
 * half the time the ride happens in a canyon entirely in its own shadow. But
 * the obvious correction — put the sun directly behind the player — is worse,
 * not better: light coming from behind the camera is the flattest light there
 * is, every surface you can see is a lit surface, and the frame has no
 * modelling at all. 74 degrees off the travel axis keeps the roadway lit while
 * the buildings on one side rake their shadows all the way across it, which is
 * the entire reason the street reads as three-dimensional.
 */
function sunAzimuthFor(run: RunCandidate | null): number | undefined {
  if (!run) return undefined;
  // yaw 0 = +X (east), increasing toward +Z (south); compass 0 = north.
  const travelDeg = (Math.atan2(Math.cos(run.spawnYawRadians), -Math.sin(run.spawnYawRadians)) * 180) / Math.PI;
  return (travelDeg + 180 - 74 + 360) % 360; // behind the rider, raking across the run
}

function runNote(runs: RunCandidate[] | undefined): string {
  const run = runs?.[0];
  if (!run) return "no downhill nearby — starting at the address";
  return `${run.elevationDrop.toFixed(0)} m drop · ${(run.avgGradient * 100).toFixed(0)}% grade`;
}

function reportError(err: unknown): void {
  const status = (err as { status?: number }).status;
  const detail = err instanceof Error ? err.message : String(err);
  console.error("[homeground]", err);
  if (status === 404) ui.showError("not-found", detail);
  else if (status === 502 || status === 504 || status === 429) ui.showError("upstream", detail);
  else if (status === undefined) ui.showError("upstream", `${detail} — is the API running?`);
  else ui.showError("unknown", detail);
}

function teardown(): void {
  generation++;
  running = false;
  if (game) {
    scene.remove(game.root);
    game.dispose();
    game = null;
  }
  if (world) {
    scene.remove(world.root);
    world.dispose();
    world = null;
  }
  if (look) {
    look.dispose();
    look = null;
  }
  scene.fog = null;
  scene.background = null;
  scene.environment = null;
  lastFocusK = -1;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Tie the tilt-shift to the arrival. At k=0 (drone) the sharp band is a sliver
 * and the frame reads as a scale model; by k=1 it has opened to the riding
 * band, where a too-narrow band would just look like a smeared windscreen.
 * Cheap enough to call every frame — both values are uniforms.
 */
let lastFocusK = -1;
function sweepFocus(k: number): void {
  if (!post || Math.abs(k - lastFocusK) < 0.002) return;
  lastFocusK = k;
  const lerp = (a: number, b: number) => a + (b - a) * k;
  post.setFocus(lerp(0.5, 0.6), lerp(0.035, 0.07), lerp(0.2, 0.36));
  post.setGrain(lerp(0.026, 0.018));
}

/** One paint, or 60ms — whichever is first. rAF never fires in a background
 *  tab, so a bare `await requestAnimationFrame` deadlocks the whole load when
 *  someone opens a share link in a tab that isn't in front. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 60);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

// -------------------------------------------------------------------- loop

let last = 0;
function loop(): void {
  if (running) return;
  running = true;
  last = performance.now();
  const frame = (now: number) => {
    if (!running || !renderer) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();
    if (game && look) {
      game.update(dt);
      look.focusShadow(game.board.pos.x, game.board.pos.y, game.board.pos.z);
      ui.setSpeed(game.speedKmh);
      sweepFocus(game.chase.introProgress);
    }
    if (post) post.render();
    else renderer.render(scene, camera);
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ restore

const shared = readShareState();
if (shared) {
  ui.showLoading(shared.addr || "shared location");
  void (async () => {
    const gen = ++generation;
    try {
      await load(shared.lat, shared.lon, shared.addr, gen);
    } catch (err) {
      if (gen === generation) reportError(err);
    }
  })();
}

// Console handles for tuning the feel live: __hg.TUNING.grip = 20, etc.
(globalThis as unknown as { __hg: unknown }).__hg = {
  get game() {
    return game;
  },
  get world() {
    return world;
  },
  get renderer() {
    return renderer;
  },
  scene,
  camera,
  get post() {
    return post;
  },
  setPost(on: boolean) {
    if (!on && post) {
      post.dispose();
      post = null;
    }
  },
  /** Drive the exact frame the rAF loop drives, n times, synchronously.
   *  requestAnimationFrame is throttled to nothing in a hidden/automated tab,
   *  so this is the only way to measure or screenshot the real pipeline there. */
  async step(n = 60, dt = 1 / 60) {
    if (!renderer) return null;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (game && look) {
        game.update(dt);
        look.focusShadow(game.board.pos.x, game.board.pos.y, game.board.pos.z);
        ui.setSpeed(game.speedKmh);
      }
      if (post) post.render();
      else renderer.render(scene, camera);
    }
    await renderer.resolveTimestampsAsync?.();
    const ms = (performance.now() - t0) / n;
    return {
      frames: n,
      msPerFrame: Math.round(ms * 100) / 100,
      fps: Math.round(1000 / ms),
      kmh: game ? Math.round(game.speedKmh) : 0,
      size: [renderer.domElement.width, renderer.domElement.height],
    };
  },
};
