// @vitest-environment node
// Phone Habit detail, Calendar tab (#25): tapping a Habit card opens its detail sheet with a month of
// Outcomes, month navigation and its notes; a past day is ticked, unticked or Skipped with the shared
// rule (HuntCore.correctHabitDayRow), the same row the desktop writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 18, 10, 0).getTime();
const HABIT_ID = "hab-read";

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
      habits: [
        {
          id: HABIT_ID,
          title: "Read 20 pages",
          notes: "Before bed, paper book",
          questId: null,
          rank: 1000,
          createdAt: new Date(2026, 9, 20, 8).getTime(),
          updatedAt: 1,
        },
      ],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 0,
    },
  });
  w.switchView("habits");
  click(w, w.document.querySelector('[aria-label="Open habit Read 20 pages"]'));
  return w;
}

const sheet = (p: MobileWindow) => p.document.getElementById("sheetContainer") as HTMLElement;
const inSheet = (p: MobileWindow, label: string) => sheet(p).querySelector(`[aria-label="${label}"]`);
const row = (p: MobileWindow, key: string) =>
  (readState(p).tasks as { id: string; status: string; skipped?: boolean; updatedAt?: number }[]).find(
    (t) => t.id === `habtsk-${key}-${HABIT_ID}`
  );

describe("phone Habit detail: Calendar tab", () => {
  it("shows the month of Outcomes and the notes under a Calendar tab", () => {
    const p = load([
      dayRow("2026-11-10", { status: "completed", completedAt: NOW - 8 * 86_400_000 }),
      dayRow("2026-11-11", { skipped: true }),
    ]);
    const tab = sheet(p).querySelector('[role="tab"][aria-selected="true"]');
    expect(tab?.textContent).toContain("Calendar");
    expect(sheet(p).textContent).toContain("November 2026");
    expect(inSheet(p, "10 November: Met")?.tagName).toBe("BUTTON");
    expect(inSheet(p, "11 November: Skipped")).not.toBeNull();
    expect(inSheet(p, "12 November: Missed")).not.toBeNull();
    expect(inSheet(p, "18 November: Open")).not.toBeNull();
    expect(inSheet(p, "19 November: no Outcome")?.tagName).not.toBe("BUTTON");
    expect(sheet(p).textContent).toContain("Before bed, paper book");
    expect(pageErrors(p)).toEqual([]);
  });

  it("moves between months, from the Habit's first month to today's", () => {
    const p = load([]);
    expect((inSheet(p, "Next month") as HTMLButtonElement).disabled).toBe(true);
    click(p, inSheet(p, "Previous month"));
    expect(sheet(p).textContent).toContain("October 2026");
    expect(inSheet(p, "19 October: no Outcome")?.tagName).not.toBe("BUTTON");
    expect(inSheet(p, "20 October: Missed")).not.toBeNull();
    expect((inSheet(p, "Previous month") as HTMLButtonElement).disabled).toBe(true);
    click(p, inSheet(p, "Next month"));
    expect(sheet(p).textContent).toContain("November 2026");
    expect(pageErrors(p)).toEqual([]);
  });

  it("ticks a Missed past day, unticks it, Skips it and undoes the Skip", () => {
    const p = load([]);
    click(p, inSheet(p, "12 November: Missed"));
    click(p, inSheet(p, "Tick 12 November"));
    expect(row(p, "2026-11-12")?.status).toBe("completed");
    expect(row(p, "2026-11-12")?.updatedAt).toBeGreaterThanOrEqual(NOW);
    expect(inSheet(p, "12 November: Met")).not.toBeNull();

    click(p, inSheet(p, "Untick 12 November"));
    expect(row(p, "2026-11-12")?.status).toBe("queued");

    click(p, inSheet(p, "Skip 12 November"));
    expect(row(p, "2026-11-12")?.skipped).toBe(true);
    expect(inSheet(p, "12 November: Skipped")).not.toBeNull();
    click(p, inSheet(p, "Undo skip 12 November"));
    expect(row(p, "2026-11-12")).not.toHaveProperty("skipped");
    expect(pageErrors(p)).toEqual([]);
  });
});
