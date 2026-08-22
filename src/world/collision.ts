// ---------------------------------------------------------------------------
// Homeground — collision + road queries for the gameplay layer.
//
// Two uniform grids (buildings by AABB, road segments by cell) over the tile.
// Both are built once when the world is built and are read-only afterwards, so
// they are safe to hammer from the physics step at 120 Hz.
// ---------------------------------------------------------------------------

import type { RoadTag } from "../types.js";
import type { BuildingCollider } from "./buildings.js";
import type { RoadSegment } from "./roads.js";

const BUILDING_CELL = 24;
const ROAD_CELL = 24;

function keyOf(cx: number, cz: number): number {
  // 16-bit signed pack; tiles are ~2 km so cell indices stay well inside range
  return ((cx + 32768) << 16) | (cz + 32768);
}

export interface CircleHit {
  /** Corrected position (the circle centre, pushed just outside the wall). */
  x: number;
  z: number;
  /** Unit surface normal pointing away from the building. */
  nx: number;
  nz: number;
  /** How far the circle had penetrated, in metres. */
  depth: number;
  building: BuildingCollider;
}

export interface RoadHit {
  /** Distance from (x, z) to the road centreline, metres. */
  distance: number;
  /** True when the point is within the carriageway. */
  onRoad: boolean;
  /** Unit tangent of the nearest segment, in the direction the way was drawn. */
  tx: number;
  tz: number;
  halfWidth: number;
  tag: RoadTag;
}

export interface SlideResult {
  x: number;
  z: number;
  /** Unit normal, averaged over every wall that was resolved this step. */
  nx: number;
  nz: number;
  /** Largest single penetration resolved, metres. */
  depth: number;
  /** False if the circle is still overlapping after `iterations` passes. */
  settled: boolean;
}

export interface WorldCollision {
  /**
   * Resolve a circle (the player's footprint) against building walls, deepest
   * overlap first. Returns null when clear. `x`/`z` is the corrected centre and
   * `nx`/`nz` is the wall normal — use it to cancel the into-wall component of
   * velocity. This resolves ONE wall; at a corner, or between two buildings
   * that share a wall, a single call can leave the circle touching another.
   * Use `slideCircle` unless you specifically want the single deepest contact.
   */
  resolveCircle(x: number, z: number, radius: number): CircleHit | null;
  /**
   * What gameplay should call each physics step: resolve repeatedly until the
   * circle is clear or `iterations` runs out, accumulating the normals so a
   * corner produces a sensible combined normal to slide along.
   *
   *   const s = collision.slideCircle(px, pz, 0.55);
   *   if (s) { px = s.x; pz = s.z; killVelocityAlong(s.nx, s.nz); }
   *
   * `settled` is false when it ran out of iterations — that means the circle is
   * wedged (e.g. dropped inside a terraced block, where no clear spot exists).
   * Treat that as "do not spawn here", not as an error.
   */
  slideCircle(x: number, z: number, radius: number, iterations?: number): SlideResult | null;
  /** The building whose footprint contains (x, z), or null. */
  isInsideBuilding(x: number, z: number): BuildingCollider | null;
  /** Buildings whose bounding box overlaps the circle. Cheap broad phase. */
  queryBuildings(x: number, z: number, radius: number): BuildingCollider[];
  /** Nearest road within `maxDistance` (default 60 m), or null. */
  sampleRoad(x: number, z: number, maxDistance?: number): RoadHit | null;
  readonly buildingCount: number;
  readonly segmentCount: number;
}

/** Closest point on segment ab to p; returns squared distance + the point. */
function closestOnSeg(
  px: number, pz: number,
  ax: number, az: number, bx: number, bz: number,
  out: { x: number; z: number; t: number },
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  out.x = ax + dx * t;
  out.z = az + dz * t;
  out.t = t;
  const ex = px - out.x;
  const ez = pz - out.z;
  return ex * ex + ez * ez;
}

