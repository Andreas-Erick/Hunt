import { expect, test, type Page } from "@playwright/test";
import {
  LONG_QUEST_TITLE,
  LONG_TASK_TITLE,
  URL_TASK_TITLE,
  buildFixtures,
  buildMobileState,
  type GeometryFixtures,
} from "./fixtures";

/**
 * Geometry smoke test: every main view, at phone / tablet / desktop / 4K widths,
 * seeded with long unbroken text, must not scroll the page sideways, and the
 * Review scope menu must open fully on screen. jsdom cannot see any of this.
 */

const DESKTOP_VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
];

const PHONE_APP_VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 1024, height: 768 }, // tablet portrait/small landscape: day strip, not the board
  { width: 1180, height: 820 }, // narrowest width that shows the 5-column board
  { width: 1280, height: 800 },
];

/**
 * Plan-board task titles narrower than this are unreadable: the shipped bug (title sharing its row
 * with the play / options / delete buttons) left ~40px. Card actions now wrap under the title.
 */
const MIN_PLAN_TITLE_WIDTH = 100;

/** The phone app's localStorage key (STORAGE_KEY in public/hunt-mobile.html). */
const MOBILE_STORAGE_KEY = "hunt-mobile-standalone-v1";

/** The desktop app's Dexie database (src/lib/db.ts). */
const DESKTOP_DB_NAME = "JourneyCommandDB";

type Viewport = { width: number; height: number };

const label = (vp: Viewport) => `${vp.width}x${vp.height}`;

/**
 * Keeps both apps off /api/sync: the test server's data is throwaway anyway, but
 * a sync answer arriving mid-test would re-render the view being measured.
 */
async function blockSync(page: Page): Promise<void> {
  await page.route("**/api/sync**", (route) => route.abort());
}

/** Waits until fonts and two frames have settled, so layout is at rest. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        void document.fonts.ready.then(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      })
  );
}

interface OverflowReport {
  innerWidth: number;
  scrollWidth: number;
  offenders: string[];
}

/** Page-level horizontal overflow, plus the elements reaching furthest right when it overflows. */
async function measureOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const innerWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const offenders: string[] = [];
    if (scrollWidth > innerWidth + 1) {
      const hits: Array<{ right: number; desc: string }> = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.right <= innerWidth + 1) continue;
        // Report the deepest offenders: skip an element whose child also overflows.
        const childOverflows = Array.from(el.children).some(
          (c) => c.getBoundingClientRect().right > innerWidth + 1
        );
        if (childOverflows) continue;
        const cls = (el.getAttribute("class") || "").trim().split(/\s+/).slice(0, 3).join(".");
        const text = (el.textContent || "").trim().slice(0, 40);
        hits.push({
          right: Math.round(r.right),
          desc: `<${el.tagName.toLowerCase()}${cls ? "." + cls : ""}> right=${Math.round(
            r.right
          )} width=${Math.round(r.width)} "${text}"`,
        });
      }
      hits.sort((a, b) => b.right - a.right);
      offenders.push(...hits.slice(0, 5).map((h) => h.desc));
    }
    return { innerWidth, scrollWidth, offenders };
  });
}

async function expectNoHorizontalOverflow(
  page: Page,
  failures: string[],
  where: string
): Promise<void> {
  await settle(page);
  const r = await measureOverflow(page);
  if (r.scrollWidth > r.innerWidth + 1) {
    failures.push(
      `${where}: page scrollWidth ${r.scrollWidth}px > innerWidth ${r.innerWidth}px` +
        (r.offenders.length ? `\n    ${r.offenders.join("\n    ")}` : "")
    );
  }
}

/**
 * The Checklist editor (`[role=group][aria-label=Checklist]`) keeps every item control inside its
 * own box (a card with overflow hidden would clip, not scroll, so the page check cannot see it),
 * and each control is at least `minTarget` px square.
 */
