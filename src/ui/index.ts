/**
 * Homeground UI shell.
 *
 * One overlay element covers the viewport above the 3D canvas. It is
 * `pointer-events: none` by default so the game always gets input; only
 * genuinely interactive controls opt back in.
 *
 * Wiring for main.ts:
 *
 *   const ui = createUI(document.getElementById("app")!, {
 *     onSubmit: (address) => start(address),
 *     onRestart: () => { teardownWorld(); ui.showLanding(); },
 *   });
 *
 *   ui.showLoading("Filbert St, San Francisco");
 *   ui.setStage("terrain");
 *   ui.enterGame({ lat, lon, addr });
 *   ui.setSpeed(kmh);           // safe to call every frame
 */

import type { ShareState } from "../types.js";
import { createContourField } from "./contours.js";

export type LoadingStage = "geocode" | "terrain" | "buildings" | "run";

export type ErrorKind =
  | "not-found"     // geocoder returned nothing
  | "upstream"      // Overpass / Nominatim / elevation source failed or rate-limited
  | "no-buildings"  // geodata fine, but the box is empty (rural)
  | "no-webgl"      // browser can render neither WebGPU nor WebGL2
  | "unknown";

export interface UIOptions {
  onSubmit: (address: string) => void;
  /** Called when the player asks to go back to the address field. */
  onRestart?: () => void;
}

export interface UI {
  showLanding(prefill?: string): void;
  showLoading(placeLabel: string): void;
  /** Marks every earlier stage done and this one active. `note` is optional data, e.g. "1,284 buildings". */
  setStage(stage: LoadingStage, note?: string): void;
  showError(kind: ErrorKind, detail?: string): void;
  /** Hide the overlay panels, reveal the HUD, arm the share link. */
  enterGame(share: ShareState): void;
  /** Cheap enough to call from the render loop — only writes on a changed integer. */
  setSpeed(kmh: number): void;
  /** Transient bottom-left message, e.g. the WebGL2 fallback explanation. */
  notice(text: string): void;
  destroy(): void;
}

const STAGES: ReadonlyArray<{ id: LoadingStage; label: string }> = [
  { id: "geocode", label: "Finding the place" },
  { id: "terrain", label: "Reading the ground" },
  { id: "buildings", label: "Raising the buildings" },
  { id: "run", label: "Picking your run" },
];

/** Real streets with real grades. They teach what the product is for. */
const SUGGESTIONS: ReadonlyArray<{ query: string; grade: string }> = [
  { query: "Canton Ave, Pittsburgh", grade: "37%" },
  { query: "Baldwin St, Dunedin", grade: "35%" },
  { query: "Filbert St, San Francisco", grade: "31%" },
];

const ERRORS: Record<ErrorKind, { label: string; title: string; body: string }> = {
  "not-found": {
    label: "No match",
    title: "That address isn't on the map.",
    body: "Open map data spells some places differently. Add the city, or try a nearby cross street.",
  },
  upstream: {
    label: "Source offline",
    title: "The map data source isn't answering.",
    body: "Homeground reads OpenStreetMap's public API, which is free, shared, and sometimes busy. Give it a minute and try again — the same address will load instantly once it's cached.",
  },
  "no-buildings": {
    label: "Empty tile",
    title: "Nothing is built here.",
    body: "There are no buildings mapped within a kilometre of this point — usually farmland, desert, or open water. Try a street inside a town.",
  },
  "no-webgl": {
    label: "Unsupported browser",
    title: "This browser can't draw the world.",
    body: "Homeground renders with WebGPU and falls back to WebGL2. This browser has neither. Chrome, Edge, or Safari 17 and up will run it.",
  },
  unknown: {
    label: "Error",
    title: "Something broke on the way here.",
    body: "The world didn't finish building. Try that address again.",
  },
};

