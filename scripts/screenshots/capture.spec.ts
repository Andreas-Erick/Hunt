import path from "path";
import { expect, test, type Page } from "@playwright/test";
import { buildDemoData, type DemoData } from "./demoData";

/**
 * Regenerates docs/screenshots/*.png from the current build with made-up demo data:
 * `npm run screenshots`. The browser clock is frozen at 15:20 UTC today so the timeline,
 * streaks and Review windows look the same on every run.
 */

// HUNT_SHOTS_LOOK=dawn captures the Dawn look (ADR-0005); HUNT_SHOTS_OUT writes elsewhere
// (e.g. a scratch folder for review) instead of overwriting the README images.
const LOOK = process.env.HUNT_SHOTS_LOOK === "dawn" ? "dawn" : "neon";
const OUT = process.env.HUNT_SHOTS_OUT ?? path.resolve(__dirname, "..", "..", "docs", "screenshots");
const LOOK_KEY = "hunt-look"; // LOOK_STORAGE_KEY in src/lib/lookPreference.ts and the phone page
const DESKTOP_DB_NAME = "JourneyCommandDB"; // src/lib/db.ts
const DESKTOP_FOCUS_KEY = "journey-hud-command-store"; // zustand persist name in useCommandStore.ts
const PHONE_STATE_KEY = "hunt-mobile-standalone-v1"; // STORAGE_KEY in public/hunt-mobile.html

const today = new Date().toISOString().slice(0, 10);
const NOW = Date.parse(`${today}T15:20:00Z`);
const FOCUS_STARTED = NOW - 24 * 60_000 - 13_000;

/** Answers /api/sync like a healthy laptop: the posted state comes back unchanged. */
async function fakeHealthySync(page: Page, data: DemoData): Promise<void> {
  await page.route("**/api/sync**", async (route) => {
    const req = route.request();
    const posted = req.method() === "POST" ? (req.postDataJSON() as Record<string, unknown>) : null;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        payload: posted ?? { ...data, deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], deletedHabitIds: [], activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 }, lastSyncedAt: NOW },
        lanUrls: ["http://192.168.1.20:3000"],
        peers: { phone: { lastSeenAt: NOW - 4 * 60_000 } },
      }),
    });
  });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => void document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  );
  await page.waitForTimeout(400);
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

// ---------------------------------------------------------------------------
// Desktop app
// ---------------------------------------------------------------------------

async function applyShotLook(page: Page): Promise<void> {
  await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [LOOK_KEY, LOOK] as const);
}

async function openDesktop(page: Page, data: DemoData, focusTaskId?: string): Promise<void> {
  await applyShotLook(page);
  await page.clock.setFixedTime(NOW);
  await fakeHealthySync(page, data);
  await page.goto("/");
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
  const tasks = data.tasks.map((t) => (t.id === focusTaskId ? { ...t, status: "active" as const } : t));
  await page.evaluate(
    async ({ dbName, rows, focus }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const stores = ["quests", "tasks", "habits", "timeLogs"];
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        for (const name of stores) {
          const store = tx.objectStore(name);
          store.clear();
          for (const row of rows[name as keyof typeof rows]) store.put(row);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      if (focus) localStorage.setItem(focus.key, JSON.stringify({ state: focus.state, version: 0 }));
      else localStorage.removeItem("journey-hud-command-store");
    },
    {
      dbName: DESKTOP_DB_NAME,
      rows: { ...data, tasks },
      focus: focusTaskId
        ? { key: DESKTOP_FOCUS_KEY, state: { activeTaskId: focusTaskId, isRunning: true, sessionStartedAt: FOCUS_STARTED, focusUpdatedAt: FOCUS_STARTED } }
        : null,
    }
  );
  await page.reload();
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
}

async function desktopView(page: Page, name: string): Promise<void> {
  await page.locator("header nav button", { hasText: new RegExp(`^${name}$`) }).click();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: "UTC", locale: "en-US" });

  test("home, habits, review", async ({ page }) => {
    const data = buildDemoData(NOW);
    await openDesktop(page, data);
    await expect(page.getByText("Fix offline sync for shared budgets").first()).toBeVisible();
    await shoot(page, "desktop-home");
    await desktopView(page, "Habits");
    await expect(page.getByText("15 minutes of vocabulary").first()).toBeVisible();
    await shoot(page, "desktop-habits");
    await desktopView(page, "Review");
    await expect(page.locator('button[aria-haspopup="listbox"]')).toBeVisible();
    await shoot(page, "desktop-review");
  });

  test("focus", async ({ page }) => {
    const data = buildDemoData(NOW);
    await openDesktop(page, data, "t-sync");
    await desktopView(page, "Focus");
    await expect(page.getByTestId("focus-timer")).toBeVisible();
    await shoot(page, "desktop-focus");
  });
});

// ---------------------------------------------------------------------------
// Phone app
// ---------------------------------------------------------------------------

test.describe("phone", () => {
  test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, timezoneId: "UTC", locale: "en-US" });

  test("today, habits, review", async ({ page }) => {
    const data = buildDemoData(NOW);
    const state = {
      ...data,
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      deletedHabitIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: NOW - 60_000,
    };
    await page.clock.setFixedTime(NOW);
    await fakeHealthySync(page, data);
    await applyShotLook(page);
    await page.addInitScript(([key, value]) => window.localStorage.setItem(key, value), [PHONE_STATE_KEY, JSON.stringify(state)] as const);
    await page.goto("/hunt-mobile.html");
    await expect(page.locator("#bottomNav")).toBeAttached();
    await expect(page.getByText("Fix offline sync for shared budgets").first()).toBeVisible();
    await shoot(page, "mobile-today");
    await page.locator("#nav-habits").click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "habits");
    await shoot(page, "mobile-habits");
    await page.locator("#reviewBtn").click();
    await expect(page.locator("body")).toHaveAttribute("data-view", "telemetry");
    await shoot(page, "mobile-review");
  });
});
