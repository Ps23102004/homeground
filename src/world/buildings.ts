// ---------------------------------------------------------------------------
// Homeground — building extrusion.
//
// Real OSM footprints, real heights, but the goal is that they read as
// ARCHITECTURE rather than boxes. Four things do that work:
//   * the facade texture tiles once per storey and once per window bay, and the
//     bay count per wall is SNAPPED to whole bays so windows land on corners;
//   * the ground floor is a separate band with its own material (plinth, doors,
//     shopfront glazing) — buildings meet the pavement instead of stopping;
//   * roofs vary: small rectangular houses get a real hipped roof with eaves,
//     everything else gets a flat roof with a parapet (and a rooftop plant box
//     when it is big enough to have one);
//   * per-building colour/roof/bay-offset come from a hash of the building's
//     identity, so a given street looks identical on every reload.
//
// Everything lands in ONE merged geometry per material class (7 total), not
// one draw call per building.
// ---------------------------------------------------------------------------

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  ShapeUtils,
  Vector2,
  type Color,
} from "three";
import type { Building, LocalPoint } from "../types.js";
import type { TerrainSampler } from "./terrain.js";
import {
  BAY_WIDTH,
  FLOOR_HEIGHT,
  GROUND_ATLAS_BAYS,
  GROUND_FLOOR_HEIGHT,
  familyOf,
  hashSeed,
  rngFrom,
  roofColor,
  wallColor,
  type FacadeFamily,
  type WorldMaterials,
} from "./materials.js";

/** Axis-aligned-bounds + ring, used by the collision index. */
export interface BuildingCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Flat [x0,z0,x1,z1,...] ring, CCW, open (no repeated first point). */
  ring: Float32Array;
  baseY: number;
  topY: number;
  tag: Building["tag"];
}

// --- buffer accumulation ---------------------------------------------------

class Buf {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
    au: number, av: number, bu: number, bv: number, cu: number, cv: number,
    c: Color,
  ) {
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.uv.push(au, av, bu, bv, cu, cv);
    this.col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
  }

  /** Vertical wall quad for edge p0->p1 with outward normal (nx,nz). */
  wall(
    p0x: number, p0z: number, p1x: number, p1z: number,
    y0: number, y1: number, nx: number, nz: number,
    u0: number, u1: number, v0: number, v1: number, c: Color,
  ) {
    // winding verified for the Y-up / +Z-south convention: (p0b, p1t, p1b)
    this.tri(p0x, y0, p0z, p1x, y1, p1z, p1x, y0, p1z, nx, 0, nz, u0, v0, u1, v1, u1, v0, c);
    this.tri(p0x, y0, p0z, p0x, y1, p0z, p1x, y1, p1z, nx, 0, nz, u0, v0, u0, v1, u1, v1, c);
  }

  /** Triangle whose normal is derived and forced upward. */
  triUp(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    c: Color, scale = 0.05,
  ) {
    let e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    let e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    if (ny < 0) {
      // flip winding so the face points up
      [bx, cx] = [cx, bx];
      [by, cy] = [cy, by];
      [bz, cz] = [cz, bz];
      nx = -nx; ny = -ny; nz = -nz;
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    this.tri(
      ax, ay, az, bx, by, bz, cx, cy, cz,
      nx / l, ny / l, nz / l,
      ax * scale, az * scale, bx * scale, bz * scale, cx * scale, cz * scale,
      c,
    );
  }

  get triangles() {
    return this.pos.length / 9;
  }

  toGeometry(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// --- footprint helpers -----------------------------------------------------

function signedArea(ring: LocalPoint[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    a += p.x * q.z - q.x * p.z;
  }
  return a / 2;
}

/** Drop the closing duplicate + near-duplicate points, force positive area. */
function normalizeRing(fp: LocalPoint[]): LocalPoint[] | null {
  const out: LocalPoint[] = [];
  for (const p of fp) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) continue;
    out.push({ x: p.x, z: p.z });
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4) out.pop();
    else break;
  }
  if (out.length < 3) return null;
  if (signedArea(out) < 0) out.reverse();
  return signedArea(out) < 1.5 ? null : out;
}

