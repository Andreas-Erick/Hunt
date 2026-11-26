import { test, expect, type Page } from "@playwright/test";
import { buildFixtures, buildMobileState } from "./fixtures";
import type { Habit, Task } from "../src/lib/domainTypes";

/**
 * Layout stability while a task is completed, in a real browser with motion on.
 *
 * Completing a task must not move the "Completed" section: the open lists hold
 * their height on Home and on the phone's Today, the card glides down into a
 * section that is already there, and the completion toast floats over the page.
 * jsdom has no layout, so only a browser can see these shifts. Each test samples
 * positions on every animation frame from the click until the motion settles.
 */

test.use({ reducedMotion: "no-preference" });

/** Wall clock (not pinned): the phone's double-tap guard and the motion run on real time. */
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
/** Longer than the whole completion motion (hold + glide + settle, under 1.1 s). */
const SAMPLE_MS = 1300;
/** Sub-pixel rounding is not a shift. */
const TOLERANCE_PX = 1;

function task(id: string, title: string, questId: string | null, rank: number): Task {
  return {
    id,
    title,
    notes: "",
    questId,
    status: "queued",
    rank,
    accumulatedSeconds: 0,
    scheduledDate: TODAY,
    createdAt: NOW - 60_000,
    updatedAt: 1,
  } as Task;
}

/** Two quest tasks and one Other work task: the shapes that used to shift. */
const TASKS = [
  task("quest-a", "Quest task A", "quest-slot-1", 1000),
  task("quest-b", "Quest task B", "quest-slot-1", 2000),
  task("other-a", "Loose chore", null, 3000),
];

interface Sampled {
  /** Largest movement of each watched element from where it was before the click. */
  maxShift: Record<string, number>;
  /** The completed card's top: first frame it exists, and at rest. */
  cardFirst: number | null;
  cardLast: number | null;
}

/**
 * Clicks `buttonSelector` and samples the watched elements' tops every frame.
 * Runs inside the page so the click and the first sample share a frame.
 */
async function completeAndSample(
  page: Page,
  buttonSelector: string,
  watch: Record<string, string>,
  completedCardSelector: string
): Promise<Sampled> {
  return page.evaluate(
    async ({ buttonSelector, watch, completedCardSelector, sampleMs }) => {
      const topOf = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? null;
      const before: Record<string, number | null> = {};
      for (const [name, sel] of Object.entries(watch)) before[name] = topOf(sel);
      const maxShift: Record<string, number> = {};
      for (const name of Object.keys(watch)) maxShift[name] = 0;
      let cardFirst: number | null = null;
      let cardLast: number | null = null;

      (document.querySelector(buttonSelector) as HTMLElement).click();
      const t0 = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          for (const [name, sel] of Object.entries(watch)) {
            const top = topOf(sel);
            const was = before[name];
            if (top === null || was === null) {
              maxShift[name] = Infinity; // vanished or appeared: a shift by definition
            } else {
              maxShift[name] = Math.max(maxShift[name], Math.abs(top - was));
            }
          }
          const card = topOf(completedCardSelector);
          if (card !== null) {
            cardFirst ??= card;
            cardLast = card;
          }
          if (performance.now() - t0 < sampleMs) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      return { maxShift, cardFirst, cardLast };
    },
    { buttonSelector, watch, completedCardSelector, sampleMs: SAMPLE_MS }
  );
}

/** Web fonts swapping in re-flow the page; the shift under test must not be confused with it. */
async function waitForSettledLayout(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.fonts.ready.then(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
  );
}

function expectNoShift(result: Sampled): void {
  for (const [name, shift] of Object.entries(result.maxShift)) {
    expect(shift, `${name} moved ${shift}px while the task was completed`).toBeLessThanOrEqual(TOLERANCE_PX);
  }
}

// ---------------------------------------------------------------------------
// Desktop Home (also what a tablet sees through the LAN link)
// ---------------------------------------------------------------------------

