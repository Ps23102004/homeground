/**
 * Browser harness for src/world — renders a cached tile with the real
 * renderer, look-dev and post stack so the look can actually be judged.
 *
 *   npm run dev  ->  http://localhost:5173/src/world/harness.html
 *
 * Query params:
 *   ?tile=<name>   tile filename under .cache/tiles (default: first found)
 *   ?cam=orbit|street|top   camera preset (default orbit)
 *   ?post=0        disable the tilt-shift pass
 *
 * Keys: [P] toggle post  [1/2/3] camera presets  [drag] orbit  [wheel] zoom
 */

import { PerspectiveCamera, Scene, Vector3 } from "three";
import { WebGPURenderer } from "three/webgpu";
import type { TilePayload } from "../types.js";
import { buildWorld, configureRenderer, createLookDev, createPostFX, type PostFX } from "./index.js";

const hud = document.getElementById("hud")!;
const params = new URLSearchParams(location.search);

async function pickTile(): Promise<{ name: string; payload: TilePayload }> {
  const want = params.get("tile");
  const candidates = want
    ? [want]
    : [
        "37.802_-122.419_1000.json",
        "49.427_8.687_1000.json",
        "39.775_-86.183_1000.json",
      ];
  for (const name of candidates) {
    try {
      const res = await fetch(`/.cache/tiles/${name}`);
      if (!res.ok) continue;
      const raw = await res.json();
      return { name, payload: (raw.payload ?? raw) as TilePayload };
    } catch {
      /* try the next one */
    }
  }
  throw new Error("no cached tile could be fetched from /.cache/tiles/");
}

const { name, payload } = await pickTile();

const scene = new Scene();
const world = buildWorld(payload);
scene.add(world.root);
const look = createLookDev(scene, { radiusMeters: payload.radiusMeters });

const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.6, 4200);
const target = new Vector3(0, world.sampleHeight(0, 0), 0);

const PRESETS = {
  orbit: { dist: 420, yaw: 0.85, pitch: 0.42, fov: 34 },
  street: { dist: 26, yaw: 2.1, pitch: 0.075, fov: 62 },
  top: { dist: 900, yaw: 0.6, pitch: 1.05, fov: 30 },
};
let preset: keyof typeof PRESETS = (params.get("cam") as keyof typeof PRESETS) ?? "orbit";
let dist = PRESETS[preset].dist;
let yaw = PRESETS[preset].yaw;
let pitch = PRESETS[preset].pitch;

function applyPreset(p: keyof typeof PRESETS) {
  preset = p;
  dist = PRESETS[p].dist;
  yaw = PRESETS[p].yaw;
  pitch = PRESETS[p].pitch;
  camera.fov = PRESETS[p].fov;
  camera.updateProjectionMatrix();
}
applyPreset(preset);

const renderer = new WebGPURenderer({ antialias: true, forceWebGL: params.has("gl") });
configureRenderer(renderer);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);
await renderer.init();

let lastW = 0;
let lastH = 0;
function resize() {
  // innerWidth can be 0 until the window is actually presented; sizing the
  // renderer to 0 leaves a permanently invalid swapchain, so poll every frame.
  const w = innerWidth || document.documentElement.clientWidth;
  const h = innerHeight || document.documentElement.clientHeight;
  if (w < 1 || h < 1 || (w === lastW && h === lastH)) return;
  lastW = w;
  lastH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
resize(); // must run AFTER init(): sizing before it leaves a 0x0 swapchain
addEventListener("resize", resize);

let post: PostFX | null = params.get("post") === "0" ? null : await createPostFX(renderer, scene, camera);
let postOn = post !== null;

let dragging = false;
let lx = 0;
let ly = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  dragging = true;
  lx = e.clientX;
  ly = e.clientY;
});
addEventListener("pointerup", () => (dragging = false));
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lx) * 0.005;
  pitch = Math.max(0.02, Math.min(1.45, pitch + (e.clientY - ly) * 0.004));
  lx = e.clientX;
  ly = e.clientY;
});
addEventListener("wheel", (e) => {
  dist = Math.max(8, Math.min(2000, dist * (1 + Math.sign(e.deltaY) * 0.12)));
}, { passive: true });
addEventListener("keydown", (e) => {
  if (e.key === "p" || e.key === "P") postOn = !postOn && post !== null;
  if (e.key === "1") applyPreset("orbit");
  if (e.key === "2") applyPreset("street");
  if (e.key === "3") applyPreset("top");
});

