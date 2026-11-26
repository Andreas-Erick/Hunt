import { test, expect, type Page } from "@playwright/test";
import { buildFixtures, buildMobileState, type GeometryFixtures } from "./fixtures";
import type { Task } from "../src/lib/domainTypes";

/**
 * Toggle stability sweep: pressing a control that changes a row's state in
 * place (tick a Habit, log a Slip, skip today, +1, tick a List item) must not
 * move or resize anything else on the screen. A button that only shows in one
 * state keeps its slot when hidden, and a label that changes keeps its width,
 * so no neighbouring text reflows.
 *
 * The sweep finds the controls itself: every `role="checkbox"` / `role="switch"`
 * on the screen, plus every control named by STATE_CONTROLS. Each one is
 * pressed and, where it can be, pressed back. Every text element whose text is
 * the same before and after must keep its box (relative to the view, so a
 * scroll is not a shift). Text that changed (a label, "1 / 3") is the change
 * itself and is not compared; if its new width pushes a neighbour, the
 * neighbour fails.
 *
 * A new in-place control is covered as soon as it is a checkbox/switch or is
 * added to STATE_CONTROLS. jsdom has no layout, so only a browser sees these.
 */

/** Wall clock (not pinned): the phone's double-tap guard runs on real time. */
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);
/** Sub-pixel rounding is not a shift. */
const TOLERANCE_PX = 1;

/**
 * Controls that change a row's state where it stands, by accessible name
 * (desktop names put a colon before the title, the phone's do not). `back` is
 * the control that undoes the press on the same row, if the row offers one.
 */
const STATE_CONTROLS: Array<{ what: string; flip: RegExp; back: RegExp | null }> = [
  { what: "tick today's Habit", flip: /^Complete today's habit:? /, back: /^Reopen today's habit:? / },
  { what: "log a Slip", flip: /^Log a Slip on /, back: /^Undo Slip on / },
  { what: "skip today", flip: /^Skip today: /, back: /^Undo skip: / },
  { what: "add 1 to a Count Habit", flip: /^Add 1 to /, back: null },
  // The phone skips from a sheet; only its undo is in the row (the sweep pre-skips SKIPPED_HABIT there).
  { what: "undo a Skip", flip: /^Undo skip: /, back: null },
];

/** A second Check Habit, skipped today on the phone before the sweep so its in-row Undo skip is pressed. */
const SKIPPED_HABIT = "habit-skipped";

/** The geometry fixtures, with the Count Habit one short of its target so "+1" Meets today. */
function fixtures(): GeometryFixtures {
  const f = buildFixtures(NOW);
  const countToday = {
    id: `habtsk-${TODAY}-habit-count`,
    title: f.habits.find((h) => h.id === "habit-count")!.title,
    notes: "",
    questId: null,
    habitId: "habit-count",
    status: "queued",
    rank: 7000,
    accumulatedSeconds: 0,
    scheduledDate: TODAY,
    amount: 11.5,
    createdAt: NOW - 60_000,
    updatedAt: 1,
  } as Task;
  const check = f.habits.find((h) => h.id === "habit-long")!;
  const skipped = { ...check, id: SKIPPED_HABIT, title: "Stretch for ten minutes after the evening walk", rank: 5000 };
  return { ...f, habits: [...f.habits, skipped], tasks: [...f.tasks, countToday] };
}

// ---------------------------------------------------------------------------
// Opening each app's screens
// ---------------------------------------------------------------------------

interface Screen {
  app: "desktop" | "phone";
  name: string;
  /** The view's content: positions are measured relative to it. */
  root: string;
  open(page: Page): Promise<void>;
  /** What the sweep must find here, so a renamed label cannot quietly blind it. */
  expects: string[];
}

async function openDesktop(page: Page, nav: string): Promise<void> {
  await page.route("**/api/sync**", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
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
  }, fixtures());
  await page.reload();
  await expect(page.locator("header nav")).toBeVisible({ timeout: 30_000 });
  await page.locator("header nav button", { hasText: new RegExp(`^${nav}$`) }).click();
}

