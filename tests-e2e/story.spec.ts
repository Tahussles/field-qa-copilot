import { expect, test } from "@playwright/test";

// The story pages show generated numbers only, and the demo script's jumps land where they say.

test("/pitch moves with the arrow keys and slide 4 shows the held-out numbers from /api/py/story", async ({ page, request }) => {
  const story = await (await request.get("/api/py/story")).json();
  await page.goto("/pitch");
  await expect(page.getByTestId("slide-1")).not.toContainText("…", { timeout: 15_000 }); // hydrated, numbers in
  for (const n of [2, 3, 4]) {
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId(`slide-${n}`)).toBeVisible();
  }
  const recall = `${(story.headline.held_out.recall * 100).toFixed(1)}%`;
  await expect(page.getByTestId("proof-recall")).toContainText(recall);
  await expect(page.getByTestId("proof")).not.toContainText("…");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("slide-3")).toBeVisible();
});

test("/architecture annotates every box with a measured number", async ({ page }) => {
  await page.goto("/architecture");
  const diagram = page.getByTestId("architecture");
  await expect(diagram).toContainText("ms");
  await expect(diagram).not.toContainText("…", { timeout: 15_000 });
});

test("the Script tab's Focus E07 opens E07's hotspot on the map", async ({ page }) => {
  test.skip(!process.env.DEMO_PASSCODE, "the demo panel needs DEMO_PASSCODE");
  await page.addInitScript((code) => window.localStorage.setItem("fqc-demo-passcode", code), process.env.DEMO_PASSCODE!);
  await page.goto("/app");
  await expect(page.getByTestId("kpi-received")).toHaveText(/^\d+$/, { timeout: 60_000 });
  await expect(page.locator("[data-map-ready=true]")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("d");
  await page.getByRole("tab", { name: "Script" }).click();
  await page.getByTestId("jump-hotspot").click();
  await expect(page.getByText(/E07 .* · click the row again to clear/)).toBeVisible({ timeout: 15_000 });
});
