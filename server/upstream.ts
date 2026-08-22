// Polite upstream access + disk cache.
//
// Usage policy compliance (OSM Nominatim / Overpass / OpenTopoData all ask the
// same three things): identify yourself, don't run parallel requests, back off
// when told to. This module is the single choke point that enforces all three:
//   - a real User-Agent on every request (override with HG_USER_AGENT)
//   - ONE upstream request in flight at a time, globally, with a per-host
//     minimum gap (>= 1.1s, above Nominatim's and OpenTopoData's 1 req/s cap)
//   - exponential backoff honouring Retry-After on 429 / 503 / 504
// Everything fetched is written to .cache/ so a repeat address never touches
// the network again.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const USER_AGENT =
  process.env.HG_USER_AGENT ??
  "Homeground/0.1 (playable real-world street levels; https://github.com/homeground)";

export const CACHE_DIR = path.resolve(process.cwd(), ".cache");

/** Minimum milliseconds between two requests to the same host. */
const MIN_GAP_MS: Record<string, number> = {
  "nominatim.openstreetmap.org": 1200,
  "api.opentopodata.org": 1100,
  "overpass-api.de": 1500,
};
const DEFAULT_GAP_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number = 502,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

// Global serialisation: every politeFetch links onto the tail of this chain, so
// we never have two upstream requests in flight even under concurrent clients.
let chain: Promise<unknown> = Promise.resolve();
const lastHitAt = new Map<string, number>();

export function politeFetch(
  url: string,
  init: RequestInit = {},
  tries = 4,
): Promise<Response> {
  const run = async (): Promise<Response> => {
    const host = new URL(url).host;
    const gap = MIN_GAP_MS[host] ?? DEFAULT_GAP_MS;

    for (let attempt = 0; attempt < tries; attempt++) {
      const wait = (lastHitAt.get(host) ?? 0) + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastHitAt.set(host, Date.now());

      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          headers: {
            "User-Agent": USER_AGENT,
            "Accept-Encoding": "gzip",
            ...((init.headers as Record<string, string>) ?? {}),
          },
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        if (attempt === tries - 1)
          throw new UpstreamError(
            `${host} unreachable: ${(err as Error).message}`,
            504,
          );
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      if (res.status === 429 || res.status === 503 || res.status === 504) {
        if (attempt === tries - 1)
          throw new UpstreamError(
            `${host} is rate-limiting or overloaded (HTTP ${res.status}) after ${tries} attempts — try again in a minute`,
            503,
          );
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 30) * 1000
            : 2000 * 2 ** attempt,
        );
        continue;
      }

      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new UpstreamError(`${host} returned HTTP ${res.status}: ${body}`, 502);
      }
      return res;
    }
    throw new UpstreamError(`${host}: exhausted retries`, 503);
  };

  const result = chain.then(run, run);
  // keep the chain alive regardless of this call's outcome
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const hashKey = (s: string) =>
  createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Read-through disk cache. Writes are atomic (tmp + rename) so a crash mid-write
 *  can never poison the cache with truncated JSON. */
export async function cached<T>(
  namespace: string,
  key: string,
  produce: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const file = path.join(CACHE_DIR, namespace, `${key}.json`);
  try {
    return { value: JSON.parse(await readFile(file, "utf8")) as T, hit: true };
  } catch {
    /* miss or corrupt — regenerate */
  }
  const value = await produce();
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
  return { value, hit: false };
}
