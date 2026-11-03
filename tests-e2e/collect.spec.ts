import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// The phone collect page, on the Pixel and iPhone profiles (playwright.config.ts).
// Chromium's fake microphone plays tests-e2e/fixtures/pipe-dry.wav: "The pipe at home
// has been dry since March, so we buy from the handcart man." Every test runs on a fresh
// browser context, so each one is a new phone with its own device id and outbox.

const PASSCODE = process.env.DEMO_PASSCODE;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SENTENCE = "The pipe at home has been dry since March, so we buy from the handcart man";
const ANSWERS = [3, 2, 3, 4, 2, 3, 4, 3];
const ITEMS = ["Reliability", "Distance", "Cost", "Water quality", "Waiting time", "Safety", "Opening hours", "Overall"];

async function mint(request: APIRequestContext, ttl_seconds = 1800): Promise<{ token: string; path: string }> {
  const response = await request.post("/api/py/collect/token", { headers: { "x-demo-passcode": PASSCODE! }, data: { ttl_seconds } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function resetDemo(request: APIRequestContext) {
  const response = await request.post("/api/py/demo/reset", { headers: { "x-demo-passcode": PASSCODE! }, timeout: 120_000 });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

/** Rows stored for one phone-made id, read the way the dashboard reads (publishable key). */
async function rowsFor(request: APIRequestContext, clientId: string): Promise<number> {
  const response = await request.get(`${SUPABASE_URL}/rest/v1/submissions?select=id&client_submission_id=eq.${clientId}`, {
    headers: { apikey: ANON_KEY!, authorization: `Bearer ${ANON_KEY}` },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).length;
}

async function open(page: Page, request: APIRequestContext, code: string) {
  await page.goto((await mint(request)).path);
  await page.getByRole("button", { name: new RegExp(`^${code} `) }).click();
  await expect(page.getByTestId("contributor")).toContainText(code);
}

async function fill(page: Page, source = "piped_home") {
  await page.getByTestId(`source-${source}`).click();
  for (const [i, item] of ITEMS.entries()) await page.getByRole("radio", { name: `${item} ${ANSWERS[i]}` }).click();
  await page.getByPlaceholder("In the respondent's words").fill("Water only comes some days, so planning the week is hard.");
}

/** Tap to start, let the fixture play once, tap to stop, and wait for the playback control. */
async function record(page: Page) {
  await page.getByTestId("record").click();
  await expect(page.getByTestId("recording")).toBeVisible();
  await page.waitForTimeout(7_500);
  await page.getByTestId("record").click();
  await expect(page.getByTestId("playback")).toBeVisible({ timeout: 10_000 });
}

test.describe("phone collect page", () => {
  test.skip(!PASSCODE || !SUPABASE_URL || !ANON_KEY, "needs DEMO_PASSCODE and the Supabase URL and publishable key");

  // Whatever happened, leave the project as a fresh wave (this also removes every phone row).
  test.afterAll(async ({ request }) => {
    const result = await resetDemo(request);
    console.log(`teardown: reset removed ${result.deleted.submissions} live submissions`);
  });

  test("a piped_home form whose voice note says the pipe is dry ends flagged, quoting the sentence", async ({ page, request }) => {
    test.setTimeout(150_000);
    await open(page, request, "E03");
    await fill(page);
    await record(page);

    const started = Date.now();
    const at = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
    await page.getByTestId("submit").click();
    const rules = page.getByRole("region", { name: "Rules result" });
    await expect(rules.getByTestId("band")).toBeVisible({ timeout: 30_000 });
    const timings = [`rules ${at()}`];

    await expect(page.getByTestId("transcript")).toContainText(/pipe at home has been dry since March/i, { timeout: 60_000 });
    await expect(page.getByTestId("transcript")).toContainText("English");
    timings.push(`transcript ${at()}`);

    const verdict = page.getByTestId("verdict");
    await expect(verdict).toContainText("Contradiction", { timeout: 60_000 });
    // The model picks how much to quote ("the handcart man", or the whole sentence); it must be part of it.
    const quote = (await verdict.getByTestId("quote").innerText()).trim();
    expect(quote.length).toBeGreaterThanOrEqual(10);
    expect(SENTENCE.toLowerCase()).toContain(quote.toLowerCase().replace(/[.”"]+$/, ""));
    timings.push(`verdict ${at()}`);

    const final = page.getByRole("region", { name: "Final score" });
    await expect(final.getByTestId("band")).toHaveText("Flagged for review", { timeout: 30_000 });
    await expect(final).toContainText("Voice vs form");
    console.log(`${test.info().project.name}: submit → ${timings.join(" → ")}`);

    // The dashboard sees the same record: open it from the result screen's link.
    const href = await page.getByRole("link", { name: "Open in the review queue" }).getAttribute("href");
    expect(href).toMatch(/^\/app\/queue\/[0-9a-f-]{36}\?status=all$/);
  });

  test("saved offline, it waits on the phone; back online it syncs once, even when a response is lost", async ({ page, context, request }) => {
    test.setTimeout(120_000);
    await open(page, request, "E04");
    await context.setOffline(true);
    await fill(page);
    await record(page);
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("waiting")).toContainText("Saved on this phone · will sync");
    await expect(page.getByTestId("sync-pill")).toHaveText("Offline · 1 waiting");
    await expect(page.getByTestId("synced-at")).toHaveCount(0);

    // The first submit reaches the server, but its response never reaches the phone.
    let clientId = "";
    let firstId = "";
    let posts = 0;
    await page.route("**/api/py/submissions", async (route) => {
      posts += 1;
      if (posts > 1) return route.continue();
      clientId = route.request().postDataJSON().client_submission_id;
      firstId = (await (await route.fetch()).json()).id;
      await route.abort("connectionreset");
    });
    await context.setOffline(false);

    await expect(page.getByTestId("synced-at")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("sync-pill")).toHaveText("Online");
    expect(posts).toBe(2);
    const href = await page.getByRole("link", { name: "Open in the review queue" }).getAttribute("href");
    expect(href).toContain(firstId); // the retry got the record the lost response carried
    expect(await rowsFor(request, clientId)).toBe(1);
  });

  test("an expired collect token is refused", async ({ page, request }) => {
    const { path } = await mint(request, 1);
    await page.waitForTimeout(2_100);
    await page.goto(path);
    await expect(page.getByTestId("refused")).toContainText("expired");
    await expect(page.getByRole("button", { name: /^E03 / })).toHaveCount(0);
  });

  test("a second contributor on the same phone fires shared device", async ({ page, request }) => {
    test.setTimeout(120_000);
    await open(page, request, "E01");
    await fill(page, "public_tap");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("synced-at")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Rules result" })).not.toContainText("Shared device");

    await page.getByRole("button", { name: "New interview" }).click();
    await page.getByTestId("switch-contributor").click();
    await expect(page.getByText("the shared-device check will see two accounts on this phone")).toBeVisible();
    await page.getByRole("button", { name: /^E02 / }).click();
    await fill(page, "public_tap");
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("synced-at")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Rules result" })).toContainText("Shared device");
  });

  test("the real GPS in Toronto fires outside area, with the distance in km", async ({ page, context, request }) => {
    await context.setGeolocation({ latitude: 43.6532, longitude: -79.3832, accuracy: 12 });
    await open(page, request, "E05");
    await fill(page, "public_tap");
    await page.getByTestId("real-gps").check();
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("synced-at")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Rules result" })).toContainText(/Outside area \(\d{1,2},\d{3} km from Kondele\)/);
  });

  // Last: a demo reset revokes every collect token minted before it.
  test("a collect token minted before a demo reset is refused after it", async ({ page, request }) => {
    test.setTimeout(150_000);
    const { path } = await mint(request);
    await resetDemo(request);
    await page.goto(path);
    await expect(page.getByTestId("refused")).toContainText("revoked");
  });
});