async function openDesktopHome(page: Page, habits: Habit[] = []): Promise<void> {
  await page.route("**/api/sync**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
  const data = { ...buildFixtures(NOW), tasks: TASKS, habits, lists: [], timeLogs: [] };
  await page.evaluate(async (data) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("JourneyCommandDB");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = ["quests", "tasks", "habits", "lists", "timeLogs"];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(stores, "readwrite");
      for (const name of stores) {
        const store = tx.objectStore(name);
        store.clear();
        for (const row of (data as unknown as Record<string, unknown[]>)[name]) store.put(row);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, data);
  await page.reload();
  await expect(page.locator('[data-task-id="other-a"]').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("completed-tasks-section")).toBeVisible();
  await waitForSettledLayout(page);
}

const DESKTOP_WATCH = {
  "the Completed header": '[data-flow-key="completed-header"]',
  "the date heading": "main h1",
};
const desktopCheck = (id: string) => `[data-task-id="${id}"] button[aria-label="Mark complete"]`;
const desktopCard = (id: string) => `[data-testid="completed-task-row"][data-task-id="${id}"]`;

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 820, height: 1180 },
]) {
  test.describe(`desktop Home ${viewport.width}x${viewport.height}: completing never shifts the layout`, () => {
    test.use({ viewport });

    test("the only Other work task: its section empties, Completed stays put", async ({ page }) => {
      await openDesktopHome(page);
      const result = await completeAndSample(page, desktopCheck("other-a"), DESKTOP_WATCH, desktopCard("other-a"));
      expectNoShift(result);
      await expect(page.locator('[data-flow-key="other-header"]')).toHaveCount(0);
      // The card glided down into Completed rather than appearing in place.
      expect(result.cardFirst).not.toBeNull();
      expect(result.cardLast! - result.cardFirst!).toBeGreaterThan(0);
    });

    test("a quest task with work below it: Completed stays put, the card travels down", async ({ page }) => {
      await openDesktopHome(page);
      const result = await completeAndSample(page, desktopCheck("quest-a"), DESKTOP_WATCH, desktopCard("quest-a"));
      expectNoShift(result);
      expect(result.cardLast! - result.cardFirst!).toBeGreaterThan(0);
    });

    test("two completions in a row: Completed never moves", async ({ page }) => {
      await openDesktopHome(page);
      expectNoShift(await completeAndSample(page, desktopCheck("quest-b"), DESKTOP_WATCH, desktopCard("quest-b")));
      expectNoShift(await completeAndSample(page, desktopCheck("other-a"), DESKTOP_WATCH, desktopCard("other-a")));
    });

    test("the completion toast's region floats over the page, so showing it cannot push the layout", async ({ page }) => {
      // The toast appears when a Focus session's task is finished; its live region is always mounted.
      await openDesktopHome(page);
      const region = page.getByTestId("completion-toast");
      expect(await region.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
      // Out of the flow: the region takes no room above the date heading.
      const box = await region.boundingBox();
      const heading = await page.locator("main h1").boundingBox();
      expect(box && heading && box.y > heading.y).toBe(true);
    });
  });
}

// ---------------------------------------------------------------------------
// Phone app (/hunt-mobile.html)
// ---------------------------------------------------------------------------

async function openPhoneToday(page: Page, habits: Habit[] = []): Promise<void> {
  await page.route("**/api/sync**", (route) => route.abort());
  const state = buildMobileState({ ...buildFixtures(NOW), tasks: TASKS, habits, lists: [], timeLogs: [] });
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["hunt-mobile-standalone-v1", JSON.stringify(state)] as const
  );
  await page.goto("/hunt-mobile.html");
  await expect(page.getByText("Loose chore")).toBeVisible();
  await expect(page.locator('[data-flip-key="sec-completed"]')).toBeVisible();
  await waitForSettledLayout(page);
}

const PHONE_WATCH = {
  "the Completed today header": '[data-flip-key="sec-completed"]',
  "the Today heading": "#mainContainer .hero-title",
};
const phoneCheck = (id: string) =>
  `[data-flip-task-id="${id}"]:not(.completed) :is(.task-check-ring, .btn-complete-circle)`;
