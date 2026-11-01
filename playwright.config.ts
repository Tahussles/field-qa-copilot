import { defineConfig, devices } from "@playwright/test";

// The smoke test runs against the local app (pnpm dev), which reads prod data.
// DEMO_PASSCODE comes from .env.local so the queue test can write and undo.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local: the queue write test skips itself
}

export default defineConfig({
  testDir: "tests-e2e",
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:3000",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
    // Headless Chromium needs a software GL backend for the map.
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000/api/py/health",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
