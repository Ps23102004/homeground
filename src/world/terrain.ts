// ---------------------------------------------------------------------------
// Homeground — terrain sampling + mesh.
//
// The elevation source (SRTM-class) is coarse: 30-60 m postings. Rendering that
// grid directly gives visible faceting, so the sampler resamples it once, at
// build time, onto a fine grid using a clamped Catmull-Rom bicubic (smooth, and
// clamped per 1-D pass so a cliff cannot ring/overshoot).
//
// THE IMPORTANT PART: `sampleHeight` is bilinear over that SAME fine grid the
// mesh is built from — not the bicubic. So the height gameplay stands on is
// EXACTLY the height that is drawn, to the last float. Sampling the analytic
// bicubic instead (the obvious thing to do) leaves the piecewise-linear mesh
// several centimetres above it on curvature, which is enough to swallow the
// road ribbons and make the player sink into hillsides.
//
// Normals are the one deliberate exception: they come from the smooth source
// bicubic rather than the faceted grid, because a board wants a continuous
// surface orientation and the mesh is smooth-shaded anyway.
// ---------------------------------------------------------------------------

import { BufferAttribute, BufferGeometry, Color, Mesh, type Material } from "three";
import type { Heightfield } from "../types.js";

/** The resampled grid the mesh is built from and `sampleHeight` reads. */
export interface TerrainGrid {
  nx: number;
  nz: number;
  stepX: number;
  stepZ: number;
  minX: number;
  minZ: number;
  heights: Float32Array;
}

export interface TerrainSampler {
  /** Ground elevation in metres at local-metres (x, z). Clamps outside the tile. */
  sampleHeight(x: number, z: number): number;
  /** Unit up-normal of the ground at (x, z). Smooth (from the source bicubic). */
  sampleNormal(
    x: number, z: number,
    out?: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number };
  /** Downhill slope magnitude (rise/run) and unit direction at (x, z). */
  sampleSlope(x: number, z: number): { gradient: number; dirX: number; dirZ: number };
  /** Playable bounds in local metres (includes the margin ring). */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly grid: TerrainGrid;
  readonly field: Heightfield;
}

/** Catmull-Rom, clamped to the interior tap range to kill overshoot. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const v =
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  const lo = Math.min(p1, p2);
  const hi = Math.max(p1, p2);
  return v < lo ? lo : v > hi ? hi : v;
}

export interface TerrainSamplerOptions {
  /** Target metres between grid samples (default 6). Grid is clamped to 64..384. */
  targetVertexSpacing?: number;
  /**
   * Extra ground built beyond the heightfield, in metres. OSM ways routinely
   * run past the tile box; without this they overhang into space at the border.
   * The margin is flat at the edge elevation (the source sampler clamps).
   */
  margin?: number;
}