interface Obb {
  cx: number;
  cz: number;
  angle: number;
  hw: number;
  hd: number;
  area: number;
}

/**
 * Minimum-area oriented bounding rectangle over the ring's own edge directions.
 * That is the exact answer for a convex polygon (the min-area rectangle always
 * shares an edge with the hull) and a good one for the near-rectangular
 * footprints this is used on. We only need it to answer "is this basically a
 * rectangular house" and to hang a hipped roof on it, so a hull + rotating
 * calipers would be precision nobody can see.
 *
 * Long rings are sampled: a 200-vertex church outline costs 200x200 otherwise,
 * and it will fail the rectness test regardless.
 */
function fitObb(ring: LocalPoint[]): Obb {
  const n = ring.length;
  const stride = n > 24 ? Math.ceil(n / 24) : 1;
  const angles: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    angles.push(Math.atan2(q.z - p.z, q.x - p.x));
  }

  let best: Obb | null = null;
  for (const a of angles) {
    const ca = Math.cos(-a);
    const sa = Math.sin(-a);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of ring) {
      const u = p.x * ca - p.z * sa;
      const v = p.x * sa + p.z * ca;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const mu = (minU + maxU) / 2;
      const mv = (minV + maxV) / 2;
      // rotate the centre back into world space
      best = {
        cx: mu * ca + mv * sa,
        cz: -mu * sa + mv * ca,
        angle: a,
        hw: (maxU - minU) / 2,
        hd: (maxV - minV) / 2,
        area,
      };
    }
  }
  const b = best!;
  if (b.hw < b.hd) {
    return { ...b, angle: b.angle + Math.PI / 2, hw: b.hd, hd: b.hw };
  }
  return b;
}

function levelsHeight(b: Building): number {
  if (b.height > 0.5) return b.height;
  const lv = Number(b.osmTags["building:levels"] ?? b.osmTags["levels"]);
  if (Number.isFinite(lv) && lv > 0) return lv * 3.1 + 1.0;
  return b.tag === "garage" ? 2.8 : b.tag === "industrial" ? 9 : 7.5;
}

/** Stable identity for seeding: OSM id if the backend kept one, else geometry. */
function buildingSeed(b: Building, ring: LocalPoint[]): number {
  const id = b.osmTags["@id"] ?? b.osmTags["id"] ?? b.osmTags["osmid"];
  if (id) return hashSeed(`b:${id}`);
  return hashSeed(`b:${ring[0].x.toFixed(2)},${ring[0].z.toFixed(2)},${ring.length}`);
}

// --- main ------------------------------------------------------------------

export interface BuildingsResult {
  meshes: Mesh[];
  colliders: BuildingCollider[];
  stats: { buildings: number; skipped: number; pitchedRoofs: number; triangles: number; drawCalls: number };
}

const FAMILIES: FacadeFamily[] = ["residential", "commercial", "industrial"];
const PARAPET_H = 0.55;
const PARAPET_INSET = 0.35;
const EAVE_OVERHANG = 0.45;
const FASCIA_H = 0.28;