async function checkChecklistEditor(
  page: Page,
  editor: ReturnType<Page["locator"]>,
  minTarget: number,
  where: string,
  failures: string[]
): Promise<void> {
  await expect(editor).toBeVisible();
  await settle(page);
  const problems = await editor.evaluate((root, min) => {
    const box = root.getBoundingClientRect();
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, input"))) {
      const r = el.getBoundingClientRect();
      const name = el.getAttribute("aria-label") || el.tagName.toLowerCase();
      if (r.right > box.right + 1 || r.left < box.left - 1) {
        out.push(`"${name.slice(0, 40)}" spans x=${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
      if (el.tagName === "BUTTON" && (r.width < min - 0.5 || r.height < min - 0.5)) {
        out.push(`"${name.slice(0, 40)}" is ${Math.round(r.width)}x${Math.round(r.height)}px (< ${min}px)`);
      }
    }
    return out;
  }, minTarget);
  for (const p of problems) failures.push(`${where} Checklist: ${p}`);
}

// ---------------------------------------------------------------------------
// Desktop app (/)
// ---------------------------------------------------------------------------

/** Replaces every Dexie table's rows with the fixtures, writing straight into IndexedDB. */
async function seedDesktopDb(page: Page, fixtures: GeometryFixtures): Promise<void> {
  await page.evaluate(
    async ({ dbName, data }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        // No version: open whatever schema the app's Dexie boot just created.
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const stores = ["quests", "tasks", "habits", "timeLogs"] as const;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores as unknown as string[], "readwrite");
        for (const name of stores) {
          const store = tx.objectStore(name);
          store.clear();
          for (const row of data[name]) store.put(row);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    },
    { dbName: DESKTOP_DB_NAME, data: fixtures }
  );
}

async function openSeededDesktopApp(page: Page): Promise<void> {
  await blockSync(page);
  await page.goto("/");
  // The first boot creates the Dexie schema (and seeds its starter template).
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
  await seedDesktopDb(page, buildFixtures());
  await page.reload();
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(LONG_TASK_TITLE).first()).toBeVisible();
}

const DESKTOP_VIEWS: Array<{ nav: string; marker?: (page: Page) => Promise<void> }> = [
  { nav: "Home", marker: (p) => expect(p.getByText(LONG_TASK_TITLE).first()).toBeVisible() },
  { nav: "Plan", marker: (p) => expect(p.getByText(LONG_TASK_TITLE).first()).toBeVisible() },
  { nav: "Quests", marker: (p) => expect(p.getByText(LONG_QUEST_TITLE).first()).toBeVisible() },
  { nav: "Habits", marker: (p) => expect(p.getByText(URL_TASK_TITLE).first()).toBeVisible() },
  {
    nav: "Review",
    marker: (p) => expect(p.locator('button[aria-haspopup="listbox"]')).toBeVisible(),
  },
  { nav: "Guide" },
];

async function clickDesktopNav(page: Page, name: string): Promise<void> {
  const button = page.locator("header nav button", { hasText: new RegExp(`^${name}$`) });
  await button.click();
}

/** Opens the Review scope menu and checks its listbox lies fully inside the viewport. */
async function checkReviewScopeMenu(page: Page, vp: Viewport, failures: string[]): Promise<void> {
  const trigger = page.locator('button[aria-haspopup="listbox"]');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await settle(page);
  const box = await listbox.boundingBox();
  if (!box) {
    failures.push(`${label(vp)} Review scope menu: listbox has no bounding box`);
    return;
  }
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const edges = [
    box.x < 0 && `left edge at x=${Math.round(box.x)}px (< 0)`,
    right > vp.width + 1 && `right edge at x=${Math.round(right)}px (> ${vp.width})`,
    box.y < 0 && `top edge at y=${Math.round(box.y)}px (< 0)`,
    bottom > vp.height + 1 && `bottom edge at y=${Math.round(bottom)}px (> ${vp.height})`,
  ].filter(Boolean);
  if (edges.length) {
    failures.push(
      `${label(vp)} Review scope menu off-screen (box ${Math.round(box.x)},${Math.round(
        box.y
      )} ${Math.round(box.width)}x${Math.round(box.height)}): ${edges.join(", ")}`
    );
  }
  await page.keyboard.press("Escape");
}

// Both looks (ADR-0005): Dawn's serif and grotesk have different widths from Neon's faces.
const LOOKS = ["neon", "dawn"] as const;

for (const look of LOOKS) {
test.describe(`desktop app geometry (${look})`, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((value) => window.localStorage.setItem("hunt-look", value), look);
  });
  for (const vp of DESKTOP_VIEWPORTS) {
    test(`${label(vp)}: no horizontal overflow in any view; Review menu on screen`, async ({
      page,
    }) => {
      await page.setViewportSize(vp);
      await openSeededDesktopApp(page);
      const failures: string[] = [];

      for (const view of DESKTOP_VIEWS) {
        await clickDesktopNav(page, view.nav);
        await expect(
          page.locator("header nav button[aria-current='page']")
        ).toHaveText(view.nav);
        await view.marker?.(page);
        await expectNoHorizontalOverflow(page, failures, `${label(vp)} desktop ${view.nav}`);
        if (view.nav === "Review") await checkReviewScopeMenu(page, vp, failures);
      }

      // The Checklist editor inside the long Task's drawer (n/m progress shows on its row).
      await clickDesktopNav(page, "Home");
      const longRow = page.locator("[data-testid='task-row'][data-task-id='task-long']");
      await expect(longRow.getByLabel("Checklist: 1 of 3 done")).toBeVisible();
      await longRow.getByTitle("Task notes & options").click();
      await checkChecklistEditor(page, longRow.getByRole("group", { name: "Checklist" }), 32, `${label(vp)} desktop Home`, failures);
      await expectNoHorizontalOverflow(page, failures, `${label(vp)} desktop Home drawer`);

      // The long Habit's edit panel: its reminder time chips and Add control.
      await clickDesktopNav(page, "Habits");
      await page.locator("[data-habit-id='habit-long']").getByRole("button", { name: /^Edit habit/ }).click();
      const reminders = page.locator("[data-habit-id='habit-long']").getByRole("group", { name: /^Reminders/ });
      await checkChecklistEditor(page, reminders, 32, `${label(vp)} desktop Habits reminders`, failures);
      await expectNoHorizontalOverflow(page, failures, `${label(vp)} desktop Habits edit`);

      // Focus hides the header, so it goes last.
      await clickDesktopNav(page, "Focus");
      await expect(page.locator("header")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, failures, `${label(vp)} desktop Focus`);

      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
}

// ---------------------------------------------------------------------------
// Phone / tablet app (/hunt-mobile.html)
// ---------------------------------------------------------------------------

/** How each phone-app view is opened: a nav button, or switchView() where no button is always shown. */
const MOBILE_VIEWS: Array<{ name: string; bodyView: string; open: string | null }> = [
  { name: "Today", bodyView: "command", open: "#nav-command" },
  { name: "Plan", bodyView: "plan", open: "#nav-plan" },
  { name: "Quests", bodyView: "quests", open: "#nav-quests" },
  { name: "Habits", bodyView: "habits", open: "#nav-habits" },
  { name: "Review", bodyView: "telemetry", open: "#reviewBtn" },
  { name: "Guide", bodyView: "guide", open: null },
  { name: "Focus", bodyView: "focus", open: "#nav-focus" },
];

async function openSeededPhoneApp(page: Page): Promise<void> {
  await blockSync(page);
  const state = JSON.stringify(buildMobileState(buildFixtures()));
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [MOBILE_STORAGE_KEY, state] as const
  );
  await page.goto("/hunt-mobile.html");
  await expect(page.locator("#bottomNav")).toBeAttached();
  await expect(page.getByText(LONG_TASK_TITLE).first()).toBeVisible();
}

async function openMobileView(page: Page, view: (typeof MOBILE_VIEWS)[number]): Promise<void> {
  const button = view.open ? page.locator(view.open) : null;
  if (button && (await button.isVisible())) {
    await button.click();
  } else {
    await page.evaluate((v) => {
      (window as unknown as { switchView: (v: string) => void }).switchView(v);
    }, view.bodyView);
  }
  await expect(page.locator("body")).toHaveAttribute("data-view", view.bodyView);
}

async function checkTabletPlanTitles(page: Page, vp: Viewport, failures: string[]): Promise<void> {
  const titles = page.locator(".plan-board-grid .plan-col-tasks .queue-item-title");
  await expect(titles.first()).toBeVisible();
  const widths = await titles.evaluateAll((els) =>
    els.map((el) => ({
      width: Math.round(el.getBoundingClientRect().width),
      text: (el.textContent || "").trim().slice(0, 40),
    }))
  );
  for (const w of widths) {
    if (w.width < MIN_PLAN_TITLE_WIDTH) {
      failures.push(
        `${label(vp)} phone-app Plan board: task title "${w.text}" is ${w.width}px wide (< ${MIN_PLAN_TITLE_WIDTH}px)`
      );
    }
  }
}

for (const look of LOOKS) {
test.describe(`phone app geometry (${look})`, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((value) => window.localStorage.setItem("hunt-look", value), look);
  });
  for (const vp of PHONE_APP_VIEWPORTS) {
    test(`${label(vp)}: no horizontal overflow in any view`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openSeededPhoneApp(page);
      const failures: string[] = [];
      const isTablet = vp.width >= 1180; // PLAN_BOARD_QUERY in hunt-mobile.html

      for (const view of MOBILE_VIEWS) {
        await openMobileView(page, view);
        await expectNoHorizontalOverflow(page, failures, `${label(vp)} phone-app ${view.name}`);
        if (view.bodyView === "plan" && isTablet) {
          await expect(page.locator(".plan-board-grid")).toBeVisible();
          await checkTabletPlanTitles(page, vp, failures);
        }
      }

      // Task Options of the long Task: its Checklist editor (48px Android targets).
      await openMobileView(page, MOBILE_VIEWS[0]);
      await expect(page.getByLabel("Checklist: 1 of 3 done").first()).toBeVisible();
      await page.evaluate(() => {
        (window as unknown as { openTaskInspectorSheet: (id: string) => void }).openTaskInspectorSheet("task-long");
      });
      const sheetEditor = page.locator("#sheetContainer").getByRole("group", { name: "Checklist" });
      await checkChecklistEditor(page, sheetEditor, 48, `${label(vp)} phone-app Task Options`, failures);
      await expectNoHorizontalOverflow(page, failures, `${label(vp)} phone-app Task Options`);

      // The long Habit's sheet: its reminder time chips and Add control (48px Android targets).
      await page.evaluate(() => {
        (window as unknown as { openHabitEditorSheet: (id: string) => void }).openHabitEditorSheet("habit-long");
      });
      const habitReminders = page.locator("#sheetContainer").getByRole("group", { name: "Habit reminders" });
      await checkChecklistEditor(page, habitReminders, 48, `${label(vp)} phone-app Habit reminders`, failures);
      await expectNoHorizontalOverflow(page, failures, `${label(vp)} phone-app Habit sheet`);

      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});
}
