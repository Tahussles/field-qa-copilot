import { expect, test } from "@playwright/test";

test("landing: the stage replays real submissions with the evaluation counters", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catch fabricated field data before it reaches the analysis.");
  await expect(page.getByTestId("counter-checked")).toHaveText(/^\d{1,3}(,\d{3})*$/, { timeout: 60_000 });
  await expect(page.getByTestId("counter-fakes")).toHaveText(/^\d+$/);
  await expect(page.getByTestId("counter-caught")).toHaveText(/^\d+%$/);
  await expect(page.getByTestId("counter-correct")).toHaveText(/^\d+%$/);
  // Replay of yesterday unless phones are really syncing right now; never a replay labelled live.
  await expect(page.getByTestId("stage-mode")).toHaveText(/^(Replay · [A-Z][a-z]{2} \d{1,2}|Live)$/);
  const feed = page.getByTestId("stage-feed").locator(".frow");
  await expect(feed.first()).toBeVisible();
  await expect(feed.first()).toContainText(/S-[0-9A-F]{4} · [EP]\d{2}/);
  await expect(page.getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
});

test("landing: Enter opens the app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("counter-checked")).toHaveText(/\d/, { timeout: 60_000 });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app$/);
});

test("landing: reduced motion shows a static frame", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const feed = page.getByTestId("stage-feed").locator(".frow");
  await expect(feed).toHaveCount(6, { timeout: 60_000 });
  const first = await feed.first().textContent();
  await page.waitForTimeout(2500);
  await expect(feed.first()).toHaveText(first!);
});