export function buildBuildings(
  buildings: Building[],
  sampler: TerrainSampler,
  mats: WorldMaterials,
): BuildingsResult {
  const upper: Record<FacadeFamily, Buf> = {
    residential: new Buf(), commercial: new Buf(), industrial: new Buf(),
  };
  const ground: Record<FacadeFamily, Buf> = {
    residential: new Buf(), commercial: new Buf(), industrial: new Buf(),
  };
  const roofBuf = new Buf();
  const colliders: BuildingCollider[] = [];
  let skipped = 0;
  let pitchedRoofs = 0;

  for (const b of buildings) {
    const ring = normalizeRing(b.footprint);
    if (!ring) {
      skipped++;
      continue;
    }
    const family = familyOf(b.tag);
    const rnd = rngFrom(buildingSeed(b, ring));
    const wallC = wallColor(family, rnd);

    // --- ground fit -------------------------------------------------------
    let minH = Infinity, maxH = -Infinity, cx = 0, cz = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
      const h = sampler.sampleHeight(p.x, p.z);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      cx += p.x; cz += p.z;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    cx /= ring.length;
    cz /= ring.length;

    const height = levelsHeight(b);
    const baseY = minH - 0.4;              // sink slightly so it never floats
    const topY = maxH + height;            // top clears the highest corner
    const area = Math.abs(signedArea(ring));

    // --- roof style -------------------------------------------------------
    // Only fit an OBB when a pitched roof is even on the table; for a downtown
    // block the fit is pure waste and it is the most expensive step per building.
    const couldPitch = family === "residential" && area < 700 && height < 16;
    const obb = couldPitch || area > 500 ? fitObb(ring) : null;
    const pitched =
      couldPitch && obb !== null && area / Math.max(1e-3, obb.area) > 0.82 && obb.hd > 2.0;

    const ridgeH = pitched ? Math.min(obb!.hd * 0.85, 4.6) : 0;
    const wallTop = pitched ? Math.max(baseY + 2.6, topY - ridgeH * 0.6) : topY;
    if (pitched) pitchedRoofs++;

    // --- facade bands -----------------------------------------------------
    const gfH = GROUND_FLOOR_HEIGHT[family];
    const total = wallTop - baseY;
    const hasUpper = total > gfH * 1.25;
    const groundTop = hasUpper ? baseY + gfH : wallTop;
    const bay = BAY_WIDTH[family];
    const floorH = FLOOR_HEIGHT[family];
    const floors = hasUpper ? Math.max(1, Math.round((wallTop - groundTop) / floorH)) : 0;
    const uG = ground[family];
    const uU = upper[family];
    // integer bay offset -> entrances/doors are not aligned across the street
    let uAcc = Math.floor(rnd() * GROUND_ATLAS_BAYS);

    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      // outward normal for a positive-area ring in (x, z)
      const nx = dz / len;
      const nz = -dx / len;
      const bays = Math.max(1, Math.round(len / bay)); // snap so windows hit corners
      const u0 = uAcc;
      const u1 = uAcc + bays;
      uAcc = u1;

      uG.wall(
        p.x, p.z, q.x, q.z, baseY, groundTop, nx, nz,
        u0 / GROUND_ATLAS_BAYS, u1 / GROUND_ATLAS_BAYS, 0, 1, wallC,
      );
      if (hasUpper) {
        uU.wall(p.x, p.z, q.x, q.z, groundTop, wallTop, nx, nz, u0, u1, 0, floors, wallC);
      }
    }

    // --- roof -------------------------------------------------------------
    const roofC = roofColor(pitched, family, rnd);
    if (pitched) {
      emitHippedRoof(roofBuf, obb!, wallTop, wallTop + ridgeH, roofC);
    } else {
      emitFlatRoof(roofBuf, ring, topY, roofC);
      if (area > 500 && obb) {
        const s = Math.min(obb.hd * 0.35, 5);
        emitBox(roofBuf, cx, cz, s, s, topY + PARAPET_H * 0.2, topY + 1.9 + rnd() * 0.8, roofC);
      }
    }

    const flat = new Float32Array(ring.length * 2);
    for (let i = 0; i < ring.length; i++) {
      flat[i * 2] = ring[i].x;
      flat[i * 2 + 1] = ring[i].z;
    }
    colliders.push({ minX, maxX, minZ, maxZ, ring: flat, baseY, topY: pitched ? wallTop + ridgeH : topY, tag: b.tag });
  }

  // --- assemble one mesh per material class -------------------------------
  const meshes: Mesh[] = [];
  let triangles = 0;
  const add = (buf: Buf, mat: WorldMaterials["roof"], name: string) => {
    const g = buf.toGeometry();
    if (!g) return;
    const m = new Mesh(g, mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    meshes.push(m);
    triangles += buf.triangles;
  };
  for (const f of FAMILIES) {
    add(ground[f], mats.facadeGround[f], `buildings-ground-${f}`);
    add(upper[f], mats.facadeUpper[f], `buildings-upper-${f}`);
  }
  add(roofBuf, mats.roof, "buildings-roof");

  return {
    meshes,
    colliders,
    stats: { buildings: colliders.length, skipped, pitchedRoofs, triangles, drawCalls: meshes.length },
  };
}

