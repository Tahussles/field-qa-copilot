// Copies the MapLibre worker into public/ so the browser can load it from a
// stable URL. MapLibre 6 resolves its worker next to its own module, which a
// bundler moves, so the map calls setWorkerUrl("/vendor/maplibre-gl-worker.mjs").
// Runs before `next dev` and `next build` (not on install: Vercel can restore
// node_modules from its build cache and skip install scripts). The copy is gitignored.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = join(import.meta.dirname, "..", "public", "vendor");
mkdirSync(out, { recursive: true });
copyFileSync(join(dist, "maplibre-gl-worker.mjs"), join(out, "maplibre-gl-worker.mjs"));
console.log("vendored maplibre-gl-worker.mjs into public/vendor/");