async function openPhone(page: Page, view: "habits" | "lists"): Promise<void> {
  await page.route("**/api/sync**", (route) => route.abort());
  const state = buildMobileState(fixtures());
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["hunt-mobile-standalone-v1", JSON.stringify(state)] as const
  );
  await page.goto("/hunt-mobile.html");
  await expect(page.locator("#bottomNav")).toBeAttached();
  await page.evaluate((v) => (window as unknown as { switchView: (v: string) => void }).switchView(v), view);
  await expect(page.locator("body")).toHaveAttribute("data-view", view);
}

const SCREENS: Screen[] = [
  {
    app: "desktop",
    name: "Habits",
    root: "main",
    open: async (page) => {
      await openDesktop(page, "Habits");
      await expect(page.getByTestId("habit-row").first()).toBeVisible();
    },
    expects: ["tick today's Habit", "log a Slip", "skip today", "add 1 to a Count Habit"],
  },
  {
    app: "desktop",
    name: "Lists",
    root: "main",
    open: async (page) => {
      await openDesktop(page, "Lists");
      await expect(page.getByRole("checkbox").first()).toBeVisible();
    },
    expects: ["tick a checkbox"],
  },
  {
    app: "phone",
    name: "Habits",
    root: "#mainContainer",
    open: async (page) => {
      await openPhone(page, "habits");
      await expect(page.locator("#mainContainer .habits-grid .queue-item-card").first()).toBeVisible();
      await page.evaluate(
        (id) => (window as unknown as { setHabitTodaySkipped: (id: string, on: boolean) => void }).setHabitTodaySkipped(id, true),
        SKIPPED_HABIT
      );
      await expect(page.getByRole("button", { name: /^Undo skip: Stretch/ })).toBeVisible();
    },
    expects: ["tick today's Habit", "log a Slip", "add 1 to a Count Habit", "undo a Skip"],
  },
  {
    app: "phone",
    name: "Lists",
    root: "#mainContainer",
    open: async (page) => {
      await openPhone(page, "lists");
      await expect(page.locator("#mainContainer [role=checkbox]").first()).toBeVisible();
    },
    expects: ["tick a checkbox"],
  },
];

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

type Boxes = Record<string, { x: number; y: number; w: number; h: number }>;

/**
 * Every visible text element in the view (an element with its own text, or a
 * field with a value), keyed by tag + text + occurrence, boxed relative to the
 * view. Live regions (toasts) float over the page and are left out.
 */
async function snapshot(page: Page, root: string): Promise<Boxes> {
  return page.evaluate((rootSel) => {
    const rootEl = document.querySelector(rootSel)!;
    const origin = rootEl.getBoundingClientRect();
    const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {};
    const seen = new Map<string, number>();
    for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>("*"))) {
      if (el.closest("[aria-live], [role=status], [role=alert]")) continue;
      // A slot's hidden states hold space but are not shown: only what is seen is measured.
      if (el.closest("[inert]") || getComputedStyle(el).visibility === "hidden") continue;
      let text = "";
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = el.value;
      else {
        for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) text += n.textContent;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Keyed within its row (a Habit card, a List), so a text that leaves one row does not renumber the next.
      const row =
        el.closest<HTMLElement>("[data-habit-id]")?.dataset.habitId ??
        el.closest("[role=region], section")?.getAttribute("aria-label") ??
        "";
      const shown = text.length > 40 ? text.slice(0, 37) + "..." : text;
      const base = `${row ? `[${row.length > 24 ? row.slice(0, 21) + "..." : row}] ` : ""}${el.tagName.toLowerCase()} "${shown}"`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      boxes[n > 1 ? `${base} #${n}` : base] = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    }
    return boxes;
  }, root);
}

/** One line per press: how many texts moved or resized, and the first few. */
function compare(before: Boxes, after: Boxes, where: string, failures: string[]): void {
  const fmt = (v: Boxes[string]) => `${v.x.toFixed(0)},${v.y.toFixed(0)} ${v.w.toFixed(0)}x${v.h.toFixed(0)}`;
  const shifted: string[] = [];
  for (const [key, a] of Object.entries(before)) {
    const b = after[key];
    if (!b) continue; // its text changed: the change itself
    const moved = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const resized = Math.max(Math.abs(b.w - a.w), Math.abs(b.h - a.h));
    if (moved > TOLERANCE_PX || resized > TOLERANCE_PX) shifted.push(`${key} ${fmt(a)} -> ${fmt(b)}`);
  }
  if (shifted.length === 0) return;
  const indent = "\n      ";
  failures.push(`${where}: ${shifted.length} text(s) shifted, e.g.${indent}${shifted.slice(0, 3).join(indent)}`);
}

