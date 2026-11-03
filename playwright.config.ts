import { defineConfig, devices } from "@playwright/test";

// The smoke test runs against the local app (pnpm dev), which reads prod data.
// DEMO_PASSCODE comes from .env.local so the queue test can write and undo.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local: the queue write test skips itself
}

// The phone tests feed Chromium's fake microphone a recorded voice note. The iPhone
// profile runs on Chromium too (the fake mic is Chromium-only), so it emulates the
// screen, touch and user agent but records webm/opus, not Safari's mp4/aac.
const VOICE_NOTE = "tests-e2e/fixtures/pipe-dry.wav";
const phone = {
  permissions: ["microphone", "geolocation"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${VOICE_NOTE}`],
  },
};

// Every suite runs in either theme: PW_THEME=linear for the dark one (poket, the default, otherwise).
// The choice is the app's own localStorage key, seeded into each test's browser context.
const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const THEME = process.env.PW_THEME ?? "poket";
if (!["poket", "linear"].includes(THEME)) throw new Error(`PW_THEME is poket or linear, not ${THEME}`);
const storageState = { cookies: [], origins: [{ origin: new URL(BASE_URL).origin, localStorage: [{ name: "fqc-theme", value: THEME }] }] };

export default defineConfig({
  testDir: "tests-e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, storageState },
  projects: [
    {
      name: "desktop",
      testIgnore: /collect\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        // Headless Chromium needs a software GL backend for the map.
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
      },
    },
    { name: "pixel", testMatch: /collect\.spec\.ts/, use: { ...devices["Pixel 7"], ...phone } },
    { name: "iphone", testMatch: /collect\.spec\.ts/, use: { ...devices["iPhone 13"], browserName: "chromium", ...phone } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/api/py/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
