// ---------------------------------------------------------------------------
// Homeground — palette, deterministic seeding, and procedural facade textures.
//
// Everything here is generated at runtime from a <canvas>; there are no image
// assets to ship. When `document` is unavailable (node harness / SSR) the
// texture generators return null and the materials fall back to flat colour,
// so the whole geometry pipeline still runs headless.
// ---------------------------------------------------------------------------

import {
  CanvasTexture,
  Color,
  DoubleSide,
  EquirectangularReflectionMapping,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import type { BuildingTag } from "../types.js";

// --- deterministic randomness ---------------------------------------------

/** FNV-1a. Stable across reloads, platforms and JS engines. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — tiny, fast, good enough for look variation. */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- palette ---------------------------------------------------------------

export type FacadeFamily = "residential" | "commercial" | "industrial";

export function familyOf(tag: BuildingTag): FacadeFamily {
  switch (tag) {
    case "retail":
    case "commercial":
    case "civic":
    case "religious":
      return "commercial";
    case "industrial":
      return "industrial";
    default:
      return "residential";
  }
}

/**
 * Restrained warm palette. Deliberately narrow: warm off-whites, sand, bone,
 * taupe. No saturated hues anywhere — the colour interest comes from the low
 * sun and the shadows, not from the buildings.
 */
const WALL_COLORS: Record<FacadeFamily, string[]> = {
  residential: ["#e8dfd2", "#dcd1c0", "#d4c7b4", "#e2d7c7", "#cec1ae", "#ece4d8"],
  commercial: ["#e4e0d9", "#d7d3cb", "#cbc7bf", "#dfdbd3", "#d1cdc4"],
  industrial: ["#c6c0b7", "#bab4ab", "#cec9c1", "#c0b9af"],
};

const ROOF_COLORS = ["#8d8479", "#7c736a", "#968d84", "#847a70"];
/** Used sparingly (see PITCHED_WARM_ROOF_CHANCE) so it reads as accent, not noise. */
const ROOF_WARM = ["#a37a6c", "#9c7d68", "#8f6f62"];
const PITCHED_WARM_ROOF_CHANCE = 0.22;

export const GROUND_FLOOR_HEIGHT: Record<FacadeFamily, number> = {
  residential: 3.0,
  commercial: 4.2,
  industrial: 5.0,
};
export const FLOOR_HEIGHT: Record<FacadeFamily, number> = {
  residential: 2.95,
  commercial: 3.6,
  industrial: 5.0,
};
/** Horizontal window-bay pitch in metres — the facade texture tiles once per bay. */
export const BAY_WIDTH: Record<FacadeFamily, number> = {
  residential: 3.4,
  commercial: 3.2,
  industrial: 6.5,
};
/** The ground-floor texture is a 4-bay atlas so doors/entrances repeat every 4 bays. */
export const GROUND_ATLAS_BAYS = 4;

const _c = new Color();

/** Per-building wall colour: palette pick + a whisper of lightness/hue jitter. */
export function wallColor(family: FacadeFamily, rnd: () => number): Color {
  const list = WALL_COLORS[family];
  _c.set(list[Math.floor(rnd() * list.length)]);
  const hsl = { h: 0, s: 0, l: 0 };
  _c.getHSL(hsl);
  return new Color().setHSL(
    (hsl.h + (rnd() - 0.5) * 0.015 + 1) % 1,
    Math.max(0, hsl.s * (0.85 + rnd() * 0.3)),
    Math.min(0.97, hsl.l * (0.955 + rnd() * 0.09)),
  );
}

export function roofColor(pitched: boolean, family: FacadeFamily, rnd: () => number): Color {
  const warm = pitched && family === "residential" && rnd() < PITCHED_WARM_ROOF_CHANCE;
  const list = warm ? ROOF_WARM : ROOF_COLORS;
  _c.set(list[Math.floor(rnd() * list.length)]);
  const hsl = { h: 0, s: 0, l: 0 };
  _c.getHSL(hsl);
  return new Color().setHSL(hsl.h, hsl.s, Math.min(0.8, hsl.l * (0.9 + rnd() * 0.2)));
}

// --- canvas helpers --------------------------------------------------------

function canvas2d(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  return cv.getContext("2d");
}

function toTexture(ctx: CanvasRenderingContext2D, srgb: boolean, repeatX = 1, repeatY = 1): Texture {
  const t = new CanvasTexture(ctx.canvas);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  // Mipmaps stay at their defaults on purpose: without them the window grid
  // aliases into a shimmering moire the moment the camera moves.
  t.anisotropy = 16;
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Draw one window opening. `rough` mode paints the roughness channel instead.
 *
 * The thing that makes a window read as an OPENING rather than a black sticker
 * is the reveal: a hard dark band under the lintel and down one jamb (wall
 * thickness in shadow), a bright sill catching the sun below it, and a sky
 * gradient in the glass itself. Skip those and the building looks like a punch
 * card at any distance closer than a rooftop.
 */
function window_(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rough: boolean,
  mullions = 0,
) {
  if (rough) {
    g.fillStyle = "#2a2a2a"; // glass: smooth
    g.fillRect(x, y, w, h);
    g.fillStyle = "#f4f4f4"; // sill: chalky
    g.fillRect(x - 3, y + h, w + 6, 4);
    return;
  }

  const rev = Math.max(2, w * 0.045); // reveal depth in texels

  // Glass: sky at the top, room darkness at the bottom, one specular streak.
  // These values are deliberately much lighter than "what a window looks like
  // indoors", because a window seen from across a street is mostly a MIRROR of
  // the sky above it. Bottoming out near black turned every terrace into a
  // punch card at any distance past about 20 m, which is where the camera
  // spends the entire game.
  const grad = g.createLinearGradient(x, y, x + w * 0.35, y + h);
  grad.addColorStop(0.0, "#93a8bd");
  grad.addColorStop(0.3, "#6c7f93");
  grad.addColorStop(0.34, "#4d5a68");
  grad.addColorStop(0.62, "#39434e");
  grad.addColorStop(1.0, "#2b323a");
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  g.fillStyle = "rgba(255,255,255,0.16)";
  g.beginPath();
  g.moveTo(x + w * 0.55, y);
  g.lineTo(x + w, y);
  g.lineTo(x + w, y + h * 0.42);
  g.closePath();
  g.fill();

  // reveal: lintel + left jamb in shadow (sun is from the upper right)
  g.fillStyle = "rgba(0,0,0,0.42)";
  g.fillRect(x, y, w, rev);
  g.fillRect(x, y, rev, h);

  for (let i = 1; i <= mullions; i++) {
    const mx = x + (w * i) / (mullions + 1);
    g.fillStyle = "rgba(238,234,226,0.9)";
    g.fillRect(mx - 1.5, y, 3, h);
  }

  // frame, then the sill catching light and dropping a shadow onto the wall
  g.strokeStyle = "rgba(246,242,234,0.85)";
  g.lineWidth = 2.5;
  g.strokeRect(x + 1.2, y + 1.2, w - 2.4, h - 2.4);
  g.fillStyle = "rgba(255,252,246,0.95)";
  g.fillRect(x - 3, y + h, w + 6, 4);
  g.fillStyle = "rgba(0,0,0,0.20)";
  g.fillRect(x - 3, y + h + 4, w + 6, 4);
}

const S = 256; // one bay x one floor

/** Upper-floor facade: one bay wide, one storey tall, tiles in both axes. */
function upperFacade(family: FacadeFamily, rough: boolean): CanvasRenderingContext2D | null {
  const g = canvas2d(S, S);
  if (!g) return null;
  g.fillStyle = rough ? "#d9d9d9" : "#ffffff"; // white so vertexColor does the tinting
  g.fillRect(0, 0, S, S);

  if (!rough) {
    // floor line: this is what makes the building read as *storeys*
    g.fillStyle = "rgba(0,0,0,0.13)";
    g.fillRect(0, 0, S, 4);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.fillRect(0, 4, S, 2);
  }

  if (family === "residential") {
    window_(g, S * 0.29, S * 0.24, S * 0.42, S * 0.5, rough, 1);
  } else if (family === "commercial") {
    window_(g, S * 0.12, S * 0.2, S * 0.76, S * 0.58, rough, 2);
  } else {
    // industrial: mostly blank wall, one high strip window + a rib
    window_(g, S * 0.12, S * 0.16, S * 0.76, S * 0.22, rough, 3);
    if (!rough) {
      g.fillStyle = "rgba(0,0,0,0.07)";
      g.fillRect(0, S * 0.62, S, 5);
    }
  }
  return g;
}

/** Ground floor: 4-bay atlas so an entrance lands every 4th bay, not every bay. */
function groundFacade(family: FacadeFamily, rough: boolean): CanvasRenderingContext2D | null {
  const W = S * GROUND_ATLAS_BAYS;
  const g = canvas2d(W, S);
  if (!g) return null;
  g.fillStyle = rough ? "#dedede" : "#ffffff";
  g.fillRect(0, 0, W, S);

  for (let b = 0; b < GROUND_ATLAS_BAYS; b++) {
    const x0 = b * S;
    const isEntrance = b === 1;
    if (family === "residential") {
      if (isEntrance) {
        // door + small canopy shadow
        if (!rough) {
          g.fillStyle = "rgba(0,0,0,0.12)";
          g.fillRect(x0 + S * 0.3, S * 0.24, S * 0.4, S * 0.06);
        }
        window_(g, x0 + S * 0.34, S * 0.3, S * 0.32, S * 0.63, rough, 0);
      } else {
        window_(g, x0 + S * 0.29, S * 0.22, S * 0.42, S * 0.48, rough, 1);
      }
    } else if (family === "commercial") {
      // continuous shopfront glazing, entrance recessed on one bay
      const inset = isEntrance ? 0.1 : 0.06;
      window_(g, x0 + S * inset, S * 0.12, S * (1 - inset * 2), S * 0.72, rough, isEntrance ? 1 : 2);
      if (!rough && isEntrance) {
        g.fillStyle = "rgba(0,0,0,0.18)";
        g.fillRect(x0 + S * 0.06, S * 0.06, S * 0.88, S * 0.05); // fascia shadow
      }
    } else {
      if (isEntrance) window_(g, x0 + S * 0.2, S * 0.28, S * 0.6, S * 0.6, rough, 2);
      else if (!rough) {
        g.fillStyle = "rgba(0,0,0,0.05)";
        g.fillRect(x0, S * 0.3, S, 4);
      }
    }
    // plinth: a darker base band grounds the building against the pavement
    if (!rough) {
      g.fillStyle = "rgba(0,0,0,0.16)";
      g.fillRect(x0, S * 0.9, S, S * 0.1);
      g.fillStyle = "rgba(0,0,0,0.06)";
      g.fillRect(x0, S * 0.86, S, S * 0.04);
    } else {
      g.fillStyle = "#f0f0f0";
      g.fillRect(x0, S * 0.9, S, S * 0.1);
    }
  }
  return g;
}

/** Fine value noise, used as a roughness break-up on terrain / asphalt. */
function noiseTex(size: number, lo: number, hi: number): CanvasRenderingContext2D | null {
  const g = canvas2d(size, size);
  if (!g) return null;
  const img = g.createImageData(size, size);
  const rnd = rngFrom(0xa17e);
  for (let i = 0; i < size * size; i++) {
    const v = (lo + rnd() * (hi - lo)) * 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // one blur pass so it is grain, not TV static
  g.filter = "blur(1.2px)";
  g.drawImage(g.canvas, 0, 0);
  g.filter = "none";
  return g;
}

/**
 * Sky. Painted as an equirectangular canvas and used for BOTH `scene.background`
 * and the IBL, so the horizon you ride toward and the light on the facades come
 * from the same source and can never disagree.
 *
 * Two things make this read as sky instead of grey wash: the zenith is a real
 * blue (a 256 px gradient that starts at a desaturated slate just posterises to
 * mush by the time ACES is done with it), and the sun is painted in at its
 * actual azimuth/elevation with a wide falloff, so looking into the sun gives
 * you glare and looking away gives you a clean gradient.
 */
export function makeEnvironment(sunAzimuthDeg = 232, sunElevationDeg = 30): Texture | null {
  const W = 1024;
  const H = 512;
  const g = canvas2d(W, H);
  if (!g) return null;

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, "#2f6fb4"); // zenith
  grad.addColorStop(0.18, "#4d87c4");
  grad.addColorStop(0.34, "#84aed3");
  grad.addColorStop(0.44, "#bccfdc");
  grad.addColorStop(0.485, "#e8d9bd");
  grad.addColorStop(0.5, "#f6e3c0"); // horizon — matches the fog colour
  grad.addColorStop(0.53, "#b8a186");
  grad.addColorStop(0.66, "#7d7264");
  grad.addColorStop(1.0, "#4f4740"); // ground half (rarely seen; terrain covers it)
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // Sun. Equirect convention three samples with: u = atan2(z, x)/2pi + 0.5,
  // v = asin(y)/pi + 0.5, and CanvasTexture uploads flipped, so canvas row 0 is
  // v = 1 (zenith). Both match how the gradient above is laid out.
  const a = (sunAzimuthDeg * Math.PI) / 180;
  const e = (sunElevationDeg * Math.PI) / 180;
  const u = ((Math.atan2(-Math.cos(a), Math.sin(a)) / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
  const sx = u * W;
  const sy = (0.5 - e / Math.PI) * H;

  g.globalCompositeOperation = "lighter";
  for (const dx of [-W, 0, W]) {
    // wide warm haze, then the disc itself
    const halo = g.createRadialGradient(sx + dx, sy, 0, sx + dx, sy, W * 0.30);
    halo.addColorStop(0.0, "rgba(255,236,196,0.62)");
    halo.addColorStop(0.22, "rgba(255,224,172,0.22)");
    halo.addColorStop(0.6, "rgba(255,214,160,0.05)");
    halo.addColorStop(1.0, "rgba(255,214,160,0)");
    g.fillStyle = halo;
    g.fillRect(sx + dx - W * 0.3, sy - W * 0.3, W * 0.6, W * 0.6);

    const disc = g.createRadialGradient(sx + dx, sy, 0, sx + dx, sy, W * 0.035);
    disc.addColorStop(0.0, "rgba(255,252,240,1)");
    disc.addColorStop(0.45, "rgba(255,240,205,0.85)");
    disc.addColorStop(1.0, "rgba(255,230,180,0)");
    g.fillStyle = disc;
    g.fillRect(sx + dx - W * 0.04, sy - W * 0.04, W * 0.08, W * 0.08);
  }
  g.globalCompositeOperation = "source-over";

  const t = toTexture(g, true);
  t.mapping = EquirectangularReflectionMapping;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(1, 1);
  return t;
}

// --- material set ----------------------------------------------------------

export interface WorldMaterials {
  terrain: MeshStandardMaterial;
  road: MeshStandardMaterial;
  roadMarking: MeshStandardMaterial;
  sidewalk: MeshStandardMaterial;
  roof: MeshStandardMaterial;
  /** keyed by FacadeFamily */
  facadeUpper: Record<FacadeFamily, MeshStandardMaterial>;
  facadeGround: Record<FacadeFamily, MeshStandardMaterial>;
  dispose(): void;
}

const FAMILIES: FacadeFamily[] = ["residential", "commercial", "industrial"];

export function makeMaterials(): WorldMaterials {
  const textures: Texture[] = [];
  const keep = (t: Texture | null) => {
    if (t) textures.push(t);
    return t ?? undefined;
  };

  const grain = noiseTex(128, 0.55, 1.0);
  const terrainRough = grain ? keep(toTexture(grain, false, 90, 90)) : undefined;
  const roadRough = grain ? keep(toTexture(grain, false, 40, 400)) : undefined;

  const facadeUpper = {} as Record<FacadeFamily, MeshStandardMaterial>;
  const facadeGround = {} as Record<FacadeFamily, MeshStandardMaterial>;
  for (const f of FAMILIES) {
    const up = upperFacade(f, false);
    const upR = upperFacade(f, true);
    facadeUpper[f] = new MeshStandardMaterial({
      map: up ? (keep(toTexture(up, true)) as Texture) : null,
      roughnessMap: upR ? (keep(toTexture(upR, false)) as Texture) : null,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.55,
      name: `facade-upper-${f}`,
    });
    const gr = groundFacade(f, false);
    const grR = groundFacade(f, true);
    facadeGround[f] = new MeshStandardMaterial({
      map: gr ? (keep(toTexture(gr, true)) as Texture) : null,
      roughnessMap: grR ? (keep(toTexture(grR, false)) as Texture) : null,
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.0,
      envMapIntensity: 0.6,
      name: `facade-ground-${f}`,
    });
  }

  return {
    terrain: new MeshStandardMaterial({
      vertexColors: true,
      roughnessMap: terrainRough ?? null,
      roughness: 0.98,
      metalness: 0.0,
      envMapIntensity: 0.4,
      name: "terrain",
    }),
    road: new MeshStandardMaterial({
      color: 0x4f4c45,
      roughnessMap: roadRough ?? null,
      roughness: 0.94,
      metalness: 0.0,
      envMapIntensity: 0.3,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      name: "road",
    }),
    roadMarking: new MeshStandardMaterial({
      color: 0xe4dcc6,
      roughness: 0.85,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      name: "road-marking",
    }),
    sidewalk: new MeshStandardMaterial({
      color: 0x8f887d,
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
      envMapIntensity: 0.4,
      side: DoubleSide, // curb faces are single-quad; cheaper than closing them
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      name: "sidewalk",
    }),
    roof: new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.0,
      envMapIntensity: 0.5,
      name: "roof",
    }),
    facadeUpper,
    facadeGround,
    dispose() {
      for (const t of textures) t.dispose();
    },
  };
}
