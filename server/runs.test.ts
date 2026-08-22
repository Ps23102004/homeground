// Self-check for the run-finding heuristic. No framework: `npx tsx server/runs.test.ts`.
// Fails loudly if the scorer stops picking downhill, or starts inventing runs
// on flat ground.

import assert from "node:assert/strict";
import type { Heightfield, Road } from "./types.js";
import { findRuns, sampleTerrain } from "./runs.js";

const W = 11;
const SPACING = 100;
const HALF = ((W - 1) * SPACING) / 2; // 500m

/** grid whose elevation drops `perCol` meters for every step east (+X). */
function slope(perCol: number): Heightfield {
  const elevations: number[] = [];
  for (let row = 0; row < W; row++)
    for (let col = 0; col < W; col++) elevations.push(100 - col * perCol);
  return { width: W, depth: W, spacing: SPACING, originX: -HALF, originZ: -HALF, elevations };
}

const eastWestRoad: Road = {
  centerline: Array.from({ length: W }, (_, i) => ({ x: -HALF + i * SPACING, z: 0 })),
  widthMeters: 7,
  tag: "residential",
  osmTags: { highway: "residential" },
};

// -- bilinear sampling lines up with the grid ------------------------------
{
  const hf = slope(5);
  assert.equal(sampleTerrain(hf, -HALF, 0), 100);
  assert.equal(sampleTerrain(hf, -HALF + SPACING, 0), 95);
  assert.equal(sampleTerrain(hf, -HALF + SPACING / 2, 0), 97.5); // interpolated
  assert.equal(sampleTerrain(hf, HALF + 9999, 0), 50); // clamps, does not wrap
}

// -- finds the downhill direction on a 5% grade ----------------------------
{
  const runs = findRuns([eastWestRoad], slope(5), 5);
  assert.ok(runs.length >= 1, "expected a run on a 5% slope");
  const best = runs[0]!;
  // The graph deliberately excludes the outermost ring of the box, so the run
  // spans x = -400..400: 800m long, 40m of drop.
  assert.equal(best.spawn.x, -HALF + SPACING);
  assert.equal(best.elevationDrop, 40);
  assert.equal(best.lengthMeters, 800);
  assert.ok(Math.abs(best.avgGradient - 0.05) < 1e-6, `grad ${best.avgGradient}`);
  // yaw 0 = +X east, which is downhill here
  assert.ok(Math.abs(best.spawnYawRadians) < 0.01, `yaw ${best.spawnYawRadians}`);
  assert.ok(best.path.length >= 2 && best.path[0]!.x < best.path[1]!.x, "path runs east");
}

// -- perfectly flat ground: no *scored* run, but still a sane spawn --------
{
  const runs = findRuns([eastWestRoad], slope(0), 5);
  assert.equal(runs.length, 1, "flat terrain should fall back to one spawn candidate");
  assert.equal(runs[0]!.elevationDrop, 0);
}

// -- uphill-only never wins ------------------------------------------------
{
  const runs = findRuns([eastWestRoad], slope(5), 5);
  assert.ok(runs.every((r) => r.elevationDrop >= 0), "a run must never gain elevation");
}

console.log("runs.test.ts: all assertions passed");