const s = world.stats;
let frames = 0;
let fpsAccum = 0;
let fps = 0;
let last = performance.now();

// Debug handles + a real frame benchmark. requestAnimationFrame is throttled in
// headless/background windows, so the on-screen fps counter is not trustworthy
// there; __hg.bench(n) renders n frames back to back and reports the true cost.
(globalThis as unknown as { __hg: unknown }).__hg = {
  frames: 0,
  renderer,
  scene,
  camera,
  world,
  look,
  get post() {
    return post;
  },
  setPost(on: boolean) {
    postOn = on && post !== null;
  },
  setCam(p: keyof typeof PRESETS) {
    applyPreset(p);
  },
  setTarget(x: number, z: number) {
    target.set(x, world.sampleHeight(x, z), z);
  },
  /** Stand on the nearest road to (x, z) and look along it. */
  standOnRoad(x = 0, z = 0) {
    for (let r = 0; r < 400; r += 8) {
      for (let a = 0; a < 12; a++) {
        const px = x + Math.cos((a / 12) * Math.PI * 2) * r;
        const pz = z + Math.sin((a / 12) * Math.PI * 2) * r;
        const hit = world.collision.sampleRoad(px, pz, 6);
        if (hit && hit.onRoad && !world.collision.isInsideBuilding(px, pz)) {
          target.set(px, world.sampleHeight(px, pz), pz);
          applyPreset("street");
          yaw = Math.atan2(hit.tx, hit.tz) + Math.PI;
          return { x: px, z: pz, tag: hit.tag };
        }
      }
    }
    return null;
  },
  setView(d: number, y: number, pi: number) {
    dist = d;
    yaw = y;
    pitch = pi;
  },
  async bench(n = 120) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      if (postOn && post) post.render();
      else renderer.render(scene, camera);
    }
    await renderer.resolveTimestampsAsync?.();
    const ms = (performance.now() - t0) / n;
    return { frames: n, msPerFrame: Math.round(ms * 100) / 100, fps: Math.round(1000 / ms) };
  },
  shadowState() {
    return {
      enabled: renderer.shadowMap.enabled,
      type: renderer.shadowMap.type,
      sunIntensity: look.sun.intensity,
      castShadow: look.sun.castShadow,
      sunPos: look.sun.position.toArray(),
      targetPos: look.sun.target.position.toArray(),
      shadowCam: [look.sun.shadow.camera.left, look.sun.shadow.camera.right],
      casters: scene.children.flatMap((c) =>
        c.children.filter((m) => m.castShadow).map((m) => m.name),
      ),
    };
  },
};

function tick() {
  resize();
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++;
  fpsAccum += dt;
  if (fpsAccum > 0.5) {
    fps = Math.round(frames / fpsAccum);
    frames = 0;
    fpsAccum = 0;
  }

  const cy = Math.cos(pitch);
  camera.position.set(
    target.x + Math.sin(yaw) * cy * dist,
    target.y + Math.sin(pitch) * dist + (preset === "street" ? 1.6 : 0),
    target.z + Math.cos(yaw) * cy * dist,
  );
  camera.lookAt(target.x, target.y + (preset === "street" ? 1.6 : dist * 0.06), target.z);
  look.focusShadow(target.x, target.y, target.z);

  if (postOn && post) post.render();
  else renderer.render(scene, camera);

  (globalThis as unknown as { __hg: { frames: number } }).__hg.frames++;

  hud.innerHTML =
    `<b>${name}</b>\n` +
    `${fps} fps   ${renderer.backend.constructor.name.replace("Backend", "")}\n` +
    `draw calls  ${s.drawCalls}\n` +
    `triangles   ${s.triangles.toLocaleString()}\n` +
    `vertices    ${s.vertices.toLocaleString()}\n` +
    `buildings   ${s.buildings} (${s.pitchedRoofs} pitched)\n` +
    `roads       ${s.roads} / ${s.roadSegments} seg\n` +
    `build       ${s.buildTimeMs} ms\n` +
    `post        ${post ? (postOn ? "on" : "off") : "unavailable"}   cam ${preset}`;

  requestAnimationFrame(tick);
}
tick();
