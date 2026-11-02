import { expect, test, type APIRequestContext } from "@playwright/test";

const PASSCODE = process.env.DEMO_PASSCODE;
const REVIEWER = "smoke-test";

// Reviews made by the smoke test are deleted afterwards with the service role
// key, so a run against prod leaves no rows behind (not even revoked ones).
test.afterAll(async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const response = await fetch(`${url}/rest/v1/reviews?reviewer=eq.${REVIEWER}`, {
    method: "DELETE",
    headers: { apikey: key, Prefer: "return=representation" },
  });
  if (!response.ok) throw new Error(`cleanup failed: ${response.status} ${await response.text()}`);
  console.log(`teardown: deleted ${(await response.json()).length} ${REVIEWER} review(s)`);
});

async function kpis(request: APIRequestContext) {
  return (await (await request.get("/api/py/overview")).json()).kpis;
}

// Undo revokes a review (kept for the audit trail), so "no decision" means no active review.
async function activeReview(request: APIRequestContext, id: string) {
  const review = (await (await request.get(`/api/py/submissions/${id}`)).json()).review;
  return review && !review.revoked_at ? review : null;
}

test("overview: the map renders points", async ({ page }) => {
  await page.goto("/app");
  const map = page.locator('[data-map-ready="true"]');
  await expect(map).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => Number(await map.getAttribute("data-rendered-points")), { timeout: 30_000 })
    .toBeGreaterThan(100);
  await expect(page.getByTestId("kpi-received")).toHaveText(/^\d+$/);
  await expect(page.getByRole("button", { name: /interviews in one spot/ }).first()).toBeVisible();
});

test("queue: approve then undo leaves the data unchanged", async ({ page, request }) => {
  test.skip(!PASSCODE || !process.env.SUPABASE_SERVICE_ROLE_KEY, "needs DEMO_PASSCODE and SUPABASE_SERVICE_ROLE_KEY for cleanup");
  await page.addInitScript(
    ([code, reviewer]) => {
      window.localStorage.setItem("fqc-demo-passcode", code);
      window.localStorage.setItem("fqc-reviewer", reviewer);
    },
    [PASSCODE!, REVIEWER],
  );
  const before = await kpis(request);

  await page.goto("/app/queue");
  await expect(page).toHaveURL(/\/app\/queue\/[0-9a-f-]{36}/, { timeout: 30_000 });
  const id = page.url().match(/queue\/([0-9a-f-]{36})/)![1];
  await expect(page.getByText("Submission", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await activeReview(request, id)).toBeNull();

  await page.keyboard.press("a");
  await expect(page.getByRole("status").filter({ hasText: "Approved" })).toBeVisible();
  expect(await activeReview(request, id)).toMatchObject({ decision: "approve", reviewer: REVIEWER });
  await expect(page).not.toHaveURL(new RegExp(id)); // auto-advanced

  await page.keyboard.press("u");
  await expect(page.getByRole("status").filter({ hasText: "decision undone" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(id)); // back on the undone item
  expect(await activeReview(request, id)).toBeNull();
  expect(await kpis(request)).toEqual(before);
});

test("detectors: moving a slider changes the numbers", async ({ page }) => {
  await page.goto("/app/detectors");
  const flagged = page.getByTestId("combined-flagged");
  await expect(flagged).toHaveText(/\d/, { timeout: 30_000 });
  const before = (await flagged.textContent())!;
  const slider = page.getByLabel(/Send to review at/i);
  await slider.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(flagged).not.toHaveText(before, { timeout: 15_000 });
  await expect(page.getByText("these numbers are scored against planted fraud")).toBeVisible();
});
