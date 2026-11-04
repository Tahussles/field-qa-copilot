// Visible words per page in the default state (nothing expanded, no remembered choices): what a reader sees
// scrolling a 1440x900 window from top to bottom (each text node counted once).
//
//   node --env-file=.env.local scripts/word-count.mjs [base URL] [--label before] [--theme poket]
//
// A word is a run of letters or digits in a text node a reader can see: rendered, not clipped away by a
// closed disclosure or a scroll box, not inert. Map labels drawn on the canvas do not count. /collect
// result submits one interview from the phone (a write), so the run ends with a demo reset. Writes
// data/screens/word-count-<label>.json and prints a table.
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { chromium } from "@playwright/test";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { label: { type: "string", default: "now" }, theme: { type: "string", default: "poket" } },
});
const base = positionals[0] ?? "https://field-qa-copilot.vercel.app";
const passcode = process.env.DEMO_PASSCODE;
if (!passcode) throw new Error("DEMO_PASSCODE is not set");

async function mint() {
  const r = await fetch(`${base}/api/py/collect/token`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-passcode": passcode },
    body: "{}",
  });
  return (await r.json()).path;
}

const ANSWERS = [3, 2, 3, 4, 2, 3, 4, 3];
const ITEMS = ["Reliability", "Distance", "Cost", "Water quality", "Waiting time", "Safety", "Opening hours", "Overall"];
const PAGES = [
  { name: "/", path: "/", ready: (p) => p.locator("[data-testid=stage-feed] .frow").first().waitFor({ timeout: 30_000 }) },
  { name: "/app", path: "/app", ready: (p) => p.locator("[data-map-ready=true]").waitFor({ timeout: 60_000 }) },
  {
    name: "/app/queue (E07)",
    path: "/app/queue?contributor=E07",
    ready: (p) => p.getByRole("button", { name: /Approve/ }).and(p.locator(":enabled")).first().waitFor({ timeout: 60_000 }),
  },
  { name: "/app/detectors", path: "/app/detectors", ready: (p) => p.getByTestId("combined-flagged").filter({ hasText: /\d/ }).waitFor({ timeout: 60_000 }) },
  { name: "/app/test", path: "/app/test", ready: (p) => p.getByRole("button", { name: /Send/ }).waitFor({ timeout: 30_000 }) },
  {
    name: "/collect form",
    path: mint,
    ready: async (p) => {
      await p.getByRole("button", { name: /^E03 / }).click();
      await p.getByTestId("submit").waitFor();
    },
  },
  {
    name: "/collect result",
    path: mint,
    writes: true,
    ready: async (p) => {
      await p.getByRole("button", { name: /^E03 / }).click();
      await p.getByTestId("source-piped_home").click();
      for (const [i, item] of ITEMS.entries()) await p.getByRole("radio", { name: `${item} ${ANSWERS[i]}` }).click();
      await p.getByPlaceholder("In the respondent's words").fill("Water only comes some days, so planning the week is hard.");
      await p.getByTestId("submit").click();
      await p.getByTestId("band").first().waitFor({ timeout: 30_000 });
      await p.waitForTimeout(4000); // the final score lands
    },
  },
  { name: "/architecture", path: "/architecture", ready: (p) => p.getByTestId("architecture").filter({ hasNotText: "…" }).waitFor({ timeout: 30_000 }) },
];

/** In the page: the words a reader can see, scrolling a 1440x900 window from top to bottom. */
async function countWords() {
  const seen = new Set();
  const sample = [];
  let words = 0;
  const visible = (rect, el) => {
    let r = { x0: rect.left, y0: Math.max(rect.top, 0), x1: rect.right, y1: Math.min(rect.bottom, window.innerHeight) };
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      if (a.inert) return false;
      const s = getComputedStyle(a);
      if (s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
      // An element's own overflow clips its text too (a screen-reader-only label is a 1px box).
      if (/(hidden|auto|scroll|clip)/.test(s.overflow + s.overflowX + s.overflowY)) {
        const b = a.getBoundingClientRect();
        r = { x0: Math.max(r.x0, b.left), y0: Math.max(r.y0, b.top), x1: Math.min(r.x1, b.right), y1: Math.min(r.y1, b.bottom) };
      }
    }
    return r.x1 - r.x0 >= 2 && r.y1 - r.y0 >= 2;
  };
  const collect = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (seen.has(node)) continue;
      const el = node.parentElement;
      if (!el || el.closest("script, style, noscript, option, title, [hidden]")) continue;
      const n = (node.textContent.match(/[\p{L}\p{N}][\p{L}\p{N}'’.,:%/-]*/gu) ?? []).length;
      if (!n) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some((rect) => visible(rect, el))) continue;
      seen.add(node);
      words += n;
      if (sample.length < 400) sample.push(node.textContent.replace(/\s+/g, " ").trim());
    }
  };
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  for (let y = 0; ; y += window.innerHeight - 100) {
    window.scrollTo(0, y);
    await frame();
    collect();
    if (y + window.innerHeight >= document.documentElement.scrollHeight) break;
  }
  window.scrollTo(0, 0);
  return { words, sample };
}

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
let wrote = false;
for (const page of PAGES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ({ code, theme }) => {
      localStorage.setItem("fqc-demo-passcode", code);
      localStorage.setItem("fqc-theme", theme);
      for (const k of Object.keys(localStorage)) if (k.startsWith("fqc-ui-") || k === "fqc-demo-script") localStorage.removeItem(k);
    },
    { code: passcode, theme: values.theme },
  );
  const p = await ctx.newPage();
  const path = typeof page.path === "function" ? await page.path() : page.path;
  await p.goto(base + path, { waitUntil: "domcontentloaded" });
  await page.ready(p);
  wrote ||= Boolean(page.writes);
  await p.waitForTimeout(1500);
  const { words, sample } = await p.evaluate(countWords);
  results.push({ page: page.name, words, sample });
  console.log(`${page.name.padEnd(20)} ${String(words).padStart(5)} words`);
  await ctx.close();
}
await browser.close();
if (wrote) {
  const r = await fetch(`${base}/api/py/demo/reset`, { method: "POST", headers: { "x-demo-passcode": passcode } });
  console.log(`demo reset after the phone result: HTTP ${r.status}`);
}
mkdirSync("data/screens", { recursive: true });
const out = `data/screens/word-count-${values.label}.json`;
writeFileSync(out, JSON.stringify({ base, label: values.label, theme: values.theme, at: new Date().toISOString(), results }, null, 1));
console.log(`total ${results.reduce((s, r) => s + r.words, 0)} words · ${out}`);
