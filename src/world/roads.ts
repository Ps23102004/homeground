// ---------------------------------------------------------------------------
// Homeground — road ribbons.
//
// OSM centrelines can have 100 m straight segments; on real terrain those float
// or sink, so every polyline is resampled to <= 8 m before it is offset. Each
// road produces up to four things, all merged into shared buffers:
//   road surface | curb faces + pavements | centre-line markings (major roads)
//
// The same resampled polylines feed a segment grid so gameplay can ask
// "where is the road and which way does it run" (see sampleRoad in index.ts).
// ---------------------------------------------------------------------------

import { BufferAttribute, BufferGeometry, Color, Mesh } from "three";
import type { LocalPoint, Road, RoadTag } from "../types.js";
import type { TerrainSampler } from "./terrain.js";
import type { WorldMaterials } from "./materials.js";

const MAX_SEG = 8;
const SURFACE_LIFT = 0.12;
const CURB_H = 0.13;
const PAVEMENT_W: Record<RoadTag, number> = {
  motorway: 0,
  primary: 2.0,
  secondary: 1.9,
  residential: 1.7,
  service: 1.2,
  footway: 0,
  other: 1.4,
};
const MARKED: RoadTag[] = ["motorway", "primary", "secondary"];

/** One road segment in the lookup grid. */
export interface RoadSegment {
  x0: number; z0: number; x1: number; z1: number;
  /** unit tangent */
  tx: number; tz: number;
  halfWidth: number;
  tag: RoadTag;
}

