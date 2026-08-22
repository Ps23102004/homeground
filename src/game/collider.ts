// ============================================================================
// Collision built directly from the TilePayload.
//
// Why not consume src/world/'s meshes: physics wants the source geometry
// (heightfield samples, footprint rings), not triangles. Both this and the
// renderer read the same normalized payload, so they cannot drift.
//
// `Collider` below is the ONLY seam gameplay needs. If src/world/ later ships
// its own collision service, it just has to satisfy this interface and the
// integrator takes it unchanged.
// ============================================================================

import type { TilePayload } from "../types.js";

export interface Surface {
  /** Terrain elevation in local meters at the sampled point. */
  y: number;
  /** Unit up-normal of the terrain. */
  nx: number;
  ny: number;
  nz: number;
  /** True when the point sits on a road ribbon (better grip, less friction). */
  onRoad: boolean;
}

export interface WallHit {
  /** Corrected position. */
  x: number;
  z: number;
  /** Unit horizontal normal pointing AWAY from the wall, toward the rider. */
  nx: number;
  nz: number;
}

export interface Collider {
  heightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number, out: Surface): Surface;
  /** Resolve a circle of `radius` at (x, z) standing at height `y` against
   *  building walls. Returns true and fills `out` when it had to push. */
  pushOut(x: number, z: number, y: number, radius: number, out: WallHit): boolean;
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Wall: vertical span. Road: half width in `y0`, y1 unused. */
  y0: number;
  y1: number;
}

const CELL = 16; // m. Bucket size for the segment grid.

/** Uniform-grid segment index. Not a quadtree — the tile is ~1km and flat-ish,
 *  so a hash grid is fewer lines and faster in practice.
 *  ponytail: O(cells) insert per segment; fine at 1km, revisit at city scale. */
class SegGrid {
  segs: Seg[] = [];
  private cells = new Map<number, number[]>();
  private stamp: Int32Array = new Int32Array(0);
  private tick = 0;

  /** `pad` inflates the indexed box — roads must be found from anywhere inside
   *  their width, not just near the centerline. */
  add(s: Seg, pad = 0): void {
    const i = this.segs.length;
    this.segs.push(s);
    const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) / CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + pad) / CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - pad) / CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + pad) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = cx * 100003 + cz;
        const bucket = this.cells.get(k);
        if (bucket) bucket.push(i);
        else this.cells.set(k, [i]);
      }
    }
  }

  seal(): void {
    this.stamp = new Int32Array(this.segs.length);
  }

  /** Unique segment indices whose cells overlap the query box. */
  query(x: number, z: number, r: number, out: number[]): number[] {
    out.length = 0;
    this.tick++;
    const x0 = Math.floor((x - r) / CELL);
    const x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL);
    const z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(cx * 100003 + cz);
        if (!bucket) continue;
        for (const i of bucket) {
          if (this.stamp[i] === this.tick) continue;
          this.stamp[i] = this.tick;
          out.push(i);
        }
      }
    }
    return out;
  }
}