const phoneCard = (id: string) => `.completed[data-flip-task-id="${id}"]`;

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1024, height: 768 },
]) {
  test.describe(`phone app ${viewport.width}x${viewport.height}: completing never shifts the layout`, () => {
    test.use({ viewport });

    test("the only Other work task: its section empties, Completed today stays put", async ({ page }) => {
      await openPhoneToday(page);
      const result = await completeAndSample(page, phoneCheck("other-a"), PHONE_WATCH, phoneCard("other-a"));
      expectNoShift(result);
      await expect(page.locator('[data-flip-key="sec-other"]')).toHaveCount(0);
      expect(result.cardFirst).not.toBeNull();
      expect(result.cardLast! - result.cardFirst!).toBeGreaterThan(0);
    });

    test("an Up next task: Completed today stays put, the card travels down past Other work", async ({ page }) => {
      await openPhoneToday(page);
      const result = await completeAndSample(page, phoneCheck("quest-b"), PHONE_WATCH, phoneCard("quest-b"));
      expectNoShift(result);
      expect(result.cardLast! - result.cardFirst!).toBeGreaterThan(0);
    });

    test("two completions in a row (past the double-tap guard): Completed today never moves", async ({ page }) => {
      await openPhoneToday(page);
      expectNoShift(await completeAndSample(page, phoneCheck("quest-a"), PHONE_WATCH, phoneCard("quest-a")));
      await page.waitForTimeout(450); // DOUBLE_TAP_COMPLETE_MS is 400
      expectNoShift(await completeAndSample(page, phoneCheck("other-a"), PHONE_WATCH, phoneCard("other-a")));
    });
  });
}

// ---------------------------------------------------------------------------
// Habits: ticking today's Habit (both apps)
// ---------------------------------------------------------------------------

/** Long enough to wrap on a phone: the title must not reflow into the play button's freed slot. */
const HABIT_TITLE = "Read twenty pages of the book on the nightstand before going to sleep tonight";
const HABIT: Habit = {
  id: "habit-wrap",
  title: HABIT_TITLE,
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: NOW - 3 * 86_400_000,
  updatedAt: 1,
} as Habit;

type Box = { width: number; height: number };
async function boxOf(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}
function expectSameBox(before: Box, after: Box, what: string): void {
  expect(Math.abs(after.width - before.width), `${what} width changed`).toBeLessThanOrEqual(TOLERANCE_PX);
  expect(Math.abs(after.height - before.height), `${what} height changed`).toBeLessThanOrEqual(TOLERANCE_PX);
}

for (const viewport of [
  { width: 360, height: 740 },
  { width: 1024, height: 768 },
]) {
  test.describe(`${viewport.width}x${viewport.height}: ticking a Habit never reflows its title`, () => {
    test.use({ viewport });

    test("phone app: the title keeps its box when ticked and reopened", async ({ page }) => {
      await openPhoneToday(page, [HABIT]);
      await page.evaluate(() => (window as unknown as { switchView: (v: string) => void }).switchView("habits"));
      const title = "#mainContainer .habits-grid .queue-item-title";
      await expect(page.locator(title)).toHaveText(HABIT_TITLE);
      await waitForSettledLayout(page);
      const before = await boxOf(page, title);

      await page.getByRole("button", { name: `Complete today's habit ${HABIT_TITLE}` }).click();
      await expect(page.getByRole("button", { name: `Reopen today's habit ${HABIT_TITLE}` })).toBeVisible();
      await expect(page.getByRole("button", { name: `Start focus on ${HABIT_TITLE}` })).toHaveCount(0);
      expectSameBox(before, await boxOf(page, title), "the ticked Habit's title");

      await page.getByRole("button", { name: `Reopen today's habit ${HABIT_TITLE}` }).click();
      await expect(page.getByRole("button", { name: `Start focus on ${HABIT_TITLE}` })).toBeVisible();
      expectSameBox(before, await boxOf(page, title), "the reopened Habit's title");
    });

    test("desktop: the title's column keeps its box when ticked and reopened", async ({ page }) => {
      await openDesktopHome(page, [HABIT]);
      await page.locator("header nav button", { hasText: /^Habits$/ }).click();
      const titleColumn = `[data-testid="habit-row"] button[aria-label="Open habit: ${HABIT_TITLE}"] >> xpath=..`;
      await expect(page.locator(titleColumn)).toBeVisible();
      await waitForSettledLayout(page);
      const before = await boxOf(page, titleColumn);

      await page.getByRole("button", { name: `Complete today's habit: ${HABIT_TITLE}` }).click();
      await expect(page.getByRole("button", { name: `Reopen today's habit: ${HABIT_TITLE}` })).toBeVisible();
      await expect(page.getByRole("button", { name: `Start focus: ${HABIT_TITLE}` })).toHaveCount(0);
      expectSameBox(before, await boxOf(page, titleColumn), "the ticked Habit's title column");

      await page.getByRole("button", { name: `Reopen today's habit: ${HABIT_TITLE}` }).click();
      await expect(page.getByRole("button", { name: `Start focus: ${HABIT_TITLE}` })).toBeVisible();
      expectSameBox(before, await boxOf(page, titleColumn), "the reopened Habit's title column");
    });
  });
}
