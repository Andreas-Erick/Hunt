// @vitest-environment node
// Phone Habits screen: Skip today and Undo skip (#18). The day Task is written with the shared rule
// (HuntCore.skipHabitDayRow), so a Skipped day leaves Today, keeps the Streak and syncs the same row
// shape as the desktop's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 18, 10, 0).getTime();
const HABIT_ID = "hab-read";
const TODAY = "2026-11-18";
const TODAY_TID = `habtsk-${TODAY}-${HABIT_ID}`;

let w: MobileWindow | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function dayRow(key: string, extra: Record<string, unknown> = {}) {
  return {
    id: `habtsk-${key}-${HABIT_ID}`,
    title: "Read 20 pages",
    notes: "",
    status: "queued",
    rank: 0,
    questId: null,
    habitId: HABIT_ID,
    scheduledDate: key,
    accumulatedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function load(tasks: unknown[]): MobileWindow {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks,
      habits: [{ id: HABIT_ID, title: "Read 20 pages", notes: "", questId: null, rank: 1000, createdAt: 1, updatedAt: 1 }],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 0,
    },
  });
  return w;
}

const main = (p: MobileWindow) => p.document.getElementById("mainContainer") as HTMLElement;
const button = (p: MobileWindow, label: string) =>
  p.document.querySelector(`button[aria-label="${label}"]`);
/** Skip lives in the Habit's sheet (opened from its card), Undo skip on the card itself. */
const openSheet = (p: MobileWindow) =>
  click(p, main(p).querySelector('button[aria-label="Edit habit Read 20 pages"]'));
const todayRow = (p: MobileWindow) =>
  (readState(p).tasks as { id: string; skipped?: boolean; updatedAt?: number }[]).find((t) => t.id === TODAY_TID);

describe("phone Habits screen: Skip today", () => {
  it("skips today's day, leaves it off Today, and undoes the Skip", () => {
    const p = load([dayRow(TODAY)]);
    p.switchView("habits");
    openSheet(p);
    click(p, button(p, "Skip today: Read 20 pages"));
    expect(todayRow(p)?.skipped).toBe(true);
    expect(todayRow(p)?.updatedAt).toBeGreaterThan(1);
    expect(main(p).textContent).toContain("Skipped today");
    expect(main(p).textContent).toContain("0 / 0 done today");

    p.switchView("command");
    expect(main(p).textContent).not.toContain("Read 20 pages");

    p.switchView("habits");
    click(p, button(p, "Undo skip: Read 20 pages"));
    expect(todayRow(p)?.skipped).toBeUndefined();
    openSheet(p);
    expect(button(p, "Skip today: Read 20 pages")).not.toBeNull();
    p.switchView("command");
    expect(main(p).textContent).toContain("Read 20 pages");
    expect(pageErrors(p)).toEqual([]);
  });

  it("creates today's day Task when it is missing, then skips it", () => {
    const p = load([]);
    p.switchView("habits");
    openSheet(p);
    click(p, button(p, "Skip today: Read 20 pages"));
    expect(todayRow(p)?.skipped).toBe(true);
    expect(pageErrors(p)).toEqual([]);
  });

  it("keeps the Streak across a Skipped day", () => {
    const at = (d: number) => new Date(2026, 10, d, 9).getTime();
    const p = load([
      dayRow("2026-11-15", { status: "completed", completedAt: at(15) }),
      dayRow("2026-11-16", { skipped: true }),
      dayRow("2026-11-17", { status: "completed", completedAt: at(17) }),
      dayRow(TODAY),
    ]);
    p.switchView("habits");
    expect(main(p).querySelector(".habits-grid .queue-item-card")?.textContent).toContain("2d");
    expect(pageErrors(p)).toEqual([]);
  });
});
