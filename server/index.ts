// Homeground API.
//   GET|POST /api/geocode?q=<address>   -> GeoResponse
//   GET      /api/tile?lat=&lon=        -> TilePayload + runs
//   GET      /api/health
//
// OSM usage policy: every upstream call goes through server/upstream.ts, which
// sends a real User-Agent, serialises requests (one at a time, >=1.1s apart per
// host) and backs off on 429/503. Everything is disk-cached under .cache/, so a
// repeated address costs zero upstream requests.
// Data (c) OpenStreetMap contributors, ODbL. Elevation: USGS 3DEP / NASA SRTM
// via opentopodata.org.

import { gzipSync } from "node:zlib";
import cors from "cors";
import express, { type Request, type Response } from "express";
import type { GeoResponse, RunCandidate, TilePayload } from "./types.js";
import { buildTile, project } from "./tile.js";
import { findRuns } from "./runs.js";
import { cached, hashKey, politeFetch, UpstreamError } from "./upstream.js";

const PORT = Number(process.env.PORT ?? 8787);
const NOMINATIM_URL =
  process.env.HG_NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search";
const DEFAULT_RADIUS = Number(process.env.HG_RADIUS_METERS ?? 1000);

/** Tile cache granularity: ~110m. Neighbours share a tile, which is the point. */
const tileKey = (lat: number, lon: number, r: number) =>
  `${lat.toFixed(3)}_${lon.toFixed(3)}_${r}`;
const snap = (n: number) => Number(n.toFixed(3));

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));

/** Express has no built-in compression and tile payloads are ~1-3MB of JSON
 *  that gzips ~10x. Five lines beats adding a dependency. */
function sendJson(req: Request, res: Response, body: unknown) {
  const json = JSON.stringify(body);
  if (json.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    const buf = gzipSync(json);
    res
      .status(200)
      .set({ "Content-Type": "application/json", "Content-Encoding": "gzip" })
      .end(buf);
    return;
  }
  res.status(200).type("application/json").send(json);
}

function fail(res: Response, err: unknown) {
  const status = err instanceof UpstreamError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[homeground] ${status} ${message}`);
  res.status(status).json({ error: message });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, radiusMeters: DEFAULT_RADIUS });
});

// ------------------------------------------------------------------ geocode

interface NominatimHit {
  lat: string;
  lon: string;
  display_name: string;
}

app.all("/api/geocode", async (req: Request, res: Response) => {
  const q = String(
    (req.method === "POST" ? (req.body?.address ?? req.body?.q) : undefined) ??
      req.query.q ??
      req.query.address ??
      "",
  ).trim();
  if (!q) return res.status(400).json({ error: "missing ?q=<address>" });
  if (q.length > 300) return res.status(400).json({ error: "address too long" });

  try {
    const { value, hit } = await cached<GeoResponse | null>(
      "geocode",
      hashKey(q.toLowerCase()),
      async () => {
        const url = `${NOMINATIM_URL}?${new URLSearchParams({
          q,
          format: "jsonv2",
          limit: "1",
          addressdetails: "0",
        })}`;
        const hits = (await (await politeFetch(url)).json()) as NominatimHit[];
        const first = hits[0];
        if (!first) return null;
        return {
          lat: Number(first.lat),
          lon: Number(first.lon),
          displayName: first.display_name,
        };
      },
    );
    res.set("X-Homeground-Cache", hit ? "HIT" : "MISS");
    if (!value)
      return res
        .status(404)
        .json({ error: `no result for "${q}" — try adding a city or postcode` });
    return res.json(value);
  } catch (err) {
    return fail(res, err);
  }
});

// --------------------------------------------------------------------- tile

interface CachedTile {
  payload: TilePayload;
  runs: RunCandidate[];
  dataset: string;
}

app.get("/api/tile", async (req: Request, res: Response) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radiusMeters = Math.min(
    2000,
    Math.max(200, Number(req.query.radius) || DEFAULT_RADIUS),
  );
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180)
    return res.status(400).json({ error: "need valid ?lat=&lon=" });

  // Tile origin is the snapped lat/lon so that a cache key and an origin are
  // the same thing. The exact requested point is echoed back as `query` and as
  // `queryLocal` (local meters) so the client can still mark the real address.
  const lat0 = snap(lat);
  const lon0 = snap(lon);
  const started = Date.now();
  try {
    const { value, hit } = await cached<CachedTile>(
      "tiles",
      tileKey(lat0, lon0, radiusMeters),
      async () => {
        const { payload, dataset } = await buildTile(lat0, lon0, radiusMeters);
        const runs = findRuns(
          payload.roads,
          payload.terrain,
          5,
          project(lat, lon, lat0, lon0),
        );
        return { payload, runs, dataset };
      },
    );
    const ms = Date.now() - started;
    res.set({
      "X-Homeground-Cache": hit ? "HIT" : "MISS",
      "X-Homeground-Ms": String(ms),
      "X-Homeground-Elevation-Dataset": value.dataset,
    });
    console.log(
      `[homeground] tile ${lat0},${lon0} r=${radiusMeters} ${hit ? "HIT" : "MISS"} ${ms}ms ` +
        `buildings=${value.payload.buildings.length} roads=${value.payload.roads.length} runs=${value.runs.length}`,
    );
    return sendJson(req, res, {
      ...value.payload,
      runs: value.runs,
      elevationDataset: value.dataset,
      query: { lat, lon },
      queryLocal: project(lat, lon, lat0, lon0),
      cache: hit ? "HIT" : "MISS",
      attribution:
        "Buildings & roads (c) OpenStreetMap contributors (ODbL). Elevation via opentopodata.org (USGS 3DEP / NASA SRTM).",
    });
  } catch (err) {
    return fail(res, err);
  }
});

app.listen(PORT, () =>
  console.log(`[homeground] api on http://localhost:${PORT} (UA-identified, disk-cached in .cache/)`),
);
