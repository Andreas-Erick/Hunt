import { expect, test, type FrameLocator, type Page } from "@playwright/test";

/**
 * The static browser demo (ADR-0010), embedded the way a portfolio site embeds it: an
 * iframe at /demos/hunt/ on a host page. It must load seeded, stay inside its own folder,
 * fit from 360 px to 1280 px, and Reset demo must bring the seed back.
 */
const BASE = "/demos/hunt/";
const SEEDED_TASK = "Finish the new Review screen";

/** Opens the host page with the iframe `width` px wide; collects every request and console error. */
async function openEmbedded(page: Page, width: number) {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: Math.max(width + 48, 420), height: 900 });
  await page.goto("/");
  await page.locator("#demo").evaluate((el, w) => ((el as HTMLIFrameElement).width = String(w)), width);
  const frame = page.frameLocator("#demo");
  return { frame, requests, errors };
}

async function expectNoSideScroll(frame: FrameLocator) {
  const overflow = await frame.locator("html").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, "horizontal overflow inside the iframe (px)").toBeLessThanOrEqual(0);
}

for (const width of [360, 1280]) {
  test(`at ${width}px the embedded demo opens seeded, fits, and stays in its folder`, async ({ page }) => {
    const { frame, requests, errors } = await openEmbedded(page, width);
    const started = Date.now();

    await expect(frame.getByRole("region", { name: "Live demo" })).toContainText(
      "Live demo: data stays in your browser."
    );
    await expect(frame.getByText(SEEDED_TASK).first()).toBeVisible();
    // Usable within a few seconds even here (the CI budget is loose; locally it is ~0.3 s).
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(frame.getByRole("link", { name: "Get the real app" })).toHaveAttribute(
      "href",
      "https://github.com/Andreas-Erick/Hunt/releases"
    );
    await expectNoSideScroll(frame);

    // Habits and Review render from the seed too (nav may scroll sideways at 360 px).
    await frame.getByRole("button", { name: "Habits", exact: true }).click();
    await expect(frame.getByText("Morning pages").first()).toBeVisible();
    await expectNoSideScroll(frame);
    await frame.getByRole("button", { name: "Review", exact: true }).click();
    await expect(frame.getByRole("heading", { name: /review/i }).first()).toBeVisible();
    await expectNoSideScroll(frame);

    // No sync server, no host-site paths, no third parties: only the demo's own files.
    const origin = new URL(page.url()).origin;
    const foreign = requests.filter((url) => url !== `${origin}/` && !url.startsWith(`${origin}${BASE}`));
    expect(foreign).toEqual([]);
    expect(requests.some((url) => url.includes("/api/"))).toBe(false);
    expect(errors).toEqual([]);
  });
}

test("Reset demo restores the seed after the visitor changes things", async ({ page }) => {
  const { frame } = await openEmbedded(page, 1280);
  await expect(frame.getByText(SEEDED_TASK).first()).toBeVisible();

  // A visible change: the visitor adds a task.
  const composer = frame.getByRole("textbox", { name: "Add quest work" });
  await composer.fill("A task the visitor added");
  await composer.press("Enter");
  await expect(frame.getByText("A task the visitor added")).toBeVisible();

  // The change survives a reload: state really lives in the browser.
  await page.reload();
  await expect(frame.getByText("A task the visitor added")).toBeVisible();

  await frame.getByRole("button", { name: "Reset demo" }).click();
  await expect(frame.getByText(SEEDED_TASK).first()).toBeVisible();
  await expect(frame.getByText("A task the visitor added")).toHaveCount(0);
});

test("the Phone button explains that sync needs the real app", async ({ page }) => {
  const { frame } = await openEmbedded(page, 1280);
  await frame.getByRole("button", { name: /phone sync/i }).click();
  const sheet = frame.getByRole("dialog", { name: "Phone & sync" });
  await expect(sheet).toContainText("runs entirely in your browser");
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
});

test("the demo also works opened directly, without the trailing slash", async ({ page }) => {
  await page.goto(BASE.replace(/\/$/, ""));
  await expect(page).toHaveURL(new RegExp(`${BASE}$`));
  await expect(page.getByText(SEEDED_TASK).first()).toBeVisible();
});
