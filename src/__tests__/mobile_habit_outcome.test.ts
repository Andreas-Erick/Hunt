// @vitest-environment node
// Phone Habits screen: each card's Streak and 7-day dots come from the shared Outcome rule
// (HuntCore.summarizeHabitDays), so a day ticked after midnight counts for its scheduled day and an
// Open today keeps the Streak, exactly as on the desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, pageErrors, type MobileWindow } from "./helpers/loadMobile";

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

function localKey(daysAgo: number): string {
  const d = new Date(2026, 10, 18 - daysAgo, 12);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function dayRow(daysAgo: number, extra: Record<string, unknown> = {}) {
  const key = localKey(daysAgo);
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

function habitsScreen(tasks: unknown[]): MobileWindow {
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
  w.switchView("habits");
  return w;
}

function card(p: MobileWindow): Element {
  const el = p.document.querySelector("#mainContainer .habits-grid .queue-item-card");
  if (!el) throw new Error("no habit card");
  return el;
}

describe("phone Habits screen uses the shared Outcome rule", () => {
  it("counts a late tick for its scheduled day and keeps the Streak while today is Open", () => {
    const lateTick = new Date(2026, 10, 18, 0, 30).getTime();
    const p = habitsScreen([
      dayRow(2, { status: "completed", completedAt: new Date(2026, 10, 16, 9).getTime() }),
      dayRow(1, { status: "completed", completedAt: lateTick }),
      dayRow(0),
    ]);
    expect(card(p).textContent).toContain("2d");
    const days = Array.from(card(p).querySelectorAll('ul[aria-label="Last 7 days"] > li'));
    const met = days.filter((d) => d.getAttribute("data-outcome") === "met");
    expect(days).toHaveLength(7);
    expect(met).toHaveLength(2);
    expect(pageErrors(p)).toEqual([]);
  });

  it("shows no Streak once a Missed day ends it", () => {
    const p = habitsScreen([
      dayRow(2, { status: "completed", completedAt: new Date(2026, 10, 16, 9).getTime() }),
      dayRow(1),
      dayRow(0),
    ]);
    expect(card(p).textContent).not.toMatch(/\d+d/);
    expect(pageErrors(p)).toEqual([]);
  });
});