export function createTerrainSampler(
  field: Heightfield,
  opts: TerrainSamplerOptions = {},
): TerrainSampler {
  const { width, depth, spacing, originX, originZ } = field;
  const e = field.elevations;
  const at = (col: number, row: number): number => {
    const c = col < 0 ? 0 : col >= width ? width - 1 : col;
    const r = row < 0 ? 0 : row >= depth ? depth - 1 : row;
    return e[r * width + c];
  };

  /** Smooth analytic height from the source postings. Used for normals only. */
  function sourceHeight(x: number, z: number): number {
    const fx = (x - originX) / spacing;
    const fz = (z - originZ) / spacing;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const tx = fx - cx;
    const tz = fz - cz;
    const r0 = cr(at(cx - 1, cz - 1), at(cx, cz - 1), at(cx + 1, cz - 1), at(cx + 2, cz - 1), tx);
    const r1 = cr(at(cx - 1, cz + 0), at(cx, cz + 0), at(cx + 1, cz + 0), at(cx + 2, cz + 0), tx);
    const r2 = cr(at(cx - 1, cz + 1), at(cx, cz + 1), at(cx + 1, cz + 1), at(cx + 2, cz + 1), tx);
    const r3 = cr(at(cx - 1, cz + 2), at(cx, cz + 2), at(cx + 1, cz + 2), at(cx + 2, cz + 2), tx);
    return cr(r0, r1, r2, r3, tz);
  }

  // --- resample once onto the render grid ---------------------------------
  const target = opts.targetVertexSpacing ?? 6;
  const margin = opts.margin ?? 170;
  const srcMinX = originX;
  const srcMinZ = originZ;
  const spanX = (width - 1) * spacing + margin * 2;
  const spanZ = (depth - 1) * spacing + margin * 2;
  const nx = Math.min(384, Math.max(64, Math.round(spanX / target))) + 1;
  const nz = Math.min(384, Math.max(64, Math.round(spanZ / target))) + 1;
  const stepX = spanX / (nx - 1);
  const stepZ = spanZ / (nz - 1);
  const minX = srcMinX - margin;
  const minZ = srcMinZ - margin;

  const heights = new Float32Array(nx * nz);
  for (let r = 0; r < nz; r++) {
    const z = minZ + r * stepZ;
    for (let c = 0; c < nx; c++) {
      heights[r * nx + c] = sourceHeight(minX + c * stepX, z);
    }
  }

  const grid: TerrainGrid = { nx, nz, stepX, stepZ, minX, minZ, heights };
  const bounds = {
    minX,
    maxX: minX + spanX,
    minZ,
    maxZ: minZ + spanZ,
  };

  /** Bilinear over the render grid — matches the drawn mesh exactly. */
  function sampleHeight(x: number, z: number): number {
    let fx = (x - minX) / stepX;
    let fz = (z - minZ) / stepZ;
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
    fz = fz < 0 ? 0 : fz > nz - 1 ? nz - 1 : fz;
    const c = Math.min(nx - 2, Math.floor(fx));
    const r = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - c;
    const tz = fz - r;
    const i = r * nx + c;
    const h00 = heights[i];
    const h10 = heights[i + 1];
    const h01 = heights[i + nx];
    const h11 = heights[i + nx + 1];
    return (h00 + (h10 - h00) * tx) * (1 - tz) + (h01 + (h11 - h01) * tx) * tz;
  }

  const D = 3.0;
  function sampleNormal(x: number, z: number, out = { x: 0, y: 1, z: 0 }) {
    const dhdx = (sourceHeight(x + D, z) - sourceHeight(x - D, z)) / (2 * D);
    const dhdz = (sourceHeight(x, z + D) - sourceHeight(x, z - D)) / (2 * D);
    const inv = 1 / Math.hypot(dhdx, 1, dhdz);
    out.x = -dhdx * inv;
    out.y = inv;
    out.z = -dhdz * inv;
    return out;
  }

  function sampleSlope(x: number, z: number) {
    const dhdx = (sourceHeight(x + D, z) - sourceHeight(x - D, z)) / (2 * D);
    const dhdz = (sourceHeight(x, z + D) - sourceHeight(x, z - D)) / (2 * D);
    const g = Math.hypot(dhdx, dhdz);
    return g < 1e-6
      ? { gradient: 0, dirX: 0, dirZ: 0 }
      : { gradient: g, dirX: -dhdx / g, dirZ: -dhdz / g };
  }

  return { sampleHeight, sampleNormal, sampleSlope, bounds, grid, field };
}

// --- ground colouring ------------------------------------------------------
// Slope + a slow value-noise drive a two-tone warm palette. Flat = soft sage,
// steep = dry sand. Nothing saturated; the sun does the work.

const GRASS = new Color("#6f7360");
const GRASS_ALT = new Color("#8d8b71");
const SAND = new Color("#b6a88d");
const _tmp = new Color();