class RBuf {
  pos: number[] = [];
  nrm: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  useColor: boolean;
  constructor(useColor: boolean) {
    this.useColor = useColor;
  }
  tri(
    a: number[], b: number[], c: number[],
    nx: number, ny: number, nz: number,
    au: number, av: number, bu: number, bv: number, cu: number, cv: number,
    col?: Color,
  ) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.uv.push(au, av, bu, bv, cu, cv);
    if (this.useColor && col) {
      this.col.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
    }
  }
  get triangles() {
    return this.pos.length / 9;
  }
  toGeometry(): BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute("normal", new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute("uv", new BufferAttribute(new Float32Array(this.uv), 2));
    if (this.useColor) g.setAttribute("color", new BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Upward-facing strip between polyline A (the +normal side) and polyline B. */
function ribbon(
  buf: RBuf, A: number[][], B: number[][], vs: number[],
  col?: Color, skip?: boolean[],
) {
  for (let i = 0; i < A.length - 1; i++) {
    if (skip && (skip[i] || skip[i + 1])) continue;
    const a0 = A[i], b0 = B[i], a1 = A[i + 1], b1 = B[i + 1];
    const v0 = vs[i], v1 = vs[i + 1];
    // winding verified: (A_i, B_i, A_i+1) gives +Y
    buf.tri(a0, b0, a1, 0, 1, 0, 1, v0, 0, v0, 1, v1, col);
    buf.tri(b0, b1, a1, 0, 1, 0, 0, v0, 0, v1, 1, v1, col);
  }
}

function resample(pts: LocalPoint[]): LocalPoint[] {
  const out: LocalPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (out.length) {
      const last = out[out.length - 1];
      if (Math.hypot(p.x - last.x, p.z - last.z) < 0.25) continue;
    }
    out.push({ x: p.x, z: p.z });
  }
  if (out.length < 2) return out;
  const dense: LocalPoint[] = [out[0]];
  for (let i = 0; i < out.length - 1; i++) {
    const p = out[i];
    const q = out[i + 1];
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    const n = Math.max(1, Math.ceil(d / MAX_SEG));
    for (let k = 1; k <= n; k++) {
      dense.push({ x: p.x + ((q.x - p.x) * k) / n, z: p.z + ((q.z - p.z) * k) / n });
    }
  }
  return dense;
}

/** Per-vertex miter normals (perpendicular, +normal = (dz,-dx) side). */
function miters(pts: LocalPoint[]): { nx: number; nz: number }[] {
  const n = pts.length;
  const seg: { nx: number; nz: number }[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const l = Math.hypot(dx, dz) || 1;
    seg.push({ nx: dz / l, nz: -dx / l });
  }
  const out: { nx: number; nz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = seg[Math.max(0, i - 1)];
    const b = seg[Math.min(seg.length - 1, i)];
    let mx = a.nx + b.nx;
    let mz = a.nz + b.nz;
    const l = Math.hypot(mx, mz);
    if (l < 1e-4) {
      out.push({ nx: b.nx, nz: b.nz });
      continue;
    }
    mx /= l;
    mz /= l;
    // 1/cos(theta/2) so the offset width stays constant round the corner
    const scale = Math.min(2.4, 1 / Math.max(0.42, mx * b.nx + mz * b.nz));
    out.push({ nx: mx * scale, nz: mz * scale });
  }
  return out;
}

export interface RoadsResult {
  meshes: Mesh[];
  segments: RoadSegment[];
  stats: { roads: number; segments: number; triangles: number; drawCalls: number };
}

const PAVEMENT_COL = new Color("#a49c90");
const CURB_COL = new Color("#8d857a");

const JUNCTION_CELL = 24;

export function buildRoads(roads: Road[], sampler: TerrainSampler, mats: WorldMaterials): RoadsResult {
  const surf = new RBuf(false);
  const walk = new RBuf(true);
  const mark = new RBuf(false);
  const segments: RoadSegment[] = [];

  // --- pass 1: resample everything and index the carriageways ---------------
  // Pavements are 13 cm above the road, so without this every junction gets a
  // kerb ploughed straight across it. Knowing where the OTHER roads are lets us
  // drop the pavement quads that would cross one.
  interface Lane { pts: LocalPoint[]; hw: number; pw: number; road: Road }
  const lanes: Lane[] = [];
  const owner: number[] = [];
  for (const road of roads) {
    const pts = resample(road.centerline);
    if (pts.length < 2) continue;
    const hw = Math.max(1.2, road.widthMeters) / 2;
    lanes.push({ pts, hw, pw: PAVEMENT_W[road.tag] ?? 1.4, road });
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dz = pts[i + 1].z - pts[i].z;
      const l = Math.hypot(dx, dz) || 1;
      segments.push({
        x0: pts[i].x, z0: pts[i].z, x1: pts[i + 1].x, z1: pts[i + 1].z,
        tx: dx / l, tz: dz / l, halfWidth: hw, tag: road.tag,
      });
      owner.push(lanes.length - 1);
    }
  }

  const jGrid = new Map<number, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const pad = s.halfWidth + 2;
    const c0 = Math.floor((Math.min(s.x0, s.x1) - pad) / JUNCTION_CELL);
    const c1 = Math.floor((Math.max(s.x0, s.x1) + pad) / JUNCTION_CELL);
    const r0 = Math.floor((Math.min(s.z0, s.z1) - pad) / JUNCTION_CELL);
    const r1 = Math.floor((Math.max(s.z0, s.z1) + pad) / JUNCTION_CELL);
    for (let c = c0; c <= c1; c++) {
      for (let r = r0; r <= r1; r++) {
        const k = ((c + 32768) << 16) | ((r + 32768) & 0xffff);
        const cell = jGrid.get(k);
        if (cell) cell.push(i);
        else jGrid.set(k, [i]);
      }
    }
  }

  const seg = { x: 0, z: 0, t: 0 };
  function onOtherCarriageway(x: number, z: number, self: number): boolean {
    const c = Math.floor(x / JUNCTION_CELL);
    const r = Math.floor(z / JUNCTION_CELL);
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const list = jGrid.get((((c + dc) + 32768) << 16) | (((r + dr) + 32768) & 0xffff));
        if (!list) continue;
        for (const i of list) {
          if (owner[i] === self) continue;
          const s = segments[i];
          const dx = s.x1 - s.x0;
          const dz = s.z1 - s.z0;
          const len2 = dx * dx + dz * dz;
          let t = len2 > 0 ? ((x - s.x0) * dx + (z - s.z0) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          seg.x = s.x0 + dx * t;
          seg.z = s.z0 + dz * t;
          if (Math.hypot(x - seg.x, z - seg.z) < s.halfWidth + 0.4) return true;
        }
      }
    }
    return false;
  }

  // --- pass 2: geometry ----------------------------------------------------
  let used = 0;
  for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
    const { pts, hw, pw, road } = lanes[laneIndex];
    used++;
    const m = miters(pts);
    const blocked: boolean[] = [];

    const A: number[][] = [];   // +normal edge of the carriageway
    const B: number[][] = [];   // -normal edge
    const Ao: number[][] = [];  // outer pavement edge, +normal side
    const Bo: number[][] = [];
    const Au: number[][] = [];  // pavement top at the curb line, +normal side
    const Bu: number[][] = [];
    const vs: number[] = [];
    let run = 0;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const { nx, nz } = m[i];
      if (i > 0) run += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      vs.push(run / 8);

      const ax = p.x + nx * hw, az = p.z + nz * hw;
      const bx = p.x - nx * hw, bz = p.z - nz * hw;
      // The carriageway is a flat quad between its two edges, but the terrain
      // between them is not flat: where a road crosses a crest, the ground
      // bulges through the middle of the tarmac in big triangular wedges. Lift
      // both edges to clear the highest ground anywhere across the section.
      const crest = Math.max(
        sampler.sampleHeight(p.x, p.z),
        sampler.sampleHeight(p.x + nx * hw * 0.5, p.z + nz * hw * 0.5),
        sampler.sampleHeight(p.x - nx * hw * 0.5, p.z - nz * hw * 0.5),
      );
      const ay = Math.max(sampler.sampleHeight(ax, az), crest) + SURFACE_LIFT;
      const by = Math.max(sampler.sampleHeight(bx, bz), crest) + SURFACE_LIFT;
      A.push([ax, ay, az]);
      B.push([bx, by, bz]);
      if (pw > 0) {
        Au.push([ax, ay + CURB_H, az]);
        Bu.push([bx, by + CURB_H, bz]);
        const aox = p.x + nx * (hw + pw), aoz = p.z + nz * (hw + pw);
        const box = p.x - nx * (hw + pw), boz = p.z - nz * (hw + pw);
        Ao.push([aox, sampler.sampleHeight(aox, aoz) + SURFACE_LIFT + CURB_H, aoz]);
        Bo.push([box, sampler.sampleHeight(box, boz) + SURFACE_LIFT + CURB_H, boz]);
      }

      blocked.push(pw > 0 && onOtherCarriageway(p.x, p.z, laneIndex));
    }

    ribbon(surf, A, B, vs);

    if (pw > 0) {
      // pavements sit on top of the curb, and stop at junctions
      ribbon(walk, Ao, Au, vs, PAVEMENT_COL, blocked);
      ribbon(walk, Bu, Bo, vs, PAVEMENT_COL, blocked);
      // curb faces (vertical). The material is DoubleSide, so winding is free
      // here, but the normals must be real or the curbs render black.
      for (let i = 0; i < A.length - 1; i++) {
        if (blocked[i] || blocked[i + 1]) continue;
        const na = m[i], nb = m[i + 1];
        const anx = (na.nx + nb.nx) * 0.5, anz = (na.nz + nb.nz) * 0.5;
        const al = Math.hypot(anx, anz) || 1;
        const ax = anx / al, az = anz / al;
        walk.tri(A[i], Au[i + 1], Au[i], ax, 0, az, 0, vs[i], 1, vs[i + 1], 1, vs[i], CURB_COL);
        walk.tri(A[i], A[i + 1], Au[i + 1], ax, 0, az, 0, vs[i], 0, vs[i + 1], 1, vs[i + 1], CURB_COL);
        walk.tri(B[i], Bu[i], Bu[i + 1], -ax, 0, -az, 0, vs[i], 1, vs[i], 1, vs[i + 1], CURB_COL);
        walk.tri(B[i], Bu[i + 1], B[i + 1], -ax, 0, -az, 0, vs[i], 1, vs[i + 1], 0, vs[i + 1], CURB_COL);
      }
    }

    if (MARKED.includes(road.tag) && hw > 3) {
      const L: number[][] = [];
      const R: number[][] = [];
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const { nx, nz } = m[i];
        const y = sampler.sampleHeight(p.x, p.z) + SURFACE_LIFT + 0.015;
        L.push([p.x + nx * 0.16, y, p.z + nz * 0.16]);
        R.push([p.x - nx * 0.16, y, p.z - nz * 0.16]);
      }
      ribbon(mark, L, R, vs);
    }
  }

  const meshes: Mesh[] = [];
  let triangles = 0;
  const add = (buf: RBuf, mat: WorldMaterials["road"], name: string, cast: boolean) => {
    const g = buf.toGeometry();
    if (!g) return;
    const mesh = new Mesh(g, mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    mesh.matrixAutoUpdate = false;
    meshes.push(mesh);
    triangles += buf.triangles;
  };
  add(surf, mats.road, "roads-surface", false);
  add(walk, mats.sidewalk, "roads-pavement", false);
  add(mark, mats.roadMarking, "roads-markings", false);

  return {
    meshes,
    segments,
    stats: { roads: used, segments: segments.length, triangles, drawCalls: meshes.length },
  };
}