/** Fonts in, two frames, and past the phone's 400 ms double-tap guard, the store write and the 150 ms transitions. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.fonts.ready.then(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    )
  );
  await page.waitForTimeout(450);
}

// ---------------------------------------------------------------------------
// Finding the controls
// ---------------------------------------------------------------------------

interface Control {
  what: string;
  /** Its accessible name before the press. */
  label: string;
  /** The name of the control that undoes it, once pressed (null: nothing to press back). */
  backLabel: RegExp | null;
  checkbox: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findControls(page: Page, root: string): Promise<Control[]> {
  const found = await page.evaluate(
    ({ rootSel, patterns }) => {
      const rootEl = document.querySelector(rootSel)!;
      const out: Array<{ label: string; checkbox: boolean; pattern: number }> = [];
      for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>("button, [role=checkbox], [role=switch]"))) {
        if ((el as HTMLButtonElement).disabled || el.getClientRects().length === 0) continue;
        if (el.closest("[inert]") || getComputedStyle(el).visibility === "hidden") continue;
        const label = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
        const role = el.getAttribute("role");
        if (role === "checkbox" || role === "switch") {
          out.push({ label, checkbox: true, pattern: -1 });
          continue;
        }
        const pattern = patterns.findIndex((p) => new RegExp(p).test(label));
        if (pattern !== -1) out.push({ label, checkbox: false, pattern });
      }
      return out;
    },
    { rootSel: root, patterns: STATE_CONTROLS.map((c) => c.flip.source) }
  );
  return found.map(({ label, checkbox, pattern }) => {
    if (checkbox) return { what: "tick a checkbox", label, backLabel: new RegExp(`^${escapeRe(label)}$`), checkbox };
    const spec = STATE_CONTROLS[pattern];
    const subject = label.replace(spec.flip, "");
    return {
      what: spec.what,
      label,
      backLabel: spec.back ? new RegExp(`${spec.back.source}${escapeRe(subject)}$`) : null,
      checkbox,
    };
  });
}

function controlNamed(page: Page, root: string, name: string | RegExp, checkbox: boolean) {
  const exact = typeof name === "string" ? new RegExp(`^${escapeRe(name)}$`) : name;
  return page.locator(root).getByRole(checkbox ? "checkbox" : "button", { name: exact }).first();
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

for (const viewport of [
  { width: 360, height: 740 },
  { width: 820, height: 1180 },
  { width: 1440, height: 900 },
]) {
  for (const screen of SCREENS) {
    test(`${viewport.width}x${viewport.height} ${screen.app} ${screen.name}: a state control moves nothing else`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await screen.open(page);
      await settle(page);

      const controls = await findControls(page, screen.root);
      const kinds = new Set(controls.map((c) => c.what));
      for (const what of screen.expects) expect(kinds.has(what), `the sweep found no control to ${what}`).toBe(true);

      const failures: string[] = [];
      for (const c of controls) {
        const where = `${viewport.width}px ${screen.app} ${screen.name}, ${c.what} "${c.label.slice(0, 50)}"`;
        const control = controlNamed(page, screen.root, c.label, c.checkbox);
        if ((await control.count()) === 0) continue; // an earlier press removed it (e.g. Skip once Met)
        const checkedBefore = c.checkbox ? await control.getAttribute("aria-checked") : null;

        const before = await snapshot(page, screen.root);
        await control.click();
        if (c.checkbox) await expect(control).not.toHaveAttribute("aria-checked", checkedBefore ?? "");
        else if (c.backLabel) await expect(controlNamed(page, screen.root, c.backLabel, false)).toBeVisible();
        await settle(page);
        compare(before, await snapshot(page, screen.root), `${where} (pressed)`, failures);

        if (!c.backLabel) continue;
        await controlNamed(page, screen.root, c.backLabel, c.checkbox).click();
        if (c.checkbox) await expect(control).toHaveAttribute("aria-checked", checkedBefore ?? "");
        else await expect(controlNamed(page, screen.root, c.label, false)).toBeVisible();
        await settle(page);
        compare(before, await snapshot(page, screen.root), `${where} (pressed back)`, failures);
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
}
