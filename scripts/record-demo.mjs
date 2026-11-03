// The backup recording of the demo, and a timed dry run of it, on production at 1920x1080.
//
//   node --env-file=.env.local scripts/record-demo.mjs [base URL]
//
// Landing → brief → E07 hotspot → queue decisions with keys → detectors threshold drag → a phone
// contradiction (mobile size, the transcript and the verdict arriving) → /architecture, driven through the
// demo panel's Script tab where it can be. Saves data/recordings/demo.mp4 (gitignored; ffmpeg turns
// Playwright's webm into mp4), prints each beat's start time and how long it took to be ready (lags over
// 2 s are marked), and resets the demo at the end. No narration.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "https://field-qa-copilot.vercel.app";
const passcode = process.env.DEMO_PASSCODE;
if (!passcode) throw new Error("DEMO_PASSCODE is not set");
const OUT = "data/recordings";
const VOICE = "tests-e2e/fixtures/pipe-dry.wav";
const SIZE = { width: 1920, height: 1080 };

mkdirSync(`${OUT}/raw`, { recursive: true });
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${VOICE}`,
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: `${OUT}/raw`, size: SIZE } });
await ctx.grantPermissions(["microphone"], { origin: base });
await ctx.addInitScript((code) => {
  window.localStorage.setItem("fqc-demo-passcode", code);
  window.localStorage.setItem("fqc-theme", "poket");
  window.localStorage.removeItem("fqc-demo-script");
}, passcode);
const page = await ctx.newPage();

const t0 = Date.now();
const beats = [];
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
async function beat(name, act, ready) {
  const start = Date.now();
  await act();
  await ready();
  const lag = Date.now() - start;
  beats.push({ name, at: start - t0, lag });
  console.log(`${clock(start - t0)}  ${name.padEnd(28)} ready in ${(lag / 1000).toFixed(1)} s${lag > 2000 ? "  <- over 2 s" : ""}`);
}
const pause = (s) => page.waitForTimeout(s * 1000);
async function script(jump) {
  if (!(await page.getByRole("dialog", { name: "Demo controls" }).isVisible())) await page.keyboard.press("d");
  await page.getByRole("tab", { name: "Script" }).click();
  await page.getByTestId(`jump-${jump}`).click();
  await page.keyboard.press("d"); // close the panel so it does not cover the screen
}
async function glide(locator, steps = 40) {
  // Scroll an element into view slowly, so the video does not jump.
  const box = await locator.boundingBox();
  if (!box) return;
  const target = box.y - 120;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.wheel(0, target / steps);
    await page.waitForTimeout(25);
  }
}

// 1. Landing: the stage replays yesterday.
await beat("landing", () => page.goto(base + "/"), () => page.locator(".stage").waitFor());
await pause(16);
await glide(page.getByRole("region", { name: "How it works" }));
await pause(9);
await page.mouse.wheel(0, -2000);
await pause(2);

// 2. The app and the morning brief.
await beat("open the app", () => page.keyboard.press("Enter"), () => page.getByTestId("kpi-received").filter({ hasText: /^\d+$/ }).waitFor({ timeout: 60000 }));
await page.locator("[data-map-ready=true]").waitFor({ timeout: 30000 });
await pause(7);
await beat("morning brief", () => script("brief"), () => page.locator("#brief").waitFor());
await pause(20);

// 3. E07's hotspot.
await beat("E07 hotspot", () => script("hotspot"), () => page.getByText(/E07 .* · click the row again to clear/).waitFor({ timeout: 15000 }));
await pause(22);

// 4. The queue, decided with the keyboard.
await beat("E07 in the queue", () => script("queue"), () => page.getByRole("button", { name: "Approve as genuine" }).waitFor({ timeout: 30000 }));
await pause(10);
for (const key of ["a", "j", "b", "j", "r", "j", "a"]) {
  await page.keyboard.press(key);
  await pause(key === "j" ? 3 : 5);
}
await pause(6);

// 5. Detectors: drag the threshold.
await beat("detectors", () => script("detectors"), () => page.getByRole("region", { name: "Tune the detectors" }).waitFor());
await pause(8);
const slider = page.locator("#slider-threshold");
await slider.scrollIntoViewIfNeeded();
const box = await slider.boundingBox();
if (box) {
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) {
    await page.mouse.move(box.x + box.width * (0.2 + (0.5 * i) / 60), y);
    await page.waitForTimeout(60);
  }
  await pause(3);
  for (let i = 0; i <= 40; i++) {
    await page.mouse.move(box.x + box.width * (0.7 - (0.45 * i) / 40), y);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
}
await pause(10);

// 6. The phone: a contradiction, at phone size, the transcript and the verdict arriving.
const minted = await (await fetch(`${base}/api/py/collect/token`, {
  method: "POST", headers: { "content-type": "application/json", "x-demo-passcode": passcode }, body: "{}",
})).json();
await beat("phone opens", () => page.setContent(`<!doctype html><html><body style="margin:0;background:#f8faf5;display:grid;place-items:center;height:100vh;font:15px system-ui;color:#535862">
  <div style="display:flex;gap:48px;align-items:center">
    <iframe src="${base}${minted.path}" allow="microphone; geolocation" style="width:390px;height:844px;border:1px solid rgb(0 0 0 / 0.12);border-radius:36px;background:#f8faf5;box-shadow:0 24px 60px -30px rgb(16 40 30 / 0.3)"></iframe>
    <div style="max-width:360px;line-height:1.6"><b style="color:#171717;font-size:18px">A phone, offline-first</b><br>The form says the water is piped to the home.<br>The voice note says the pipe has been dry since March.</div>
  </div></body></html>`), () => page.frameLocator("iframe").getByRole("button", { name: /^E03 / }).waitFor({ timeout: 30000 }));
const phone = page.frameLocator("iframe");
await pause(2);
await phone.getByRole("button", { name: /^E03 / }).click();
await pause(2);
await phone.getByTestId("source-piped_home").click();
const items = ["Reliability", "Distance", "Cost", "Water quality", "Waiting time", "Safety", "Opening hours", "Overall"];
for (const [i, item] of items.entries()) {
  await phone.getByRole("radio", { name: `${item} ${[3, 2, 3, 4, 2, 3, 4, 3][i]}` }).click();
  await page.waitForTimeout(250);
}
await phone.getByPlaceholder("In the respondent's words").fill("Water only comes some days, so planning the week is hard.");
await pause(1);
await phone.getByTestId("record").click();
await phone.getByTestId("recording").waitFor({ timeout: 15000 });
await pause(6.4); // one pass of the voice note
await phone.getByTestId("record").click();
await phone.getByTestId("playback").waitFor();
await pause(4);
const submitted = Date.now();
await beat("phone: rules result", () => phone.getByTestId("submit").click(),
  () => phone.getByRole("region", { name: "Rules result" }).getByTestId("band").waitFor({ timeout: 30000 }));
await phone.getByTestId("transcript").waitFor({ timeout: 60000 });
console.log(`        transcript ${((Date.now() - submitted) / 1000).toFixed(1)} s after submit`);
await phone.getByTestId("verdict").waitFor({ timeout: 60000 });
console.log(`        verdict    ${((Date.now() - submitted) / 1000).toFixed(1)} s after submit`);
await phone.getByRole("region", { name: "Final score" }).getByTestId("band").filter({ hasText: "Flagged for review" }).waitFor({ timeout: 30000 });
await pause(18);

// 7. How it works.
await beat("architecture", () => page.goto(base + "/architecture"), () => page.getByTestId("architecture").filter({ hasNotText: "…" }).waitFor({ timeout: 20000 }));
await pause(8);
await pause(6);
await glide(page.getByRole("region", { name: "Trade-offs" }), 80);
await pause(24);

const total = Date.now() - t0;
await ctx.close();
await browser.close();

// Reset production: the queue decisions and the phone interview go.
const reset = await fetch(`${base}/api/py/demo/reset`, { method: "POST", headers: { "x-demo-passcode": passcode } });
console.log(`demo reset: HTTP ${reset.status}`);

const raw = readdirSync(`${OUT}/raw`).filter((f) => f.endsWith(".webm"));
renameSync(`${OUT}/raw/${raw[0]}`, `${OUT}/demo.webm`);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${OUT}/demo.webm`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30",
  "-preset", "slow", "-crf", "20", "-movflags", "+faststart", `${OUT}/demo.mp4`]);
rmSync(`${OUT}/raw`, { recursive: true, force: true });
rmSync(`${OUT}/demo.webm`, { force: true });
const slow = beats.filter((b) => b.lag > 2000);
console.log(`\ntotal ${clock(total)} · ${beats.length} beats · ${slow.length} over 2 s${slow.length ? `: ${slow.map((b) => b.name).join(", ")}` : ""}`);
console.log(`saved ${OUT}/demo.mp4`);
