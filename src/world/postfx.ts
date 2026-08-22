// ---------------------------------------------------------------------------
// Homeground — tilt-shift post pass.
//
// Screen-space, not depth-based: a horizontal band stays sharp and everything
// above/below it blurs out. That is exactly how real tilt-shift miniature fakes
// work, and unlike a depth-of-field it costs one blur and cannot shimmer on
// thin geometry. Add a soft vignette and a whisper of warm grade on top.
//
// This module is loaded DYNAMICALLY (see index.ts) because it pulls in
// `three/webgpu`, which must never be imported in a headless context.
// ---------------------------------------------------------------------------

import { RenderPipeline } from "three/webgpu";
import { dot, float, luminance, mix, pass, pow, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from "three/tsl";
import { gaussianBlur } from "three/addons/tsl/display/GaussianBlurNode.js";
import type { Camera, Scene, WebGPURenderer } from "three/webgpu";

export interface PostFX {
  /** Call instead of renderer.render(scene, camera). Resizes with the renderer. */
  render(): void;
  /** Screen-space Y of the sharp band, 0 (top) .. 1 (bottom). Default 0.6.
   *  Narrow the band and the frame reads as a scale model; widen it and it
   *  reads as a street. The intro sweeps between the two. */
  setFocus(y: number, halfWidth?: number, falloff?: number): void;
  /** Film grain amount, 0..0.06. */
  setGrain(v: number): void;
  dispose(): void;
}

export function createPostFX(renderer: WebGPURenderer, scene: Scene, camera: Camera): PostFX {
  const focus = uniform(0.6);
  const inner = uniform(0.07);
  const outer = uniform(0.36);
  const grain = uniform(0.02);

  const scenePass = pass(scene, camera);
  const blurred = gaussianBlur(scenePass, vec2(1, 1), 6, { resolutionScale: 0.4 });

  const d = screenUV.y.sub(focus).abs();
  const amount = smoothstep(inner, outer, d);
  const mixed = mix(scenePass, blurred, amount);

  // --- grade -------------------------------------------------------------
  // Everything below runs in linear light; outputColorTransform still owns
  // tone mapping. The point of the grade is the miniature read: real tilt-shift
  // photographs of cities are MORE saturated and MORE contrasty than the scene
  // in front of the lens, because that is what makes a real street look like a
  // painted model. A neutral pass-through is the thing that reads as "untuned".
  let c = mixed.rgb;

  // saturation, around perceptual luma so the warm sky doesn't go radioactive
  const luma = luminance(c);
  c = mix(vec3(luma), c, float(1.15));

  // filmic-ish S-curve: lift the toe a touch, roll the shoulder, keep midtones
  c = pow(c.max(vec3(0)), vec3(0.94)).mul(1.03);

  // split tone: cool the shadows toward the sky bounce, warm the highlights
  // toward the sun. Two multiplies — this is the cheapest colour-script there
  // is and it is most of what separates "a render" from "a photograph".
  const shadowW = smoothstep(0.42, 0.0, luma);
  const highW = smoothstep(0.34, 0.95, luma);
  c = c.mul(mix(vec3(1, 1, 1), vec3(0.94, 0.985, 1.09), shadowW));
  c = c.mul(mix(vec3(1, 1, 1), vec3(1.055, 1.005, 0.93), highW));

  // vignette
  const q = screenUV.sub(vec2(0.5, 0.5));
  const r2 = dot(q, q);
  const vig = smoothstep(0.62, 0.02, r2).mul(0.26).add(0.74);
  c = c.mul(vig);

  // A hair of static grain. Without it the flat sky and the flat tarmac both
  // band visibly on an 8-bit display, and banding is the one artefact that
  // instantly reads as "unfinished".
  const n = screenUV.mul(vec2(1237.5, 913.1));
  const noise = n.x.add(n.y).sin().mul(43758.5453).fract().sub(0.5);
  c = c.add(noise.mul(grain));

  const post = new RenderPipeline(renderer);
  post.outputNode = vec4(c, mixed.a);

  return {
    render() {
      post.render();
    },
    setFocus(y: number, halfWidth = 0.07, falloff = 0.36) {
      focus.value = y;
      inner.value = halfWidth;
      outer.value = Math.max(halfWidth + 0.02, falloff);
    },
    setGrain(v: number) {
      grain.value = v;
    },
    dispose() {
      post.dispose();
    },
  };
}
