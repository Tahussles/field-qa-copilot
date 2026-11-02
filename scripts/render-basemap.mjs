// Pre-renders the landing page's stage map, so the landing page never loads MapLibre:
// the OpenFreeMap dark style recoloured by lib/basemap.ts (the same palette as the
// dashboard map), fitted to the survey areas, saved as public/landing/basemap.webp.
// public/landing/basemap.json holds the image's bounds and the area outlines; the
// landing page projects points onto the image with them and draws on a canvas.
//
//   node scripts/render-basemap.mjs                     # areas from production
//   node scripts/render-basemap.mjs --api http://localhost:3000
//
// Re-run only when the areas or the palette change; both outputs are committed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";

import { STYLE_URL, tuneBasemap } from "../lib/basemap.ts";

const { values } = parseArgs({ options: { api: { type: "string", default: "https://field-qa-copilot.vercel.app" } } });
const WIDTH = 960;
const HEIGHT = 600;
const SCALE = 2; // device pixels per CSS pixel in the image
const PADDING = 30;
const QUALITY = 0.8;

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = join(import.meta.dirname, "..", "public", "landing");
const ORIGIN = "http://basemap.render";
const TYPES = { ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html" };

const { areas } = await (await fetch(`${values.api}/api/py/map`)).json();
const rings = areas.filter((a) => a.boundary).map((a) => ({ name: a.name, ring: a.boundary.coordinates[0] }));
const lngs = rings.flatMap((a) => a.ring.map((c) => c[0]));
const lats = rings.flatMap((a) => a.ring.map((c) => c[1]));
const extent = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE });
await page.route(`${ORIGIN}/**`, (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") {
    return route.fulfill({
      contentType: TYPES[".html"],
      body: `<!doctype html><link rel="stylesheet" href="/maplibre-gl.css">
<style>html,body{margin:0;background:#0b0c0f}#map{width:${WIDTH}px;height:${HEIGHT}px}</style>
<div id="map"></div>
<script type="module">import * as ml from "/maplibre-gl.mjs"; window.maplibregl = ml;</script>`,
    });
  }
  return route.fulfill({ contentType: TYPES[extname(path)] ?? "application/octet-stream", body: readFileSync(join(dist, path)) });
});
await page.goto(`${ORIGIN}/`);
await page.waitForFunction(() => window.maplibregl);

const view = await page.evaluate(
  async ({ style, extent, padding, tune, origin }) => {
    const ml = window.maplibregl;
    ml.setWorkerUrl(`${origin}/maplibre-gl-worker.mjs`);
    const map = new ml.Map({
      container: "map",
      style,
      bounds: extent,
      fitBoundsOptions: { padding },
      attributionControl: false,
      interactive: false,
      fadeDuration: 0,
    });
    await new Promise((resolve) => map.once("load", resolve));
    new Function("map", `(${tune})(map)`)(map);
    await new Promise((resolve) => map.once("idle", resolve));
    const b = map.getBounds();
    // The tile source's own credit line (from its TileJSON), shown on the landing stage.
    const attribution = [...new Set(Object.keys(map.getStyle().sources).map((id) => map.getSource(id)?.attribution))]
      .filter(Boolean)
      .join(" ");
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth(), zoom: map.getZoom(), attribution };
  },
  { style: STYLE_URL, extent, padding: PADDING, tune: tuneBasemap.toString(), origin: ORIGIN },
);

// Screenshot the map, then let the browser encode it as WebP.
const png = await page.locator("#map").screenshot({ type: "png" });
const webp = await page.evaluate(async ({ data, quality }) => {
  const image = new Image();
  image.src = `data:image/png;base64,${data}`;
  await image.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas.toDataURL("image/webp", quality).split(",")[1];
}, { data: png.toString("base64"), quality: QUALITY });
await browser.close();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "basemap.webp"), Buffer.from(webp, "base64"));
const round = (n) => Math.round(n * 1e6) / 1e6;
writeFileSync(
  join(out, "basemap.json"),
  JSON.stringify(
    {
      width: WIDTH,
      height: HEIGHT,
      bounds: { west: round(view.west), south: round(view.south), east: round(view.east), north: round(view.north) },
      zoom: Math.round(view.zoom * 100) / 100,
      attribution: view.attribution,
      areas: rings.map((a) => ({ name: a.name, ring: a.ring })),
    },
    null,
    2,
  ) + "\n",
);
console.log(`basemap.webp ${Math.round(Buffer.from(webp, "base64").length / 1024)} KB at zoom ${view.zoom.toFixed(2)}; bounds and areas in basemap.json`);
