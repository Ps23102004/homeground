/**
 * Guards the one look-dev bug that is invisible until you look at a screenshot:
 * a shadow camera whose projection matrix was never rebuilt. Three's
 * LightShadow.updateMatrices consumes shadow.camera.projectionMatrix as-is, so
 * setting .left/.right/.far without updateProjectionMatrix() leaves the
 * DirectionalLightShadow default (10 x 10 m, far 500) in force and the whole
 * scene renders with no cast shadows and no error.
 *
 *   npx tsx src/world/lookdev.test.ts
 */

import { Scene, Vector3 } from "three";
import { createLookDev } from "./lookdev.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok  ${msg}`);
}

const scene = new Scene();
const look = createLookDev(scene, { radiusMeters: 1000, shadowExtent: 170 });
const cam = look.sun.shadow.camera;

// Unproject the ortho frustum corners to recover what the matrix ACTUALLY says,
// rather than trusting the properties we set on it.
const half = new Vector3(1, 1, 0).unproject(cam);
assert(
  Math.abs(half.x) > 100,
  `shadow frustum half-width is ${Math.abs(half.x).toFixed(0)} m, not the 5 m default`,
);

// Every caster has to sit between near and far, and the light is SUN_DISTANCE away.
const lightDist = look.sun.position.length();
assert(
  cam.far > lightDist,
  `shadow far (${cam.far}) reaches past the light at ${lightDist.toFixed(0)} m`,
);

// focusShadow must move the light AND keep it the same distance/direction.
const before = look.sun.position.clone().normalize();
look.focusShadow(300, 40, -120);
const after = look.sun.position.clone().sub(new Vector3(300, 40, -120)).normalize();
assert(before.dot(after) > 0.999, "focusShadow re-centres the frustum without rotating the sun");

look.dispose();
console.log("\nlookdev.test.ts: all assertions passed");