function pointInRing(ring: Float32Array, px: number, pz: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1];
    const xj = ring[j * 2], zj = ring[j * 2 + 1];
    if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function createCollision(
  buildings: BuildingCollider[],
  segments: RoadSegment[],
): WorldCollision {
  // --- building grid ------------------------------------------------------
  const bGrid = new Map<number, number[]>();
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    const c0 = Math.floor(b.minX / BUILDING_CELL);
    const c1 = Math.floor(b.maxX / BUILDING_CELL);
    const r0 = Math.floor(b.minZ / BUILDING_CELL);
    const r1 = Math.floor(b.maxZ / BUILDING_CELL);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const k = keyOf(c, r);
        const cell = bGrid.get(k);
        if (cell) cell.push(i);
        else bGrid.set(k, [i]);
      }
    }
  }

  // --- road grid ----------------------------------------------------------
  const rGrid = new Map<number, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const c0 = Math.floor(Math.min(s.x0, s.x1) / ROAD_CELL);
    const c1 = Math.floor(Math.max(s.x0, s.x1) / ROAD_CELL);
    const r0 = Math.floor(Math.min(s.z0, s.z1) / ROAD_CELL);
    const r1 = Math.floor(Math.max(s.z0, s.z1) / ROAD_CELL);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const k = keyOf(c, r);
        const cell = rGrid.get(k);
        if (cell) cell.push(i);
        else rGrid.set(k, [i]);
      }
    }
  }

  // Cell extents, so an absurd query radius costs O(occupied cells) rather than
  // O(radius^2) — gameplay is allowed to pass a silly number without hanging.
  const extentOf = (grid: Map<number, number[]>) => {
    let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
    for (const k of grid.keys()) {
      const c = (k >>> 16) - 32768;
      const r = (k & 0xffff) - 32768;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
    return { c0, c1, r0, r1 };
  };
  const bExtent = extentOf(bGrid);
  const rExtent = extentOf(rGrid);

  const scratch = { x: 0, z: 0, t: 0 };
  const seen = new Set<number>();

  function gather(
    grid: Map<number, number[]>, cell: number,
    x: number, z: number, radius: number, out: number[],
    ext: { c0: number; c1: number; r0: number; r1: number },
  ) {
    out.length = 0;
    seen.clear();
    if (grid.size === 0) return;
    const c0 = Math.max(ext.c0, Math.floor((x - radius) / cell));
    const c1 = Math.min(ext.c1, Math.floor((x + radius) / cell));
    const r0 = Math.max(ext.r0, Math.floor((z - radius) / cell));
    const r1 = Math.min(ext.r1, Math.floor((z + radius) / cell));
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const list = grid.get(keyOf(c, r));
        if (!list) continue;
        for (const i of list) {
          if (seen.has(i)) continue;
          seen.add(i);
          out.push(i);
        }
      }
    }
  }

  const idxScratch: number[] = [];

  function resolveCircle(x: number, z: number, radius: number): CircleHit | null {
    gather(bGrid, BUILDING_CELL, x, z, radius, idxScratch, bExtent);
    let best: CircleHit | null = null;

    for (const i of idxScratch) {
      const b = buildings[i];
      if (x + radius < b.minX || x - radius > b.maxX || z + radius < b.minZ || z - radius > b.maxZ) {
        continue;
      }
      const ring = b.ring;
      const n = ring.length / 2;
      let bestD2 = Infinity;
      let cxp = 0, czp = 0;
      for (let k = 0, j = n - 1; k < n; j = k++) {
        const d2 = closestOnSeg(x, z, ring[j * 2], ring[j * 2 + 1], ring[k * 2], ring[k * 2 + 1], scratch);
        if (d2 < bestD2) {
          bestD2 = d2;
          cxp = scratch.x;
          czp = scratch.z;
        }
      }
      const inside = pointInRing(ring, x, z);
      const d = Math.sqrt(bestD2);
      if (!inside && d >= radius) continue;

      // outward normal: away from the closest wall point (flipped when inside)
      let nx = x - cxp;
      let nz = z - czp;
      const l = Math.hypot(nx, nz);
      if (l < 1e-6) {
        nx = 1; nz = 0;
      } else {
        nx /= l; nz /= l;
      }
      if (inside) {
        nx = -nx; nz = -nz;
      }
      const depth = inside ? d + radius : radius - d;
      if (!best || depth > best.depth) {
        best = {
          x: cxp + nx * radius,
          z: czp + nz * radius,
          nx, nz, depth,
          building: b,
        };
      }
    }
    return best;
  }

  function queryBuildings(x: number, z: number, radius: number): BuildingCollider[] {
    gather(bGrid, BUILDING_CELL, x, z, radius, idxScratch, bExtent);
    const out: BuildingCollider[] = [];
    for (const i of idxScratch) {
      const b = buildings[i];
      if (x + radius < b.minX || x - radius > b.maxX || z + radius < b.minZ || z - radius > b.maxZ) {
        continue;
      }
      out.push(b);
    }
    return out;
  }

  function sampleRoad(x: number, z: number, maxDistance = 60): RoadHit | null {
    gather(rGrid, ROAD_CELL, x, z, maxDistance, idxScratch, rExtent);
    let bestD2 = maxDistance * maxDistance;
    let hit: RoadSegment | null = null;
    for (const i of idxScratch) {
      const s = segments[i];
      const d2 = closestOnSeg(x, z, s.x0, s.z0, s.x1, s.z1, scratch);
      if (d2 < bestD2) {
        bestD2 = d2;
        hit = s;
      }
    }
    if (!hit) return null;
    const distance = Math.sqrt(bestD2);
    return {
      distance,
      onRoad: distance <= hit.halfWidth,
      tx: hit.tx,
      tz: hit.tz,
      halfWidth: hit.halfWidth,
      tag: hit.tag,
    };
  }

  function slideCircle(x: number, z: number, radius: number, iterations = 4): SlideResult | null {
    let hit = resolveCircle(x, z, radius);
    if (!hit) return null;
    let nx = 0;
    let nz = 0;
    let depth = 0;
    let cx = x;
    let cz = z;
    let i = 0;
    for (; i < iterations && hit; i++) {
      cx = hit.x;
      cz = hit.z;
      nx += hit.nx;
      nz += hit.nz;
      if (hit.depth > depth) depth = hit.depth;
      hit = resolveCircle(cx, cz, radius);
    }
    const l = Math.hypot(nx, nz);
    if (l > 1e-6) {
      nx /= l;
      nz /= l;
    } else {
      nx = 1;
      nz = 0;
    }
    return { x: cx, z: cz, nx, nz, depth, settled: hit === null };
  }

  function isInsideBuilding(x: number, z: number): BuildingCollider | null {
    gather(bGrid, BUILDING_CELL, x, z, 0.001, idxScratch, bExtent);
    for (const i of idxScratch) {
      const b = buildings[i];
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (pointInRing(b.ring, x, z)) return b;
    }
    return null;
  }

  return {
    resolveCircle,
    slideCircle,
    isInsideBuilding,
    queryBuildings,
    sampleRoad,
    buildingCount: buildings.length,
    segmentCount: segments.length,
  };
}