const ARROW =
  '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h11m0 0L9 3.5M13.5 8L9 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function createUI(root: HTMLElement, opts: UIOptions): UI {
  const el = document.createElement("div");
  el.className = "hg";
  el.dataset.view = "landing";
  el.innerHTML = `
    <canvas class="hg-contours" aria-hidden="true"></canvas>

    <header class="hg-top">
      <button class="hg-mark" type="button">Homeground</button>
      <div class="hg-place">
        <span class="hg-place-name"></span>
        <button class="hg-share" type="button">Copy link</button>
      </div>
    </header>

    <div class="hg-stage">
      <section class="hg-panel hg-panel--landing" data-on="1">
        <h1 class="hg-display">Ride your<br><em>own</em> street.</h1>
        <p class="hg-lead">Type an address. Homeground rebuilds that block from open map data, finds the steepest run within a kilometre, and drops you at the top of it on a longboard.</p>
        <form class="hg-field" novalidate>
          <input class="hg-input" type="text" name="address" autocomplete="street-address"
                 autocapitalize="words" spellcheck="false" enterkeyhint="go"
                 aria-label="Street address"
                 placeholder="1234 Filbert St, San Francisco">
          <button class="hg-go" type="submit" aria-label="Build this place" disabled>${ARROW}</button>
        </form>
        <ul class="hg-suggest">
          ${SUGGESTIONS.map(
            (s) =>
              `<li><button class="hg-chip" type="button" data-q="${s.query}">${s.query} <b>${s.grade}</b></button></li>`,
          ).join("")}
        </ul>
      </section>

      <section class="hg-panel hg-panel--loading" aria-live="polite">
        <p class="hg-label">Building</p>
        <h2 class="hg-title hg-loading-name"></h2>
        <ol class="hg-stages">
          ${STAGES.map(
            (s) =>
              `<li class="hg-stage-row" data-stage="${s.id}" data-state="idle"><span>${s.label}</span><span class="hg-stage-note"></span></li>`,
          ).join("")}
        </ol>
      </section>

      <section class="hg-panel hg-panel--error" role="alert">
        <p class="hg-label hg-error-label"></p>
        <h2 class="hg-title hg-error-title"></h2>
        <p class="hg-body"><span class="hg-error-body"></span><code class="hg-detail"></code></p>
        <button class="hg-btn hg-retry" type="button">Try another address</button>
      </section>
    </div>

    <footer class="hg-bottom">
      <div class="hg-speed" aria-label="Speed">
        <span class="hg-speed-value">0</span><span class="hg-speed-unit">km/h</span>
      </div>
    </footer>

    <div class="hg-notice" role="status"></div>

    <p class="hg-credit">Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL) &middot; elevation <a href="https://www.opentopodata.org/" target="_blank" rel="noopener">OpenTopoData</a> (USGS 3DEP / NASA SRTM)</p>
  `;
  root.appendChild(el);

  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;

  const canvas = q<HTMLCanvasElement>(".hg-contours");
  const form = q<HTMLFormElement>(".hg-field");
  const input = q<HTMLInputElement>(".hg-input");
  const go = q<HTMLButtonElement>(".hg-go");
  const mark = q<HTMLButtonElement>(".hg-mark");
  const share = q<HTMLButtonElement>(".hg-share");
  const placeName = q<HTMLSpanElement>(".hg-place-name");
  const loadingName = q<HTMLElement>(".hg-loading-name");
  const speedValue = q<HTMLElement>(".hg-speed-value");
  const noticeEl = q<HTMLElement>(".hg-notice");
  const panels: Record<string, HTMLElement> = {
    landing: q(".hg-panel--landing"),
    loading: q(".hg-panel--loading"),
    error: q(".hg-panel--error"),
  };

  const contours = createContourField(canvas);

  let shareState: ShareState | null = null;
  let lastSpeed = -1;
  let noticeTimer = 0;
  let leaveTimer = 0;
  let copyTimer = 0;

  /**
   * Swap panels with a real cross-fade: the outgoing one keeps rendering under
   * `data-leaving` while its exit animation plays, then is dropped on a
   * wall-clock timer (setTimeout keeps running in a background tab; an
   * animationend listener would not fire there at all).
   */
  function show(panel: "landing" | "loading" | "error" | "game") {
    for (const [name, node] of Object.entries(panels)) {
      if (name === panel) {
        node.dataset.on = "1";
        delete node.dataset.leaving;
      } else {
        if (node.dataset.on) node.dataset.leaving = "1";
        delete node.dataset.on;
      }
    }
    window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(() => {
      for (const node of Object.values(panels)) {
        if (!node.dataset.on) delete node.dataset.leaving;
      }
    }, 420);
    el.dataset.view = panel;
    contours.fade(panel === "game" ? 0 : 1);
    if (panel !== "game") contours.setFocus(panel === "loading" ? 1 : 0);
  }

  function submit(address: string) {
    const value = address.trim();
    if (!value) return;
    input.value = value;
    opts.onSubmit(value);
  }

  input.addEventListener("input", () => {
    go.disabled = input.value.trim().length === 0;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(input.value);
  });

  el.querySelectorAll<HTMLButtonElement>(".hg-chip").forEach((chip) => {
    chip.addEventListener("click", () => submit(chip.dataset.q ?? ""));
  });

  // Both ways out of a place — the wordmark/Escape and "try another address" —
  // go through onRestart, which is the one owner of teardown AND of clearing
  // the share params. Routing retry straight to showLanding instead left a
  // stale ?lat= in the bar that reloaded back into the error just dismissed.
  // showLanding itself must stay side-effect free: it also runs at construction
  // time to prefill the field, before main.ts has read the share link.
  const leave = () => {
    if (opts.onRestart) opts.onRestart();
    else api.showLanding();
  };

  q<HTMLButtonElement>(".hg-retry").addEventListener("click", leave);

  mark.addEventListener("click", () => {
    if (el.dataset.view === "game") leave();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && el.dataset.view === "game") leave();
  });

  share.addEventListener("click", async () => {
    if (!shareState) return;
    const url = shareLink(shareState);
    try {
      await navigator.clipboard.writeText(url);
      share.textContent = "Link copied";
      share.dataset.copied = "1";
      window.clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => {
        share.textContent = "Copy link";
        delete share.dataset.copied;
      }, 1900);
    } catch {
      api.notice(`Copy this link: ${url}`);
    }
  });

  const api: UI = {
    showLanding(prefill) {
      if (prefill !== undefined) input.value = prefill;
      go.disabled = input.value.trim().length === 0;
      shareState = null;
      lastSpeed = -1;
      speedValue.textContent = "0";
      show("landing");
      input.focus({ preventScroll: true });
    },

    showLoading(placeLabel) {
      loadingName.textContent = placeLabel;
      el.querySelectorAll<HTMLElement>(".hg-stage-row").forEach((row) => {
        row.dataset.state = "idle";
        (row.querySelector(".hg-stage-note") as HTMLElement).textContent = "";
      });
      show("loading");
      api.setStage("geocode");
    },

    setStage(stage, note) {
      const at = STAGES.findIndex((s) => s.id === stage);
      if (at < 0) return;
      STAGES.forEach((s, i) => {
        const row = el.querySelector<HTMLElement>(`.hg-stage-row[data-stage="${s.id}"]`);
        if (!row) return;
        row.dataset.state = i < at ? "done" : i === at ? "active" : "idle";
        if (i === at && note) {
          (row.querySelector(".hg-stage-note") as HTMLElement).textContent = note;
        }
      });
    },

    showError(kind, detail) {
      const copy = ERRORS[kind] ?? ERRORS.unknown;
      q(".hg-error-label").textContent = copy.label;
      q(".hg-error-title").textContent = copy.title;
      q(".hg-error-body").textContent = copy.body;
      q(".hg-detail").textContent = detail ?? "";
      show("error");
    },

    enterGame(state) {
      shareState = state;
      placeName.textContent = state.addr;
      share.textContent = "Copy link";
      delete share.dataset.copied;
      show("game");
      history.replaceState(null, "", shareLink(state));
    },

    setSpeed(kmh) {
      const v = Math.max(0, Math.round(kmh));
      if (v === lastSpeed) return;
      lastSpeed = v;
      speedValue.textContent = String(v);
    },

    notice(text) {
      noticeEl.textContent = text;
      noticeEl.dataset.on = "1";
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => delete noticeEl.dataset.on, 7000);
    },

    destroy() {
      contours.stop();
      window.clearTimeout(noticeTimer);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(copyTimer);
      el.remove();
    },
  };

  api.showLanding(readShareState()?.addr);
  return api;
}

/** Build the shareable `?lat=&lon=&addr=` link for a place. */
export function shareLink(state: ShareState): string {
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({
    lat: state.lat.toFixed(6),
    lon: state.lon.toFixed(6),
    addr: state.addr,
  }).toString();
  return url.toString();
}

/** Read `?lat=&lon=&addr=` back off the current URL, or null if absent/invalid. */
export function readShareState(): ShareState | null {
  const p = new URLSearchParams(window.location.search);
  const rawLat = p.get("lat");
  const rawLon = p.get("lon");
  // Number(null) and Number("") are both 0, which would "restore" 0,0 — the
  // Gulf of Guinea — on every bare visit. Demand the params actually exist.
  if (rawLat === null || rawLat.trim() === "" || rawLon === null || rawLon.trim() === "")
    return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, addr: p.get("addr") ?? "" };
}
