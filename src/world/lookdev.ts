// ---------------------------------------------------------------------------
// Homeground — look development.
//
// The target is a warm, restrained architectural model: late-afternoon sun at
// ~19 degrees, long soft shadows, a cool sky bounce for the fill, and enough
// haze that distance reads. Palette discipline is the whole point — nothing in
// this file is saturated, and there are no accent hues.
//
// Imports `three` core only, so it is safe to load headless.
// ---------------------------------------------------------------------------

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  PCFSoftShadowMap,
  Scene,
  Vector3,
} from "three";
import { makeEnvironment } from "./materials.js";

// Compass azimuth (deg, 0 = north) and elevation (deg) of the key light.
// Elevation is the single most important look knob and it is NOT free to lower:
// below roughly 25 degrees a dense neighbourhood puts every street into shadow,
// the whole frame flattens, and it reads as "there are no shadows at all".
// There is also a ceiling from the other side, and it is tighter than it looks:
// with the key raking ACROSS a street (which is what makes the facades read),
// a 15 m terrace at 30 degrees throws a 26 m shadow, and a city street is about
// 20 m kerb to kerb — so the entire carriageway sits in shadow for the whole
// ride and the biggest surface in frame goes dead. 40 degrees lands the shadow
// line down the middle of the road: near half in shade, far half lit, which is
// the thing that actually looks like a late afternoon.
// What matters at least as much is that the app aims
// the sun ACROSS the run rather than behind it (see LookDevOptions.sunAzimuthDeg)
// — a key light behind the camera is the flattest light there is.
const SUN_AZIMUTH = 232;
const SUN_ELEVATION = 40;
const SUN_DISTANCE = 700;

export const HORIZON_COLOR = new Color("#e3cfae");
export const SUN_COLOR = new Color("#ffd9a0");
export const SKY_FILL = new Color("#8fb4dd");
export const GROUND_FILL = new Color("#6a5c4c");

export interface LookDev {
  group: Group;
  sun: DirectionalLight;
  /** Re-centre the shadow frustum on the player so shadows stay crisp. */
  focusShadow(x: number, y: number, z: number): void;
  dispose(): void;
}

export interface LookDevOptions {
  /** Tile radius in metres — drives fog density and shadow frustum size. */
  radiusMeters?: number;
  /**
   * Half-extent of the shadow frustum in metres (default 170). Keep it tight:
   * this is a ground-level game, and `focusShadow` follows the player, so
   * spending the map on 170 m of sharp shadow beats 500 m of mush.
   */
  shadowExtent?: number;
  shadowMapSize?: number;
  /**
   * Compass azimuth (deg, 0 = north) the key light comes FROM. Defaults to a
   * fixed south-west. The app overrides it per tile so the sun sits behind the
   * player's run — otherwise a street canyon that happens to run across the
   * default azimuth spends the whole ride in its own shadow.
   */
  sunAzimuthDeg?: number;
}

function sunDirection(azimuthDeg = SUN_AZIMUTH): Vector3 {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (SUN_ELEVATION * Math.PI) / 180;
  return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

export function createLookDev(scene: Scene, opts: LookDevOptions = {}): LookDev {
  const radius = opts.radiusMeters ?? 1000;
  const shadowExtent = opts.shadowExtent ?? 170;
  const mapSize = opts.shadowMapSize ?? 2048;

  // Fog tuned so the far edge of the tile sits at ~0.75 extinction: with
  // FogExp2, factor = 1 - exp(-(d*density)^2), so density ~= 1.18 / radius.
  // Roughly 0.5 extinction at 1.4x the tile radius: enough haze to read depth,
  // not so much that the neighbourhood turns into milk.
  scene.fog = new FogExp2(HORIZON_COLOR.getHex(), 0.8 / Math.max(260, radius * 1.6));

  const env = makeEnvironment(opts.sunAzimuthDeg ?? SUN_AZIMUTH, SUN_ELEVATION);
  if (env) {
    scene.environment = env;
    scene.background = env;
    // The sky is deliberately saturated so the background looks good; the IBL
    // contribution is dialled back separately so it does not flatten the key.
    // 0.4 was tuned from an orbit camera. At STREET level — which is where the
    // game actually is — that much uniform sky light drowns the key: turn the
    // sun off at 0.4 and the frame barely changes. 0.18 keeps the fill soft
    // while the lit and shaded sides of a street stay clearly different.
    scene.environmentIntensity = 0.13;
  } else {
    scene.background = HORIZON_COLOR.clone();
  }

  const group = new Group();
  group.name = "lookdev";

  const dir = sunDirection(opts.sunAzimuthDeg ?? SUN_AZIMUTH);
  const sun = new DirectionalLight(SUN_COLOR.getHex(), 4.1);
  sun.position.copy(dir).multiplyScalar(SUN_DISTANCE);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = SUN_DISTANCE * 2;
  sun.shadow.camera.left = -shadowExtent;
  sun.shadow.camera.right = shadowExtent;
  sun.shadow.camera.top = shadowExtent;
  sun.shadow.camera.bottom = -shadowExtent;
  // MUST be called after touching left/right/top/bottom/near/far.
  // LightShadow.updateMatrices reads shadow.camera.projectionMatrix as-is and
  // never rebuilds it, so without this the shadow camera keeps the constructor
  // default of DirectionalLightShadow — a 10 x 10 m ortho box with far = 500 —
  // while the light sits SUN_DISTANCE (700 m) away. Every caster then falls
  // beyond `far`, the shadow map renders empty, and the scene silently has no
  // cast shadows at all. Nothing errors; the frame just looks flat.
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  group.add(sun);
  group.add(sun.target);

  // Cool sky / warm ground hemisphere is what keeps shadowed facades from
  // going muddy without flattening them with a big ambient term.
  //
  // KEY-TO-FILL IS THE WHOLE LOOK. Cast shadows only read if the fill leaves
  // them somewhere to go: at 0.7 every shadow on the tarmac was lifted back to
  // within a few percent of the lit road and the frame went flat again even
  // with a correct shadow map. 0.4 against a key of 4.1 is roughly a 4:1 ratio
  // — late afternoon, not overcast.
  const hemi = new HemisphereLight(SKY_FILL.getHex(), GROUND_FILL.getHex(), 0.62);
  hemi.position.set(0, 200, 0);
  group.add(hemi);

  // A very low back-bounce so silhouettes never crush to black.
  const bounce = new DirectionalLight(0xd6e2f4, 0.11);
  bounce.position.set(-dir.x * 400, 120, -dir.z * 400);
  group.add(bounce);

  // No flat ambient term: it is the one light that cannot make a shadow.

  scene.add(group);

  const focusShadow = (x: number, y: number, z: number) => {
    sun.target.position.set(x, y, z);
    sun.target.updateMatrixWorld();
    sun.position.set(x + dir.x * SUN_DISTANCE, y + dir.y * SUN_DISTANCE, z + dir.z * SUN_DISTANCE);
    sun.updateMatrixWorld();
  };
  focusShadow(0, 0, 0);

  return {
    group,
    sun,
    focusShadow,
    dispose() {
      scene.remove(group);
      env?.dispose();
      scene.environment = null;
      scene.environmentIntensity = 1;
      scene.background = null;
      scene.fog = null;
    },
  };
}

/** Minimal renderer settings the look depends on. Safe on WebGPU and WebGL2. */
export function configureRenderer(renderer: {
  toneMapping: number;
  toneMappingExposure: number;
  shadowMap: { enabled: boolean; type: number };
}): void {
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.09;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
}
