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
  await expect(page.getByRole("region", { name: "Verdict" })).toBeVisible({ timeout: 30_000 });
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

test("theme: the sidebar toggle switches the theme and the browser remembers it", async ({ page }) => {
  const start: "poket" | "linear" = process.env.PW_THEME === "linear" ? "linear" : "poket";
  const other = start === "poket" ? "linear" : "poket";
  const label = { poket: "Poket", linear: "Linear" };
  const background = { poket: "rgb(248, 250, 245)", linear: "rgb(8, 9, 10)" };
  await page.goto("/app");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-theme", start);
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible({ timeout: 60_000 });
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle.getByRole("radio", { name: label[start] })).toHaveAttribute("aria-checked", "true");

  await toggle.getByRole("radio", { name: label[other] }).click();
  await expect(html).toHaveAttribute("data-theme", other);
  await expect(page.locator("body")).toHaveCSS("background-color", background[other]);
  // The map is rebuilt on the other theme's basemap.
  await expect(page.locator('[data-map-ready="true"]')).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(html).toHaveAttribute("data-theme", other);
  await expect(toggle.getByRole("radio", { name: label[other] })).toHaveAttribute("aria-checked", "true");
  await page.goto("/");
  await expect(html).toHaveAttribute("data-theme", other);
});

test("queue: only the main signal starts open; rows open on click and with E; details start closed", async ({ page }) => {
  await page.goto("/app/queue?contributor=E07");
  const why = page.getByRole("region", { name: "Why it was flagged" });
  await expect(page.getByRole("button", { name: "Approve as genuine" })).toBeEnabled({ timeout: 30_000 });
  const rows = why.locator("[data-check]");
  await expect(rows.first()).toBeVisible();
  // E07's main signal is same spot: open; every other row closed.
  const toggles = why.locator("[data-check] h3 button");
  const states = await toggles.evaluateAll((els) => els.map((e) => [e.closest("[data-check]")!.getAttribute("data-check"), e.getAttribute("aria-expanded")]));
  expect(states.filter(([, open]) => open === "true")).toEqual([["same_spot", "true"]]);
  expect(states.length).toBeGreaterThan(1);

  // A closed row opens on click and closes again.
  const other = why.locator("[data-check]:not([data-check=same_spot]) h3 button").first();
  await other.click();
  await expect(other).toHaveAttribute("aria-expanded", "true");
  await other.press("Enter");
  await expect(other).toHaveAttribute("aria-expanded", "false");

  // E opens them all, E again closes them all.
  await page.locator("body").press("e");
  await expect(toggles.and(page.locator("[aria-expanded=false]"))).toHaveCount(0);
  await page.locator("body").press("e");
  await expect(toggles.and(page.locator("[aria-expanded=true]"))).toHaveCount(0);

  // Submission details: closed by default, open on click (the answers are inside).
  const details = page.getByTestId("submission-details");
  const open = details.getByRole("button", { name: "Submission details" });
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await open.click();
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(details.getByText("Water source")).toBeVisible();
});

test("queue: the action bar never covers the last element, on desktop and above the phone nav", async ({ page }) => {
  await page.goto("/app/queue?contributor=P02");
  await expect(page.getByRole("button", { name: "Approve as genuine" })).toBeEnabled({ timeout: 30_000 });
  const details = page.getByTestId("submission-details");
  const button = details.getByRole("button", { name: "Submission details" });
  if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  await expect(details.getByText("Source", { exact: true })).toBeVisible();
  for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(500); // the details have finished opening and the layout has settled
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(400);
    const bar = (await page.getByTestId("action-bar").boundingBox())!;
    const last = (await details.boundingBox())!;
    expect(bar.y, `bar top at ${size.width}`).toBeGreaterThanOrEqual(last.y + last.height - 1);
    if (size.width < 768) {
      const nav = (await page.getByRole("navigation", { name: "Sections" }).boundingBox())!;
      expect(bar.y + bar.height, "bar above the phone nav").toBeLessThanOrEqual(nav.y + 1);
    }
  }
});

test("overview: the brief, the contributors and the map open their details on demand", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByTestId("brief-headline")).toBeVisible({ timeout: 30_000 });
  const brief = page.getByTestId("brief-toggle");
  await expect(brief).toHaveAttribute("aria-expanded", "false");
  await brief.click();
  await expect(brief).toHaveAttribute("aria-expanded", "true");
  await expect(brief).toHaveText(/Show less/);

  const contributors = page.getByTestId("contributors-toggle");
  await expect(contributors).toHaveText(/Show all \d+/);
  const hidden = page.locator("[data-testid=contributors] tbody tr[inert]");
  expect(await hidden.count()).toBeGreaterThan(50);
  await contributors.click();
  await expect(hidden).toHaveCount(0);

  // The map's "what am I looking at" folds to a "?" and opens again on click (remembered).
  const help = page.getByTestId("map-help");
  await expect(page.locator("[data-map-ready=true]")).toBeVisible({ timeout: 60_000 });
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await help.click();
  await expect(help).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.getByTestId("map-help")).toHaveAttribute("aria-expanded", "false", { timeout: 30_000 });
});

test("other sections show a one-line summary in the topbar instead of the KPI strip", async ({ page }) => {
  await page.goto("/app/detectors");
  await expect(page.getByTestId("topbar-summary")).toHaveText(/^\d+ waiting · \d+ to investigate$/, { timeout: 30_000 });
  await expect(page.getByTestId("kpi-received")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Per-check breakdown" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Hard mode: rules vs rules + AI" })).toHaveAttribute("aria-expanded", "false");
});

test("theme: the demo panel has the toggle too (phones have no sidebar)", async ({ page }) => {
  test.skip(!PASSCODE, "opening the demo panel asks for DEMO_PASSCODE");
  await page.addInitScript((code) => window.localStorage.setItem("fqc-demo-passcode", code), PASSCODE!);
  const start: "poket" | "linear" = process.env.PW_THEME === "linear" ? "linear" : "poket";
  const other = start === "poket" ? "Linear" : "Poket";
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("data-theme", start);
  await expect(page.getByTestId("kpi-received")).toHaveText(/^\d+$/, { timeout: 60_000 }); // hydrated: D works
  await page.keyboard.press("d");
  const toggle = page.getByRole("dialog", { name: "Demo controls" }).getByTestId("theme-toggle-panel");
  await toggle.getByRole("radio", { name: other }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", other.toLowerCase());
});
