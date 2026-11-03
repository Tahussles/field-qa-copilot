import { expect, test } from "@playwright/test";

// Live-demo resilience: the dashboard keeps working when the basemap or the Realtime socket does not.

test("the map falls back to a plain background when the basemap cannot load, never blank", async ({ page }) => {
  await page.route("https://tiles.openfreemap.org/**", (route) => route.abort());
  await page.goto("/app");
  const map = page.locator("[data-map-ready]");
  await expect(map).toHaveAttribute("data-map-fallback", "true", { timeout: 15_000 });
  await expect(page.getByTestId("map-fallback")).toBeVisible();
  await expect(map).toHaveAttribute("data-map-ready", "true");
  await expect.poll(async () => Number(await map.getAttribute("data-rendered-points")), { timeout: 15_000 }).toBeGreaterThan(100);
});

test("without the Realtime socket the dashboard polls every 3 s, and stops once it reconnects", async ({ page }) => {
  let allow = false;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    if (allow) ws.connectToServer();
    else ws.close();
  });
  const polls: number[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/py/overview")) polls.push(Date.now());
  });
  await page.goto("/app");
  await expect(page.getByTestId("reconnecting")).toBeVisible({ timeout: 30_000 });
  const before = polls.length;
  await page.waitForTimeout(7_000);
  expect(polls.length - before).toBeGreaterThanOrEqual(2); // about one every 3 s

  allow = true; // supabase-js retries on its own; the next attempt reaches the server
  await expect(page.getByTestId("reconnecting")).toBeHidden({ timeout: 60_000 });
  await expect(page.getByText("Live updates on")).toBeVisible();
  const settled = polls.length;
  await page.waitForTimeout(7_000);
  expect(polls.length - settled).toBeLessThanOrEqual(1); // no polling while connected (one catch-up load at most)
});
