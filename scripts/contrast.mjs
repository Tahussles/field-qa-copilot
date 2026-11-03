// Contrast check against what is actually behind each piece of text, glass included.
//
//   node --env-file=.env.local scripts/contrast.mjs [base URL] [--theme poket|linear] [--result]
//
// For each page state it records every visible text run (its colour, with ancestor opacity, its
// size and weight), then hides all text, screenshots the page and measures each run's colour
// against the pixels under it: the 5th-percentile ratio must reach WCAG AA (4.5:1, or 3:1 for
// text of 24px+ or bold 18.66px+). Disabled controls are exempt, as in WCAG. Text covered by
// another element is skipped. --result also submits one interview from the phone (a write) to
// check its result screen, then resets the demo. Writes data/screens/contrast-<theme>.json and
// exits 1 on any failure.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { chromium, devices } from "@playwright/test";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { theme: { type: "string", default: "poket" }, result: { type: "boolean", default: false } },
});
const base = positionals[0] ?? "https://field-qa-copilot.vercel.app";
const passcode = process.env.DEMO_PASSCODE;
if (!passcode) throw new Error("DEMO_PASSCODE is not set");

const DESKTOP = { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
const PHONE = { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 };

async function mint() {
  const r = await fetch(`${base}/api/py/collect/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-passcode": passcode },
    body: "{}",
  });
  if (!r.ok) throw new Error(`collect token: HTTP ${r.status}`);
  return (await r.json()).path;
}

const STATES = [
  { name: "/ (landing)", device: DESKTOP, path: "/", ready: (p) => p.locator("[data-testid=stage-feed] .frow").first().waitFor() },
  {
    name: "/app (E07 hotspot open)",
    device: DESKTOP,
    path: "/app?beat=hotspot&code=E07",
    ready: async (p) => {
      await p.locator("[data-map-ready=true]").waitFor({ timeout: 30_000 });
      await p.getByRole("dialog", { name: "Hotspot for E07" }).waitFor({ timeout: 20_000 });
    },
  },
  {
    name: "/app (demo panel, Script tab)",
    device: DESKTOP,
    path: "/app",
    ready: async (p) => {
      await p.locator("[data-map-ready=true]").waitFor({ timeout: 30_000 });
      await p.keyboard.press("d");
      await p.getByRole("tab", { name: "Script" }).click();
    },
  },
  {
    name: "/app/queue (E07 evidence)",
    device: DESKTOP,
    path: "/app/queue?contributor=E07",
    ready: (p) => p.getByRole("button", { name: "Approve as genuine" }).and(p.locator(":enabled")).waitFor({ timeout: 30_000 }),
  },
  { name: "/app/detectors", device: DESKTOP, path: "/app/detectors", ready: (p) => p.getByRole("region", { name: "Tune the detectors" }).waitFor() },
  { name: "/architecture", device: DESKTOP, path: "/architecture", ready: (p) => p.getByTestId("architecture").filter({ hasNotText: "…" }).waitFor() },
  { name: "/pitch (slide 4)", device: DESKTOP, path: "/pitch#4", ready: (p) => p.getByTestId("proof").filter({ hasNotText: "…" }).waitFor() },
  { name: "/collect (contributors)", device: PHONE, path: mint, ready: (p) => p.getByRole("button", { name: /^E03 / }).waitFor({ timeout: 30_000 }) },
  {
    name: "/collect (form)",
    device: PHONE,
    path: mint,
    ready: async (p) => {
      await p.getByRole("button", { name: /^E03 / }).click();
      await p.getByTestId("source-piped_home").click();
    },
  },
];
if (values.result) {
  STATES.push({
    name: "/collect (result)",
    device: PHONE,
    path: mint,
    writes: true,
    ready: async (p) => {
      await p.getByRole("button", { name: /^E03 / }).click();
      await p.getByTestId("source-piped_home").click();
      for (const item of ["Reliability", "Distance", "Cost", "Water quality", "Waiting time", "Safety", "Opening hours", "Overall"]) {
        await p.getByRole("radio", { name: `${item} 3` }).click();
      }
      await p.getByTestId("submit").click();
      await p.getByRole("region", { name: "Rules result" }).getByTestId("band").waitFor({ timeout: 30_000 });
    },
  });
}

/** In the page: every visible text run with its colour and size. */
function collectText() {
  const parse = (() => {
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    return (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
  })();
  const clip = (rect, el) => {
    let r = { x0: rect.left, y0: rect.top, x1: rect.right, y1: rect.bottom };
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (/(hidden|auto|scroll|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
        const b = a.getBoundingClientRect();
        r = { x0: Math.max(r.x0, b.left), y0: Math.max(r.y0, b.top), x1: Math.min(r.x1, b.right), y1: Math.min(r.y1, b.bottom) };
      }
    }
    return r.x1 - r.x0 >= 2 && r.y1 - r.y0 >= 2 ? r : null;
  };
  const items = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    const el = node.parentElement;
    if (!text || !el || el.closest("script, style, noscript, option, title")) continue;
    const s = getComputedStyle(el);
    if (s.visibility !== "visible") continue;
    let opacity = 1;
    for (let a = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    if (opacity < 0.05) continue;
    const svg = el instanceof SVGElement;
    const fg = parse(svg ? s.fill : s.color);
    fg[3] *= opacity * (svg ? Number(s.fillOpacity) : 1);
    if (fg[3] < 0.02) {
      items.push({ text: text.slice(0, 60), skipped: "transparent text (gradient fill)" });
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = [...range.getClientRects()]
      .map((r) => clip(r, el))
      .filter(Boolean)
      .filter((r) => {
        // Skip text covered by another element (pointer events are forced on during this pass).
        const hit = document.elementFromPoint((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);
        return hit && (hit === el || el.contains(hit) || hit.contains(el));
      });
    if (!rects.length) continue;
    const size = parseFloat(s.fontSize);
    const weight = Number(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const exempt = Boolean(el.closest("button:disabled, input:disabled, select:disabled, [aria-disabled=true], fieldset:disabled"));
    const where = [el, el.parentElement, el.parentElement?.parentElement]
      .filter(Boolean)
      .map((e) => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : ""))
      .join(" < ");
    items.push({ text: text.slice(0, 60), fg, size, weight, need: large ? 3 : 4.5, exempt, where, rects });
  }
  return items;
}

/** In a blank page: each run's 5th-percentile and minimum ratio against the text-free screenshot. */
async function measure({ png, items }) {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return items.map((it) => {
    if (it.skipped) return it;
    const [fr, fg, fb, fa] = it.fg;
    const ratios = [];
    for (const r of it.rects) {
      for (let y = Math.max(0, Math.floor(r.y0)); y < Math.min(img.height, Math.ceil(r.y1)); y++) {
        for (let x = Math.max(0, Math.floor(r.x0)); x < Math.min(img.width, Math.ceil(r.x1)); x++) {
          const i = (y * img.width + x) * 4;
          const [br, bg, bb] = [data[i], data[i + 1], data[i + 2]];
          // The text's colour as drawn over this pixel (alpha and opacity composited).
          const lt = lum(fa * fr + (1 - fa) * br, fa * fg + (1 - fa) * bg, fa * fb + (1 - fa) * bb);
          const lb = lum(br, bg, bb);
          ratios.push({ v: (Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05), bg: hex(br, bg, bb) });
        }
      }
    }
    if (!ratios.length) return { ...it, skipped: "off screen" };
    ratios.sort((a, b) => a.v - b.v);
    const p5 = ratios[Math.floor(ratios.length * 0.05)];
    const { rects, ...rest } = it;
    return { ...rest, boxes: rects.length, ratio: Math.round(p5.v * 100) / 100, min: Math.round(ratios[0].v * 100) / 100, bg: p5.bg, fgHex: hex(fr, fg, fb) + (fa < 0.995 ? ` @${fa.toFixed(2)}` : "") };
  });
}

const HIDE_TEXT = `*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; transition: none !important; }
  svg text, svg tspan { fill: transparent !important; }`;

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const blank = await browser.newPage();
const report = { base, theme: values.theme, at: new Date().toISOString(), pages: [] };
let failures = 0;
let wrote = false;
for (const state of STATES) {
  const ctx = await browser.newContext(state.device);
  await ctx.addInitScript(
    ({ code, theme }) => {
      localStorage.setItem("fqc-demo-passcode", code);
      localStorage.setItem("fqc-theme", theme);
      localStorage.removeItem("fqc-demo-script");
    },
    { code: passcode, theme: values.theme },
  );
  const page = await ctx.newPage();
  const path = typeof state.path === "function" ? await state.path() : state.path;
  await page.goto(base + path, { waitUntil: "domcontentloaded" });
  await state.ready(page);
  wrote ||= Boolean(state.writes);
  // Let the page grow to its full height, so everything is measured in one screenshot.
  const height = await page.evaluate(() => Math.min(6000, Math.max(document.documentElement.scrollHeight, window.innerHeight)));
  await page.setViewportSize({ width: state.device.viewport.width, height });
  await page.waitForTimeout(2500); // fonts, tiles and the map's fade after the resize
  await page.addStyleTag({ content: "* { pointer-events: auto !important; }" }).then((h) => h.evaluate((n) => n.setAttribute("id", "fqc-pe")));
  const items = await page.evaluate(collectText);
  await page.evaluate(() => document.getElementById("fqc-pe")?.remove());
  const hide = await page.addStyleTag({ content: HIDE_TEXT });
  await page.waitForTimeout(300);
  const png = (await page.screenshot({ type: "png" })).toString("base64");
  await hide.evaluate((n) => n.remove());
  const results = await blank.evaluate(measure, { png, items });
  const checked = results.filter((r) => !r.skipped && !r.exempt);
  const failed = checked.filter((r) => r.ratio < r.need);
  failures += failed.length;
  const worst = checked.reduce((a, b) => (!a || b.ratio / b.need < a.ratio / a.need ? b : a), null);
  report.pages.push({ name: state.name, checked: checked.length, exempt: results.filter((r) => r.exempt).length, failed, worst, all: results });
  console.log(
    `${failed.length ? "✗" : "✓"} ${state.name.padEnd(32)} ${String(checked.length).padStart(4)} text runs` +
      (worst ? ` · lowest ${worst.ratio}:1 (needs ${worst.need}) "${worst.text.slice(0, 32)}"` : ""),
  );
  for (const f of failed) console.log(`    ${f.ratio}:1 < ${f.need}  "${f.text}"  ${f.fgHex} on ${f.bg}  ${f.size}px/${f.weight}  ${f.where}`);
  await ctx.close();
}
await browser.close();
if (wrote) {
  const r = await fetch(`${base}/api/py/demo/reset`, { method: "POST", headers: { "x-demo-passcode": passcode } });
  console.log(`demo reset after the phone result: HTTP ${r.status}`);
}
mkdirSync("data/screens", { recursive: true });
writeFileSync(`data/screens/contrast-${values.theme}.json`, JSON.stringify(report, null, 1));
console.log(`\n${failures ? `${failures} below AA` : "all text passes AA"} · ${values.theme} theme · ${base} · data/screens/contrast-${values.theme}.json`);
process.exit(failures ? 1 : 0);
