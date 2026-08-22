// "Find the run" — a HEURISTIC, not a solver.
//
// Given the elevation grid and the OSM road centerlines we build a road graph
// (vertices snapped to a 1m lattice, so ways that share a junction node become
// connected), then greedily walk downhill from the highest junctions, scoring
// each resulting path on sustained drop, length and turn rhythm. There is no
// optimality claim here: it is a greedy walk over a sampled graph with hand
// weights, and it can miss the objectively best line. It reliably finds *a*
// good downhill street, which is the product requirement.

import type { Heightfield, LocalPoint, Road, RunCandidate } from "./types.js";

/** Bilinear sample of the heightfield at local-meters (x, z). */
export function sampleTerrain(hf: Heightfield, x: number, z: number): number {
  const fx = Math.min(
    hf.width - 1,
    Math.max(0, (x - hf.originX) / hf.spacing),
  );
  const fz = Math.min(
    hf.depth - 1,
    Math.max(0, (z - hf.originZ) / hf.spacing),
  );
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const x1 = Math.min(hf.width - 1, x0 + 1);
  const z1 = Math.min(hf.depth - 1, z0 + 1);
  const tx = fx - x0;
  const tz = fz - z0;
  const e = hf.elevations;
  const a = e[z0 * hf.width + x0]!;
  const b = e[z0 * hf.width + x1]!;
  const c = e[z1 * hf.width + x0]!;
  const d = e[z1 * hf.width + x1]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

const dist = (a: LocalPoint, b: LocalPoint) => Math.hypot(b.x - a.x, b.z - a.z);

interface Graph {
  pts: LocalPoint[];
  y: number[];
  adj: number[][];
  /** true if this vertex is on something wider than a sidewalk */
  street: boolean[];
}

/** Road vertices snapped to 1m; shared junction nodes merge into one graph node. */
function buildGraph(roads: Road[], hf: Heightfield): Graph {
  const index = new Map<string, number>();
  const pts: LocalPoint[] = [];
  const y: number[] = [];
  const adj: number[][] = [];
  const street: boolean[] = [];
  // Stay strictly inside the heightfield: outside it sampleTerrain clamps to
  // the edge value, which would invent a gradient that does not exist.
  const limit = -hf.originX - hf.spacing;

  const node = (p: LocalPoint) => {
    const key = `${Math.round(p.x)}|${Math.round(p.z)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = pts.length;
      index.set(key, id);
      pts.push(p);
      y.push(sampleTerrain(hf, p.x, p.z));
      adj.push([]);
      street.push(false);
    }
    return id;
  };
  const link = (a: number, b: number) => {
    if (a === b) return;
    if (!adj[a]!.includes(b)) adj[a]!.push(b);
    if (!adj[b]!.includes(a)) adj[b]!.push(a);
  };

  for (const road of roads) {
    // Steps aren't rideable; everything else (including paths) is fair game.
    if (road.osmTags["highway"] === "steps") continue;
    const isStreet = road.tag !== "footway";
    let prev = -1;
    for (const p of road.centerline) {
      if (Math.abs(p.x) > limit || Math.abs(p.z) > limit) {
        prev = -1;
        continue;
      }
      const id = node(p);
      street[id] = street[id] || isStreet;
      if (prev >= 0) link(prev, id);
      prev = id;
    }
  }
  return { pts, y, adj, street };
}

const MIN_STEP_DROP = 0.05; // meters — below this the DEM is just noise
const MAX_TURN = (110 * Math.PI) / 180; // hairpins break the ride

/** Greedy steepest-descent walk from `start`, preferring to keep going straight. */
function walkDownhill(g: Graph, start: number): number[] {
  const path = [start];
  const seen = new Set([start]);
  let heading: LocalPoint | null = null;

  for (let step = 0; step < 400; step++) {
    const cur = path[path.length - 1]!;
    let best = -1;
    let bestScore = -Infinity;
    for (const n of g.adj[cur]!) {
      if (seen.has(n)) continue;
      const drop = g.y[cur]! - g.y[n]!;
      if (drop < MIN_STEP_DROP) continue;
      const d = dist(g.pts[cur]!, g.pts[n]!);
      if (d < 0.5) continue;
      const dir = {
        x: (g.pts[n]!.x - g.pts[cur]!.x) / d,
        z: (g.pts[n]!.z - g.pts[cur]!.z) / d,
      };
      let turn = 0;
      if (heading) {
        const dot = Math.max(-1, Math.min(1, heading.x * dir.x + heading.z * dir.z));
        turn = Math.acos(dot);
        if (turn > MAX_TURN) continue;
      }
      // steepness first, straightness second
      const score = drop / d - turn * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best < 0) break;
    const d = dist(g.pts[cur]!, g.pts[best]!);
    heading = {
      x: (g.pts[best]!.x - g.pts[cur]!.x) / d,
      z: (g.pts[best]!.z - g.pts[cur]!.z) / d,
    };
    seen.add(best);
    path.push(best);
  }
  return path;
}

function scorePath(g: Graph, path: number[]): RunCandidate | null {
  if (path.length < 2) return null;
  const pts = path.map((i) => g.pts[i]!);
  let lengthMeters = 0;
  let turnSum = 0;
  for (let i = 1; i < pts.length; i++) {
    lengthMeters += dist(pts[i - 1]!, pts[i]!);
    if (i >= 2) {
      const a = Math.atan2(pts[i - 1]!.z - pts[i - 2]!.z, pts[i - 1]!.x - pts[i - 2]!.x);
      const b = Math.atan2(pts[i]!.z - pts[i - 1]!.z, pts[i]!.x - pts[i - 1]!.x);
      let d = Math.abs(b - a) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      turnSum += d;
    }
  }
  if (lengthMeters < 80) return null; // shorter than this is a driveway, not a run
  const elevationDrop = g.y[path[0]!]! - g.y[path[path.length - 1]!]!;
  const avgGradient = elevationDrop / lengthMeters;
  if (avgGradient > 0.4) return null; // DEM artefact, not a street

  const turnPerMeter = turnSum / lengthMeters; // radians per meter
  // You want to ride down YOUR STREET, not the drainage path behind it.
  const streetFraction =
    path.filter((i) => g.street[i]).length / path.length;
  // Hand-weighted composite. Sustained drop dominates; length helps up to
  // ~800m; sharp constant turning hurts; a 2–14% grade is the sweet spot for
  // a longboard so it gets a flat bonus.
  const score =
    elevationDrop * 3 +
    Math.min(lengthMeters, 800) / 80 +
    (avgGradient >= 0.02 && avgGradient <= 0.16 ? 4 : 0) +
    streetFraction * 5 -
    turnPerMeter * 150;

  const first = pts[0]!;
  const ahead = pts[Math.min(pts.length - 1, 3)]!;
  return {
    path: pts,
    elevationDrop: Math.round(elevationDrop * 100) / 100,
    lengthMeters: Math.round(lengthMeters * 10) / 10,
    avgGradient: Math.round(avgGradient * 10000) / 10000,
    score: Math.round(score * 100) / 100,
    spawn: first,
    // yaw: 0 = +X east, increasing toward +Z south (src/types.ts)
    spawnYawRadians:
      Math.round(Math.atan2(ahead.z - first.z, ahead.x - first.x) * 1000) / 1000,
  };
}

/**
 * Best few downhill runs, best first. `preferNear` biases toward runs that
 * start close to the geocoded address (you want YOUR street, not the best
 * street in the tile).
 */
export function findRuns(
  roads: Road[],
  terrain: Heightfield,
  limit = 5,
  preferNear: LocalPoint = { x: 0, z: 0 },
): RunCandidate[] {
  const g = buildGraph(roads, terrain);
  if (g.pts.length === 0) return [];

  // Junctions and high points make the best starts; cap the walk count so a
  // dense downtown tile still scores in well under a second.
  const starts = g.pts
    .map((_, i) => i)
    .filter((i) => g.adj[i]!.length > 0)
    .sort((a, b) => g.y[b]! - g.y[a]!)
    .slice(0, 600);

  const scored: RunCandidate[] = [];
  for (const s of starts) {
    const c = scorePath(g, walkDownhill(g, s));
    if (c) scored.push(c);
  }

  // Proximity bias, then greedy spatial dedupe so the list isn't five slivers
  // of the same hill. The bias is MULTIPLICATIVE on purpose: a subtractive
  // penalty is either irrelevant in hilly terrain (scores in the hundreds) or
  // overwhelming in flat terrain (scores in the teens). Scaling works in both.
  for (const c of scored) {
    const d = Math.hypot(c.spawn.x - preferNear.x, c.spawn.z - preferNear.z);
    c.score = Math.round((c.score / (1 + d / 600)) * 100) / 100;
  }
  scored.sort((a, b) => b.score - a.score);

  const kept: RunCandidate[] = [];
  for (const c of scored) {
    if (kept.length >= limit) break;
    if (kept.some((k) => Math.hypot(k.spawn.x - c.spawn.x, k.spawn.z - c.spawn.z) < 150))
      continue;
    kept.push(c);
  }

  // Flat city (Indianapolis is flat) — still spawn the player somewhere sane:
  // the longest road near the address, facing along it.
  if (kept.length === 0) {
    let best: Road | null = null;
    let bestLen = 0;
    for (const road of roads) {
      if (road.tag === "footway" || road.tag === "motorway") continue;
      let len = 0;
      for (let i = 1; i < road.centerline.length; i++)
        len += dist(road.centerline[i - 1]!, road.centerline[i]!);
      const near = Math.hypot(
        road.centerline[0]!.x - preferNear.x,
        road.centerline[0]!.z - preferNear.z,
      );
      const v = len - near / 4;
      if (v > bestLen) {
        bestLen = v;
        best = road;
      }
    }
    if (best) {
      const c = scorePath(
        {
          pts: best.centerline,
          y: best.centerline.map((p) => sampleTerrain(terrain, p.x, p.z)),
          adj: [],
          street: best.centerline.map(() => true),
        },
        best.centerline.map((_, i) => i),
      );
      if (c) kept.push(c);
    }
  }
  return kept;
}
