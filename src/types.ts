// ============================================================================
// Homeground — shared type contract (frontend + backend)
//
// COORDINATE CONVENTION (read this before touching anything):
//   - All "local meters" coordinates are Y-up, right-handed, in METERS.
//   - +X = east, +Z = south, -Z = north, Y = up (elevation above local origin).
//   - The origin (0, 0, 0) is the geocoded address point (lat0/lon0 in
//     TilePayload.origin), projected with an equirectangular approximation:
//       x = (lon - lon0) * metersPerDegLon
//       z = (lat0 - lat)  * metersPerDegLat      // note the sign: north is -Z
//     metersPerDegLat ~= 111_320
//     metersPerDegLon ~= 111_320 * cos(lat0 * PI / 180)
//   - This is valid for the ~1km box we render; do not use it at city scale.
//   - Heights/elevations are meters above the WGS84 ellipsoid/geoid as
//     returned by the elevation source — treat as relative, not absolute.
// ============================================================================

/** A 2D point in local meters (X east, Z south). Y is omitted where implied. */
export interface LocalPoint {
  x: number;
  z: number;
}

/** Geocoding request: a free-text address. */
export interface GeoRequest {
  address: string;
}

export interface GeoResponse {
  lat: number;
  lon: number;
  /** Normalized display name returned by the geocoder. */
  displayName: string;
}

/** Request for a world tile centered on a geocoded point. */
export interface TileRequest {
  lat: number;
  lon: number;
  /** Optional override; server defaults to ~1000m. */
  radiusMeters?: number;
}

/**
 * Regular-grid heightfield. Elevations are row-major, origin at the
 * grid's local (minX, minZ) corner, spaced `spacing` meters apart.
 * `elevations` is a flat array of length width * depth (Float32Array-able:
 * transmitted as number[] over JSON, consumed as Float32Array on the client).
 */
export interface Heightfield {
  width: number; // number of samples along X (east)
  depth: number; // number of samples along Z (south)
  spacing: number; // meters between adjacent samples
  originX: number; // local-meters X of sample (0,0)
  originZ: number; // local-meters Z of sample (0,0)
  /** row-major, index = row * width + col, where row advances +Z, col advances +X */
  elevations: number[];
}

export type BuildingTag =
  | "residential"
  | "retail"
  | "commercial"
  | "industrial"
  | "religious"
  | "civic"
  | "garage"
  | "other";

export interface Building {
  /** Footprint polygon ring in local meters, closed or open (renderer closes it). */
  footprint: LocalPoint[];
  /** Extrusion height in meters above terrain at the footprint's centroid. */
  height: number;
  tag: BuildingTag;
  /** Raw OSM tags kept for facade detail decisions (e.g. building:levels). */
  osmTags: Record<string, string>;
}

export type RoadTag =
  | "motorway"
  | "primary"
  | "secondary"
  | "residential"
  | "service"
  | "footway"
  | "other";

export interface Road {
  /** Centerline polyline in local meters, in path order. */
  centerline: LocalPoint[];
  /** Road width in meters (derived from OSM tag/lanes, with fallback default). */
  widthMeters: number;
  tag: RoadTag;
  osmTags: Record<string, string>;
}

/** The full normalized payload the frontend needs to build one world tile. */
export interface TilePayload {
  origin: {
    lat: number;
    lon: number;
  };
  radiusMeters: number;
  terrain: Heightfield;
  buildings: Building[];
  roads: Road[];
  /** ISO timestamp of when this tile was generated/cached. */
  generatedAt: string;
}

/** A candidate downhill run produced by the route-scoring heuristic. */
export interface RunCandidate {
  /** Polyline in local meters, ordered from start (top) to end (bottom). */
  path: LocalPoint[];
  /** Total elevation drop in meters, start to end. */
  elevationDrop: number;
  /** Path length in meters. */
  lengthMeters: number;
  /** Average gradient (drop / length), unitless, 0..1+. */
  avgGradient: number;
  /** Heuristic composite score, higher is better. Not a physical unit. */
  score: number;
  /** Local-meters spawn point at the top of the run. */
  spawn: LocalPoint;
  /** Yaw in radians the player should face at spawn (0 = +X east, increasing toward +Z south). */
  spawnYawRadians: number;
}

/** Query params that restore a shared view: ?lat=..&lon=..&addr=.. */
export interface ShareState {
  lat: number;
  lon: number;
  addr: string;
}
