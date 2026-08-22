// Address -> TilePayload. OSM (Overpass) footprints + road centerlines,
// USGS/SRTM elevation grid, all projected into the local-meters convention
// documented in src/types.ts.

import type {
  Building,
  BuildingTag,
  Heightfield,
  LocalPoint,
  Road,
  RoadTag,
  TilePayload,
} from "./types.js";
import { politeFetch, UpstreamError } from "./upstream.js";

const OVERPASS_URL =
  process.env.HG_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const ELEVATION_URL =
  process.env.HG_ELEVATION_URL ?? "https://api.opentopodata.org/v1";
/** Primary is USGS 10m (US only, float precision). Fallback is global SRTM 90m. */
const ELEVATION_DATASETS = (
  process.env.HG_ELEVATION_DATASETS ?? "ned10m,srtm90m"
).split(",");
/** OpenTopoData's public API caps a request at 100 locations. */
const ELEV_BATCH = 100;
/** Samples per side of the elevation grid. 33 => 11 upstream calls => ~13s cold. */
const GRID = Number(process.env.HG_GRID ?? 33);

export const M_PER_DEG_LAT = 111_320;
export const metersPerDegLon = (lat: number) =>
  111_320 * Math.cos((lat * Math.PI) / 180);

/** lat/lon -> local meters. +X east, +Z south (see src/types.ts). */
export function project(
  lat: number,
  lon: number,
  lat0: number,
  lon0: number,
): LocalPoint {
  return {
    x: (lon - lon0) * metersPerDegLon(lat0),
    z: (lat0 - lat) * M_PER_DEG_LAT,
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10; // 10cm — keeps the payload small

// ---------------------------------------------------------------- OSM parsing

interface OsmNode {
  lat: number;
  lon: number;
}
interface OsmElement {
  type: "way" | "relation" | "node";
  id: number;
  tags?: Record<string, string>;
  geometry?: OsmNode[];
  members?: { type: string; role: string; geometry?: OsmNode[] }[];
}

const BUILDING_TAGS: [RegExp, BuildingTag][] = [
  [/^(house|residential|apartments|detached|terrace|semidetached_house|bungalow|dormitory|cabin|farm)$/, "residential"],
  [/^(retail|shop|supermarket|kiosk|mall|hotel)$/, "retail"],
  [/^(commercial|office)$/, "commercial"],
  [/^(industrial|warehouse|factory|manufacture|hangar|silo|storage_tank)$/, "industrial"],
  [/^(church|cathedral|mosque|temple|synagogue|chapel|religious|shrine)$/, "religious"],
  [/^(school|university|college|hospital|civic|public|government|train_station|transportation|stadium|museum|library|fire_station|kindergarten|sports_hall)$/, "civic"],
  [/^(garage|garages|carport|shed|hut|roof|service)$/, "garage"],
];

/** Fallback heights in meters when OSM has neither `height` nor `building:levels`. */
const DEFAULT_HEIGHT: Record<BuildingTag, number> = {
  residential: 7,
  retail: 6.5,
  commercial: 14,
  industrial: 9,
  religious: 14,
  civic: 12,
  garage: 3.2,
  other: 8,
};

function buildingTag(tags: Record<string, string>): BuildingTag {
  const v = (tags["building"] ?? "yes").toLowerCase();
  for (const [re, tag] of BUILDING_TAGS) if (re.test(v)) return tag;
  // building=yes is the majority case: infer from companion tags.
  if (tags["shop"]) return "retail";
  if (tags["office"]) return "commercial";
  if (tags["amenity"] === "place_of_worship") return "religious";
  if (tags["amenity"] || tags["tourism"]) return "civic";
  return "other";
}

/** Parses `height`, tolerating "12", "12 m", "40'", "40 ft". */
function parseHeight(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(m|ft|')?\s*$/i.exec(v);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]?.toLowerCase();
  return unit === "ft" || unit === "'" ? n * 0.3048 : n;
}

function deriveHeight(tags: Record<string, string>, tag: BuildingTag): number {
  const explicit = parseHeight(tags["height"] ?? tags["building:height"]);
  if (explicit) return Math.min(400, Math.max(2, explicit));
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (Number.isFinite(levels) && levels > 0)
    return Math.min(400, Math.max(2.5, levels * 3.2 + 1));
  return DEFAULT_HEIGHT[tag];
}

const ROAD_TAGS: [RegExp, RoadTag][] = [
  [/^motorway(_link)?$/, "motorway"],
  [/^(trunk|primary)(_link)?$/, "primary"],
  [/^(secondary|tertiary)(_link)?$/, "secondary"],
  [/^(residential|living_street|unclassified)$/, "residential"],
  [/^(service|track)$/, "service"],
  [/^(footway|path|pedestrian|cycleway|steps|bridleway|corridor)$/, "footway"],
];
const DEFAULT_WIDTH: Record<RoadTag, number> = {
  motorway: 16,
  primary: 12,
  secondary: 9,
  residential: 7,
  service: 4.5,
  footway: 2,
  other: 6,
};

function roadTag(tags: Record<string, string>): RoadTag {
  const v = (tags["highway"] ?? "").toLowerCase();
  for (const [re, tag] of ROAD_TAGS) if (re.test(v)) return tag;
  return "other";
}

function roadWidth(tags: Record<string, string>, tag: RoadTag): number {
  const explicit = parseHeight(tags["width"]); // same "12 m" / "40 ft" grammar
  if (explicit) return Math.min(40, Math.max(1, explicit));
  const lanes = Number.parseFloat(tags["lanes"] ?? "");
  if (Number.isFinite(lanes) && lanes > 0) return Math.min(40, lanes * 3.6);
  return DEFAULT_WIDTH[tag];
}

/** Tags the renderer plausibly uses. Shipping every raw OSM tag for ~3000
 *  elements triples the payload for no visual gain. */
const KEEP_TAGS = new Set([
  "building", "building:levels", "building:material", "building:colour",
  "height", "roof:shape", "roof:colour", "roof:material", "roof:levels",
  "name", "amenity", "shop", "office", "tourism", "leisure", "landuse",
  "highway", "lanes", "oneway", "surface", "bridge", "tunnel", "layer",
  "maxspeed", "service", "width",
]);
const trimTags = (t: Record<string, string>) =>
  Object.fromEntries(Object.entries(t).filter(([k]) => KEEP_TAGS.has(k)));

function ringToFootprint(
  geometry: OsmNode[],
  lat0: number,
  lon0: number,
): LocalPoint[] | null {
  const pts = geometry
    .filter((n) => n && Number.isFinite(n.lat) && Number.isFinite(n.lon))
    .map((n) => {
      const p = project(n.lat, n.lon, lat0, lon0);
      return { x: r1(p.x), z: r1(p.z) };
    });
  // Overpass closes rings by repeating the first node; drop the duplicate.
  if (
    pts.length > 1 &&
    pts[0]!.x === pts[pts.length - 1]!.x &&
    pts[0]!.z === pts[pts.length - 1]!.z
  )
    pts.pop();
  return pts.length >= 3 ? pts : null;
}

/** Signed-area magnitude of a ring, m^2. */
function polygonArea(ring: LocalPoint[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

const inBox = (p: LocalPoint, r: number) => Math.abs(p.x) <= r && Math.abs(p.z) <= r;

/**
 * Overpass `out geom` returns the WHOLE geometry of any way that touches the
 * bbox, so a long street can trail 1.5km outside the tile — past the edge of
 * the heightfield, where elevation sampling would silently clamp. Split each
 * centerline into the pieces that are actually inside the box (keeping one
 * vertex of overhang so segments reach the boundary cleanly).
 */
function clipPolyline(pts: LocalPoint[], r: number): LocalPoint[][] {
  const keep = pts.map(
    (p, i) =>
      inBox(p, r) ||
      (i > 0 && inBox(pts[i - 1]!, r)) ||
      (i < pts.length - 1 && inBox(pts[i + 1]!, r)),
  );
  const out: LocalPoint[][] = [];
  let cur: LocalPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) cur.push(pts[i]!);
    else {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

export async function fetchOsm(
  lat0: number,
  lon0: number,
  radiusMeters: number,
): Promise<{ buildings: Building[]; roads: Road[] }> {
  const dLat = radiusMeters / M_PER_DEG_LAT;
  const dLon = radiusMeters / metersPerDegLon(lat0);
  const bbox = [
    (lat0 - dLat).toFixed(6),
    (lon0 - dLon).toFixed(6),
    (lat0 + dLat).toFixed(6),
    (lon0 + dLon).toFixed(6),
  ].join(",");

  const query = `[out:json][timeout:90];
(
  way["building"](${bbox});
  relation["building"]["type"="multipolygon"](${bbox});
  way["highway"](${bbox});
);
out body geom qt;`;

  const res = await politeFetch(OVERPASS_URL, {
    method: "POST",
    body: query,
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
  });
  const json = (await res.json()) as { elements?: OsmElement[] };
  const elements = json.elements ?? [];
  if (elements.length === 0)
    throw new UpstreamError(
      "Overpass returned no elements for this bbox — nothing is mapped here",
      // 422, not 502: Overpass answered correctly, the box is simply empty.
      // The client turns this into "Nothing is built here." rather than
      // blaming a data source that is working fine.
      422,
    );

  const buildings: Building[] = [];
  const roads: Road[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    if (tags["building"] && tags["building"] !== "no") {
      const rings: OsmNode[][] =
        el.type === "way"
          ? el.geometry
            ? [el.geometry]
            : []
          : (el.members ?? [])
              .filter((m) => m.role === "outer" && m.geometry?.length)
              .map((m) => m.geometry!);
      // Inner rings (courtyards) are dropped: buildings are extruded solids.
      for (const ring of rings) {
        const footprint = ringToFootprint(ring, lat0, lon0);
        if (!footprint) continue;
        if (!footprint.some((p) => inBox(p, radiusMeters + 60))) continue;
        const osmTags = trimTags(tags);
        let tag = buildingTag(tags);
        // ~70% of US footprints are a bare `building=yes`, which would leave
        // the whole town classified "other". A small, simple footprint is a
        // house; say so, and label the inference so it is not mistaken for
        // surveyed data.
        if (
          tag === "other" &&
          footprint.length <= 6 &&
          polygonArea(footprint) < 300
        ) {
          tag = "residential";
          osmTags["homeground:inferred"] = "residential-from-footprint";
        }
        buildings.push({
          footprint,
          height: deriveHeight(tags, tag),
          tag,
          osmTags,
        });
      }
    } else if (tags["highway"] && el.type === "way" && el.geometry) {
      const tag = roadTag(tags);
      const widthMeters = roadWidth(tags, tag);
      const osmTags = trimTags(tags);
      const full = el.geometry.map((n) => {
        const p = project(n.lat, n.lon, lat0, lon0);
        return { x: r1(p.x), z: r1(p.z) };
      });
      for (const centerline of clipPolyline(full, radiusMeters))
        roads.push({ centerline, widthMeters, tag, osmTags });
    }
  }
  return { buildings, roads };
}

// -------------------------------------------------------------- elevation

interface TopoResponse {
  status: string;
  error?: string;
  results?: { elevation: number | null }[];
}

async function fetchElevationBatch(
  dataset: string,
  locations: string[],
): Promise<(number | null)[]> {
  const body = new URLSearchParams({ locations: locations.join("|") });
  const res = await politeFetch(`${ELEVATION_URL}/${dataset}`, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const json = (await res.json()) as TopoResponse;
  if (json.status !== "OK")
    throw new UpstreamError(
      `elevation API (${dataset}) error: ${json.error ?? json.status}`,
      502,
    );
  return (json.results ?? []).map((r) => r.elevation);
}

/**
 * Real elevation grid for the box. Tries datasets in order (USGS 10m first,
 * then global SRTM 90m) and moves on if a dataset has no coverage here.
 * Throws rather than silently returning a flat plane — an all-zero heightfield
 * means the fetch failed, and that must be loud.
 */
export async function fetchHeightfield(
  lat0: number,
  lon0: number,
  radiusMeters: number,
): Promise<{ terrain: Heightfield; dataset: string; upstreamCalls: number }> {
  const spacing = (radiusMeters * 2) / (GRID - 1);
  const mLon = metersPerDegLon(lat0);

  const locations: string[] = [];
  for (let row = 0; row < GRID; row++) {
    const z = -radiusMeters + row * spacing;
    const lat = lat0 - z / M_PER_DEG_LAT;
    for (let col = 0; col < GRID; col++) {
      const x = -radiusMeters + col * spacing;
      locations.push(`${lat.toFixed(6)},${(lon0 + x / mLon).toFixed(6)}`);
    }
  }

  let upstreamCalls = 0;
  let lastError = "";
  for (const dataset of ELEVATION_DATASETS) {
    const values: (number | null)[] = [];
    let uncovered = false;
    try {
      for (let i = 0; i < locations.length; i += ELEV_BATCH) {
        upstreamCalls++;
        values.push(
          ...(await fetchElevationBatch(
            dataset,
            locations.slice(i, i + ELEV_BATCH),
          )),
        );
        // Bail after the FIRST batch if this dataset has no data here, instead
        // of spending 10 more requests discovering the same thing. (ned10m is
        // US-only; outside it every value comes back null.)
        if (values.filter((v) => v !== null).length < values.length * 0.6) {
          uncovered = true;
          break;
        }
      }
    } catch (err) {
      lastError = (err as Error).message;
      continue;
    }
    if (uncovered) {
      lastError = `${dataset} has no coverage at ${lat0},${lon0}`;
      continue;
    }
    const covered = values.filter((v) => v !== null).length;
    if (covered < values.length * 0.6) {
      lastError = `${dataset} covers only ${covered}/${values.length} samples here`;
      continue; // outside this dataset's footprint — try the next one
    }
    // Fill the few nulls from the nearest covered neighbour.
    const elevations = values.map((v, i) => {
      if (v !== null) return v;
      for (let d = 1; d < values.length; d++) {
        const a = values[i - d];
        if (a != null) return a;
        const b = values[i + d];
        if (b != null) return b;
      }
      return 0;
    });
    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    if (!(max > min))
      throw new UpstreamError(
        `elevation grid from ${dataset} is perfectly flat (${min}m) — refusing to ship a fake heightfield`,
        502,
      );
    return {
      terrain: {
        width: GRID,
        depth: GRID,
        spacing,
        originX: -radiusMeters,
        originZ: -radiusMeters,
        elevations: elevations.map((e) => Math.round(e * 100) / 100),
      },
      dataset,
      upstreamCalls,
    };
  }
  throw new UpstreamError(
    `no elevation dataset covered ${lat0},${lon0} (tried ${ELEVATION_DATASETS.join(", ")}): ${lastError}`,
    502,
  );
}

// -------------------------------------------------------------------- tile

export async function buildTile(
  lat0: number,
  lon0: number,
  radiusMeters: number,
): Promise<{ payload: TilePayload; dataset: string; elevationCalls: number }> {
  // Sequential on purpose: one upstream at a time (see upstream.ts).
  const { buildings, roads } = await fetchOsm(lat0, lon0, radiusMeters);
  const { terrain, dataset, upstreamCalls } = await fetchHeightfield(
    lat0,
    lon0,
    radiusMeters,
  );
  return {
    payload: {
      origin: { lat: lat0, lon: lon0 },
      radiusMeters,
      terrain,
      buildings,
      roads,
      generatedAt: new Date().toISOString(),
    },
    dataset,
    elevationCalls: upstreamCalls,
  };
}