function vnoise(x: number, z: number): number {
  const h = (a: number, b: number) => {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const f = (fx: number, fz: number) => {
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const u = fx - ix;
    const v = fz - iz;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const a = h(ix, iz);
    const b = h(ix + 1, iz);
    const c = h(ix, iz + 1);
    const d = h(ix + 1, iz + 1);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  // Three octaves, not two. The mesh is ~6 m/vertex, so a 16 m octave is the
  // finest that will not alias — and without it the two coarse octaves left
  // every lawn and verge a single flat wash of colour across tens of metres,
  // which is the thing that reads as "untextured 3D" more than anything else
  // in the frame.
  return f(x / 140, z / 140) * 0.55 + f(x / 41, z / 41) * 0.31 + f(x / 16, z / 16) * 0.14;
}

export interface TerrainMeshResult {
  mesh: Mesh;
  triangles: number;
  vertices: number;
}

export interface TerrainMeshOptions {
  /** Downward skirt depth at the tile border so you never see under the world. */
  skirt?: number;
}

export function buildTerrainMesh(
  sampler: TerrainSampler,
  material: Material,
  opts: TerrainMeshOptions = {},
): TerrainMeshResult {
  const { nx, nz, stepX, stepZ, minX, minZ, heights } = sampler.grid;
  const skirt = opts.skirt ?? 40;

  const vcount = nx * nz;
  const skirtVerts = skirt > 0 ? 2 * nx + 2 * nz : 0;
  const pos = new Float32Array((vcount + skirtVerts) * 3);
  const col = new Float32Array((vcount + skirtVerts) * 3);
  const uv = new Float32Array((vcount + skirtVerts) * 2);

  for (let r = 0; r < nz; r++) {
    const z = minZ + r * stepZ;
    for (let c = 0; c < nx; c++) {
      const x = minX + c * stepX;
      const i = r * nx + c;
      pos[i * 3] = x;
      pos[i * 3 + 1] = heights[i];
      pos[i * 3 + 2] = z;
      uv[i * 2] = c / (nx - 1);
      uv[i * 2 + 1] = r / (nz - 1);

      // Slope straight off the grid we just built — central differences here
      // are exact for the surface being drawn AND ~50x cheaper than calling the
      // analytic sampleSlope 148k times (that alone was half the build cost).
      const cm = c > 0 ? i - 1 : i;
      const cp = c < nx - 1 ? i + 1 : i;
      const rm = r > 0 ? i - nx : i;
      const rp = r < nz - 1 ? i + nx : i;
      const dhdx = (heights[cp] - heights[cm]) / ((cp - cm) * stepX || stepX);
      const dhdz = (heights[rp] - heights[rm]) / (((rp - rm) / nx) * stepZ || stepZ);
      const gradient = Math.hypot(dhdx, dhdz);
      const n = vnoise(x, z);
      const steep = Math.min(1, Math.max(0, (gradient - 0.16) / 0.34));
      _tmp.copy(GRASS).lerp(GRASS_ALT, n);
      _tmp.lerp(SAND, steep * 0.85);
      const shade = 0.94 + n * 0.12;
      col[i * 3] = _tmp.r * shade;
      col[i * 3 + 1] = _tmp.g * shade;
      col[i * 3 + 2] = _tmp.b * shade;
    }
  }

  const quads = (nx - 1) * (nz - 1);
  const skirtQuads = skirt > 0 ? 2 * (nx - 1) + 2 * (nz - 1) : 0;
  const idx = new Uint32Array((quads + skirtQuads) * 6);
  let k = 0;
  for (let r = 0; r < nz - 1; r++) {
    for (let c = 0; c < nx - 1; c++) {
      const a = r * nx + c;
      const b = a + 1;
      const d = a + nx;
      const e2 = d + 1;
      // +Y facing: verified against the Y-up / +Z-south convention
      idx[k++] = a; idx[k++] = d; idx[k++] = b;
      idx[k++] = b; idx[k++] = d; idx[k++] = e2;
    }
  }

  let sv = vcount;
  if (skirt > 0) {
    const skirtIndexOf = new Map<number, number>();
    const addSkirt = (top: number) => {
      const existing = skirtIndexOf.get(top);
      if (existing !== undefined) return existing;
      pos[sv * 3] = pos[top * 3];
      pos[sv * 3 + 1] = pos[top * 3 + 1] - skirt;
      pos[sv * 3 + 2] = pos[top * 3 + 2];
      col[sv * 3] = col[top * 3] * 0.5;
      col[sv * 3 + 1] = col[top * 3 + 1] * 0.5;
      col[sv * 3 + 2] = col[top * 3 + 2] * 0.5;
      uv[sv * 2] = uv[top * 2];
      uv[sv * 2 + 1] = uv[top * 2 + 1];
      skirtIndexOf.set(top, sv);
      return sv++;
    };
    const edge = (i0: number, i1: number, flip: boolean) => {
      const s0 = addSkirt(i0);
      const s1 = addSkirt(i1);
      if (flip) {
        idx[k++] = i0; idx[k++] = s1; idx[k++] = s0;
        idx[k++] = i0; idx[k++] = i1; idx[k++] = s1;
      } else {
        idx[k++] = i0; idx[k++] = s0; idx[k++] = s1;
        idx[k++] = i0; idx[k++] = s1; idx[k++] = i1;
      }
    };
    for (let c = 0; c < nx - 1; c++) edge(c, c + 1, true);
    for (let c = 0; c < nx - 1; c++) edge((nz - 1) * nx + c, (nz - 1) * nx + c + 1, false);
    for (let r = 0; r < nz - 1; r++) edge(r * nx, (r + 1) * nx, false);
    for (let r = 0; r < nz - 1; r++) edge(r * nx + nx - 1, (r + 1) * nx + nx - 1, true);
  }

  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(pos.subarray(0, sv * 3), 3));
  geom.setAttribute("color", new BufferAttribute(col.subarray(0, sv * 3), 3));
  geom.setAttribute("uv", new BufferAttribute(uv.subarray(0, sv * 2), 2));
  geom.setIndex(new BufferAttribute(idx.subarray(0, k), 1));
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  geom.computeBoundingBox();

  const mesh = new Mesh(geom, material);
  mesh.name = "terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return { mesh, triangles: k / 3, vertices: sv };
}