// --- roof emitters ---------------------------------------------------------

function emitFlatRoof(buf: Buf, ring: LocalPoint[], topY: number, c: Color) {
  const contour = ring.map((p) => new Vector2(p.x, p.z));
  let faces: number[][];
  try {
    faces = ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  const capY = topY;
  for (const f of faces) {
    const a = contour[f[0]], b = contour[f[1]], d = contour[f[2]];
    buf.triUp(a.x, capY, a.y, b.x, capY, b.y, d.x, capY, d.y, c);
  }
  // parapet: outer band + a top ring so the roof reads as recessed
  const top = topY + PARAPET_H;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    const dx = q.x - p.x, dz = q.z - p.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const nx = dz / len, nz = -dx / len;
    buf.wall(p.x, p.z, q.x, q.z, topY, top, nx, nz, 0, len * 0.1, 0, PARAPET_H * 0.1, c);
    const ipx = p.x - nx * PARAPET_INSET, ipz = p.z - nz * PARAPET_INSET;
    const iqx = q.x - nx * PARAPET_INSET, iqz = q.z - nz * PARAPET_INSET;
    buf.triUp(p.x, top, p.z, q.x, top, q.z, iqx, top, iqz, c);
    buf.triUp(p.x, top, p.z, iqx, top, iqz, ipx, top, ipz, c);
  }
}

function emitHippedRoof(buf: Buf, obb: Obb, eaveY: number, ridgeY: number, c: Color) {
  const ca = Math.cos(obb.angle);
  const sa = Math.sin(obb.angle);
  const hw = obb.hw + EAVE_OVERHANG;
  const hd = obb.hd + EAVE_OVERHANG;
  const P = (u: number, v: number, y: number): [number, number, number] => [
    obb.cx + u * ca - v * sa,
    y,
    obb.cz + u * sa + v * ca,
  ];
  const A = P(-hw, -hd, eaveY);
  const B = P(hw, -hd, eaveY);
  const C = P(hw, hd, eaveY);
  const D = P(-hw, hd, eaveY);
  const ridgeHalf = Math.max(0, hw - hd);
  const R0 = P(-ridgeHalf, 0, ridgeY);
  const R1 = P(ridgeHalf, 0, ridgeY);

  const t = (a: number[], b: number[], d: number[]) =>
    buf.triUp(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2], c, 0.25);
  t(A, B, R1);
  t(A, R1, R0);
  t(C, D, R0);
  t(C, R0, R1);
  t(D, A, R0);
  t(B, C, R1);

  // fascia: thin vertical band under the eave, closes the silhouette
  const corners = [A, B, C, D];
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    const dx = q[0] - p[0], dz = q[2] - p[2];
    const len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    buf.wall(p[0], p[2], q[0], q[2], eaveY - FASCIA_H, eaveY, dz / len, -dx / len, 0, len * 0.2, 0, 1, c);
  }
}

/** Axis-aligned box (rooftop plant). Sides + top only. */
function emitBox(buf: Buf, cx: number, cz: number, hx: number, hz: number, y0: number, y1: number, c: Color) {
  const pts: [number, number][] = [
    [cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz],
  ];
  for (let i = 0; i < 4; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % 4];
    const dx = q[0] - p[0], dz = q[1] - p[1];
    const len = Math.hypot(dx, dz) || 1;
    buf.wall(p[0], p[1], q[0], q[1], y0, y1, dz / len, -dx / len, 0, len * 0.2, 0, (y1 - y0) * 0.2, c);
  }
  buf.triUp(pts[0][0], y1, pts[0][1], pts[1][0], y1, pts[1][1], pts[2][0], y1, pts[2][1], c, 0.2);
  buf.triUp(pts[0][0], y1, pts[0][1], pts[2][0], y1, pts[2][1], pts[3][0], y1, pts[3][1], c, 0.2);
}