/** Parameter of the closest point on segment ab to point p, clamped to [0,1]. */
function closestT(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  if (l2 < 1e-9) return 0;
  const t = ((px - ax) * dx + (pz - az) * dz) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export class WorldCollider implements Collider {
  private w: number;
  private d: number;
  private spacing: number;
  private ox: number;
  private oz: number;
  private elev: Float32Array;
  private walls = new SegGrid();
  private roads = new SegGrid();
  private scratch: number[] = [];

  constructor(tile: TilePayload) {
    const t = tile.terrain;
    this.w = t.width;
    this.d = t.depth;
    this.spacing = t.spacing;
    this.ox = t.originX;
    this.oz = t.originZ;
    this.elev = Float32Array.from(t.elevations);
    if (this.elev.length < this.w * this.d) {
      throw new Error(
        `heightfield too small: got ${this.elev.length}, need ${this.w * this.d}`,
      );
    }

    for (const b of tile.buildings) {
      const ring = b.footprint;
      if (ring.length < 3) continue;
      // Base at terrain under the centroid, matching the renderer's contract.
      let cx = 0;
      let cz = 0;
      for (const p of ring) {
        cx += p.x;
        cz += p.z;
      }
      cx /= ring.length;
      cz /= ring.length;
      const base = this.heightAt(cx, cz);
      const top = base + Math.max(1, b.height);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const c = ring[(i + 1) % ring.length]!;
        if (a.x === c.x && a.z === c.z) continue;
        this.walls.add({ ax: a.x, az: a.z, bx: c.x, bz: c.z, y0: base, y1: top });
      }
    }
    this.walls.seal();

    for (const r of tile.roads) {
      const half = Math.max(1.5, r.widthMeters * 0.5);
      for (let i = 0; i + 1 < r.centerline.length; i++) {
        const a = r.centerline[i]!;
        const c = r.centerline[i + 1]!;
        this.roads.add({ ax: a.x, az: a.z, bx: c.x, bz: c.z, y0: half, y1: 0 }, half);
      }
    }
    this.roads.seal();
  }

  /** Bilinear sample of the heightfield, clamped at the tile edge. */
  heightAt(x: number, z: number): number {
    const gx = (x - this.ox) / this.spacing;
    const gz = (z - this.oz) / this.spacing;
    const cx = gx < 0 ? 0 : gx > this.w - 1 ? this.w - 1 : gx;
    const cz = gz < 0 ? 0 : gz > this.d - 1 ? this.d - 1 : gz;
    const i0 = Math.min(Math.floor(cx), this.w - 2 < 0 ? 0 : this.w - 2);
    const j0 = Math.min(Math.floor(cz), this.d - 2 < 0 ? 0 : this.d - 2);
    const i1 = Math.min(i0 + 1, this.w - 1);
    const j1 = Math.min(j0 + 1, this.d - 1);
    const fx = cx - i0;
    const fz = cz - j0;
    const e = this.elev;
    const w = this.w;
    const h00 = e[j0 * w + i0]!;
    const h10 = e[j0 * w + i1]!;
    const h01 = e[j1 * w + i0]!;
    const h11 = e[j1 * w + i1]!;
    return (
      h00 * (1 - fx) * (1 - fz) +
      h10 * fx * (1 - fz) +
      h01 * (1 - fx) * fz +
      h11 * fx * fz
    );
  }

  surfaceAt(x: number, z: number, out: Surface): Surface {
    const s = this.spacing;
    out.y = this.heightAt(x, z);
    // Central differences. One sample spacing wide: matches what the renderer
    // draws, so the board doesn't fight sub-sample detail it can't see.
    const dhdx = (this.heightAt(x + s, z) - this.heightAt(x - s, z)) / (2 * s);
    const dhdz = (this.heightAt(x, z + s) - this.heightAt(x, z - s)) / (2 * s);
    const inv = 1 / Math.sqrt(dhdx * dhdx + 1 + dhdz * dhdz);
    out.nx = -dhdx * inv;
    out.ny = inv;
    out.nz = -dhdz * inv;
    out.onRoad = this.onRoad(x, z);
    return out;
  }

  onRoad(x: number, z: number): boolean {
    // Radius 0: the grid already padded each segment by its own half width.
    const ids = this.roads.query(x, z, 0, this.scratch);
    for (const i of ids) {
      const s = this.roads.segs[i]!;
      const t = closestT(x, z, s.ax, s.az, s.bx, s.bz);
      const px = s.ax + (s.bx - s.ax) * t;
      const pz = s.az + (s.bz - s.az) * t;
      const dx = x - px;
      const dz = z - pz;
      if (dx * dx + dz * dz <= s.y0 * s.y0) return true;
    }
    return false;
  }

  pushOut(x: number, z: number, y: number, radius: number, out: WallHit): boolean {
    let px = x;
    let pz = z;
    let hit = false;
    let nx = 0;
    let nz = 0;
    // Two passes so inside corners settle instead of ping-ponging.
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      const ids = this.walls.query(px, pz, radius + 1, this.scratch);
      for (const i of ids) {
        const s = this.walls.segs[i]!;
        // Roof-level flyover or a building whose base is far above us: ignore.
        if (y > s.y1 || y < s.y0 - 4) continue;
        const t = closestT(px, pz, s.ax, s.az, s.bx, s.bz);
        const qx = s.ax + (s.bx - s.ax) * t;
        const qz = s.az + (s.bz - s.az) * t;
        let dx = px - qx;
        let dz = pz - qz;
        let d = Math.sqrt(dx * dx + dz * dz);
        if (d >= radius) continue;
        if (d < 1e-6) {
          // Dead on the line — push along the segment's left normal.
          const ex = s.bx - s.ax;
          const ez = s.bz - s.az;
          const el = Math.hypot(ex, ez) || 1;
          dx = -ez / el;
          dz = ex / el;
          d = 1e-6;
        } else {
          dx /= d;
          dz /= d;
        }
        const push = radius - d;
        px += dx * push;
        pz += dz * push;
        nx += dx * push;
        nz += dz * push;
        hit = true;
        moved = true;
      }
      if (!moved) break;
    }
    if (!hit) return false;
    const nl = Math.hypot(nx, nz) || 1;
    out.x = px;
    out.z = pz;
    out.nx = nx / nl;
    out.nz = nz / nl;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Adapter for src/world's WorldCollision.
//
// Structurally typed on purpose: this module stays importable from Node with
// no three.js in the graph, so the physics harness runs headless. When a real
// World is available, prefer it — the board then rides exactly the geometry
// the renderer drew, instead of a second interpretation of the same payload.
// ---------------------------------------------------------------------------

export interface WorldLike {
  sampleHeight(x: number, z: number): number;
  sampleNormal(
    x: number,
    z: number,
    out?: { x: number; y: number; z: number },
  ): { x: number; y: number; z: number };
  collision: {
    resolveCircle(
      x: number,
      z: number,
      radius: number,
    ): { x: number; z: number; nx: number; nz: number; depth: number } | null;
    sampleRoad(
      x: number,
      z: number,
      maxDistance?: number,
    ): { onRoad: boolean } | null;
  };
}

export function isWorldLike(v: unknown): v is WorldLike {
  return typeof (v as WorldLike | null)?.sampleHeight === "function";
}

export function colliderFromWorld(w: WorldLike): Collider {
  const n = { x: 0, y: 1, z: 0 };
  return {
    heightAt: (x, z) => w.sampleHeight(x, z),
    surfaceAt(x, z, out) {
      out.y = w.sampleHeight(x, z);
      const nn = w.sampleNormal(x, z, n);
      out.nx = nn.x;
      out.ny = nn.y;
      out.nz = nn.z;
      out.onRoad = w.collision.sampleRoad(x, z, 30)?.onRoad ?? false;
      return out;
    },
    pushOut(x, z, _y, radius, out) {
      // resolveCircle only settles the deepest overlap per call, so iterate for
      // inside corners. `y` is unused: their collider is 2D, which is fine —
      // nothing in this game gets on top of a building.
      let px = x;
      let pz = z;
      let hit = false;
      for (let i = 0; i < 3; i++) {
        const h = w.collision.resolveCircle(px, pz, radius);
        if (!h) break;
        px = h.x;
        pz = h.z;
        out.nx = h.nx;
        out.nz = h.nz;
        hit = true;
      }
      if (!hit) return false;
      out.x = px;
      out.z = pz;
      return true;
    },
  };
}
