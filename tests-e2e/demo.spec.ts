import { expect, test, type APIRequestContext } from "@playwright/test";

const PASSCODE = process.env.DEMO_PASSCODE;

async function resetDemo(request: APIRequestContext) {
  const response = await request.post("/api/py/demo/reset", { headers: { "x-demo-passcode": PASSCODE! }, timeout: 120_000 });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test.describe("demo controls", () => {
  test.skip(!PASSCODE, "needs DEMO_PASSCODE");

  // Whatever happens in the test, leave the project as a fresh wave.
  test.afterAll(async ({ request }) => {
    const result = await resetDemo(request);
    const status = await (await request.get("/api/py/demo/status", { headers: { "x-demo-passcode": PASSCODE! } })).json();
    expect(status.progress.sent).toBe(0);
    console.log(`teardown: reset removed ${result.deleted.submissions} live submissions, ${result.deleted.reviews} reviews`);
  });

  test("reset, step to a key moment, see a toast and the KPIs change, reset again", async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.addInitScript((code) => window.localStorage.setItem("fqc-demo-passcode", code), PASSCODE!);
    await page.goto("/app");
    const received = page.getByTestId("kpi-received");
    await expect(received).toHaveText(/^\d+$/, { timeout: 60_000 });

    await page.keyboard.press("d");
    const panel = page.getByRole("dialog", { name: "Demo controls" });
    const progress = panel.getByTestId("demo-progress");
    await expect(progress).toBeVisible({ timeout: 30_000 });

    // Reset first, confirmed inside the panel (no browser dialog).
    await panel.getByRole("button", { name: "Reset demo" }).click();
    await panel.getByRole("alert").getByRole("button", { name: "Reset demo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Demo reset" })).toBeVisible({ timeout: 90_000 });
    await expect(progress).toContainText(/ 0 \/ \d+ sent/);
    // The dashboard catches up through Realtime (deletes and rescored rows), not a reload.
    const fresh = (await (await request.get("/api/py/overview")).json()).kpis.received;
    await expect.poll(async () => Number(await received.textContent()), { timeout: 30_000 }).toBe(fresh);

    // Fast-forward to just before the first key moment: earlier submissions sync, the KPI follows by Realtime.
    await expect(panel.getByText("next", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Skip to next key moment" }).click();
    await expect(progress).not.toContainText(/ 0 \/ \d+ sent/, { timeout: 60_000 });
    await expect(panel.getByRole("button", { name: "Resume live day" })).toBeEnabled({ timeout: 60_000 });
    await expect.poll(async () => Number(await received.textContent()), { timeout: 30_000 }).toBeGreaterThan(fresh);

    // Run the moment at the fastest speed until a flagged arrival is announced.
    await panel.getByRole("button", { name: "3 s" }).click();
    await panel.getByRole("button", { name: "Resume live day" }).click();
    await expect(page.getByRole("status").filter({ hasText: / flagged · [EP]\d{2}/ }).first()).toBeVisible({ timeout: 60_000 });
    await panel.getByRole("button", { name: "Pause live day" }).click();
    await expect(progress).toContainText(/[1-9]\d* flagged/);

    // Reset again: back to the fresh wave.
    await panel.getByRole("button", { name: "Reset demo" }).click();
    await panel.getByRole("alert").getByRole("button", { name: "Reset demo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Demo reset" }).last()).toBeVisible({ timeout: 90_000 });
    await expect(progress).toContainText(/ 0 \/ \d+ sent · 0 flagged/);
    await expect.poll(async () => Number(await received.textContent()), { timeout: 30_000 }).toBe(fresh);
  });
});
