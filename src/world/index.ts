// ---------------------------------------------------------------------------
// Homeground — world generation. PUBLIC API.
//
//   const world = buildWorld(payload);
//   scene.add(world.root);
//   const look = createLookDev(scene, { radiusMeters: payload.radiusMeters });
//
// Everything the gameplay layer needs is on `world`:
//
//   world.sampleHeight(x, z)              -> ground elevation, metres
//   world.sampleNormal(x, z)              -> unit terrain normal {x,y,z}
//   world.sampleSlope(x, z)               -> { gradient, dirX, dirZ } downhill
//   world.collision.slideCircle(x, z, r)  -> null | { x, z, nx, nz, depth, settled }
//   world.collision.resolveCircle(x,z,r)  -> null | { x, z, nx, nz, depth, building }
//   world.collision.isInsideBuilding(x,z) -> null | BuildingCollider
//   world.collision.queryBuildings(x,z,r) -> BuildingCollider[]
//   world.collision.sampleRoad(x, z, max) -> null | { distance, onRoad, tx, tz, halfWidth, tag }
//
// Coordinates are the shared convention from src/types.ts: metres, Y up,
// +X east, +Z south, origin at the geocoded address.
// ---------------------------------------------------------------------------

import { Group, type Camera, type Scene } from "three";
import type { TilePayload } from "../types.js";
import { buildBuildings } from "./buildings.js";
import { createCollision, type WorldCollision } from "./collision.js";
import { makeMaterials, type WorldMaterials } from "./materials.js";
import { buildRoads, type RoadSegment } from "./roads.js";
import {
  buildTerrainMesh,
  createTerrainSampler,
  type TerrainSampler,
} from "./terrain.js";

export type { BuildingCollider } from "./buildings.js";
export type { CircleHit, RoadHit, SlideResult, WorldCollision } from "./collision.js";
export type { RoadSegment } from "./roads.js";
export type { TerrainSampler } from "./terrain.js";
export type { WorldMaterials } from "./materials.js";
export type { PostFX } from "./postfx.js";
export { configureRenderer, createLookDev, HORIZON_COLOR, type LookDev } from "./lookdev.js";

export interface WorldStats {
  triangles: number;
  drawCalls: number;
  vertices: number;
  buildings: number;
  buildingsSkipped: number;
  pitchedRoofs: number;
  roads: number;
  roadSegments: number;
  terrainTriangles: number;
  buildTimeMs: number;
}

export interface World {
  /** Add this to the scene. Contains every merged mesh. */
  root: Group;
  /** Ground elevation in metres at local-metres (x, z). Clamps outside the tile. */
  sampleHeight(x: number, z: number): number;
  /** Unit up-normal of the ground at (x, z). */
  sampleNormal(x: number, z: number, out?: { x: number; y: number; z: number }): { x: number; y: number; z: number };
  /** Downhill gradient magnitude + unit direction at (x, z). */
  sampleSlope(x: number, z: number): { gradient: number; dirX: number; dirZ: number };
  collision: WorldCollision;
  terrain: TerrainSampler;
  materials: WorldMaterials;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  stats: WorldStats;
  dispose(): void;
}

export interface BuildWorldOptions {
  /** Target metres between terrain mesh vertices (default 6). */
  terrainVertexSpacing?: number;
  /** Skip road geometry (used by the harness for isolation). */
  skipRoads?: boolean;
}

export function buildWorld(payload: TilePayload, opts: BuildWorldOptions = {}): World {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

  const materials = makeMaterials();
  const terrain = createTerrainSampler(payload.terrain, {
    targetVertexSpacing: opts.terrainVertexSpacing,
  });

  const root = new Group();
  root.name = "homeground-world";

  const terrainMesh = buildTerrainMesh(terrain, materials.terrain);
  root.add(terrainMesh.mesh);

  const roads = opts.skipRoads
    ? { meshes: [], segments: [] as RoadSegment[], stats: { roads: 0, segments: 0, triangles: 0, drawCalls: 0 } }
    : buildRoads(payload.roads, terrain, materials);
  for (const m of roads.meshes) root.add(m);

  const buildings = buildBuildings(payload.buildings, terrain, materials);
  for (const m of buildings.meshes) root.add(m);

  root.updateMatrixWorld(true);

  const collision = createCollision(buildings.colliders, roads.segments);

  let vertices = 0;
  root.traverse((o) => {
    const g = (o as { geometry?: { getAttribute(n: string): { count: number } | undefined } }).geometry;
    const p = g?.getAttribute("position");
    if (p) vertices += p.count;
  });

  const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();

  return {
    root,
    sampleHeight: terrain.sampleHeight,
    sampleNormal: terrain.sampleNormal,
    sampleSlope: terrain.sampleSlope,
    collision,
    terrain,
    materials,
    bounds: terrain.bounds,
    stats: {
      triangles: terrainMesh.triangles + roads.stats.triangles + buildings.stats.triangles,
      drawCalls: 1 + roads.stats.drawCalls + buildings.stats.drawCalls,
      vertices,
      buildings: buildings.stats.buildings,
      buildingsSkipped: buildings.stats.skipped,
      pitchedRoofs: buildings.stats.pitchedRoofs,
      roads: roads.stats.roads,
      roadSegments: roads.stats.segments,
      terrainTriangles: terrainMesh.triangles,
      buildTimeMs: Math.round((t1 - t0) * 10) / 10,
    },
    dispose() {
      root.traverse((o) => {
        const g = (o as { geometry?: { dispose(): void } }).geometry;
        g?.dispose();
      });
      root.clear();
      materials.dispose();
    },
  };
}

/**
 * Tilt-shift + vignette post pass. Loads `three/webgpu` lazily so this module
 * stays headless-safe. Returns null (and logs) if the pass cannot be created —
 * callers should fall back to `renderer.render(scene, camera)`.
 */
export async function createPostFX(
  renderer: unknown,
  scene: Scene,
  camera: Camera,
): Promise<import("./postfx.js").PostFX | null> {
  try {
    const mod = await import("./postfx.js");
    return mod.createPostFX(renderer as never, scene as never, camera as never);
  } catch (err) {
    console.warn("[homeground/world] post-processing unavailable, rendering direct:", err);
    return null;
  }
}
