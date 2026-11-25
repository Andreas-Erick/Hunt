// @vitest-environment node
// Phone Habit card: Frequency label, a week strip whose days are told apart by shape and name (not
// colour alone), the Streak and the Success Rate, all from the shared core (HuntCore).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, pageErrors, type MobileWindow } from "./helpers/loadMobile";

// Monday 11 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 11, 10).getTime();
const BEGAN = new Date(2026, 4, 5, 9).getTime(); // Tue 5 May
const HABIT_ID = "hab-gym";

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

function dayRow(dateKey: string, extra: Record<string, unknown> = {}) {
  return {
    id: `habtsk-${dateKey}-${HABIT_ID}`,
    title: "Gym",
    notes: "",
    status: "queued",
    rank: 0,
    questId: null,
    habitId: HABIT_ID,
    scheduledDate: dateKey,
    accumulatedSeconds: 0,
    createdAt: BEGAN,
    updatedAt: BEGAN,
    ...extra,
  };
}

function habitsScreen(habit: Record<string, unknown>, tasks: unknown[]): MobileWindow {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks,
      habits: [{ id: HABIT_ID, title: "Gym", notes: "", questId: null, rank: 1000, createdAt: BEGAN, updatedAt: BEGAN, ...habit }],
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

describe("phone Habit card", () => {
  it("shows the Frequency, a week strip of named Outcomes, the Streak and the Success Rate", () => {
    const p = habitsScreen(
      {
        // Every day but Friday.
        frequencyHistory: [
          { effectiveFrom: "2026-05-05", frequency: { type: "weekdays", weekdays: [0, 1, 2, 3, 4, 6] } },
        ],
      },
      [
        dayRow("2026-05-05", { status: "completed" }),
        dayRow("2026-05-07", { skipped: true }),
        dayRow("2026-05-09", { status: "completed" }),
        dayRow("2026-05-10", { status: "completed" }),
        dayRow("2026-05-11"),
      ]
    );
    const c = card(p);
    expect(c.textContent).toContain("Mon, Tue, Wed, Thu, Sat, Sun");

    const strip = c.querySelector('ul[aria-label="Last 7 days"]');
    if (!strip) throw new Error("no week strip");
    const days = Array.from(strip.querySelectorAll("li"));
    expect(days.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Tue 5: Met",
      "Wed 6: Missed",
      "Thu 7: Skipped",
      "Fri 8: Not scheduled",
      "Sat 9: Met",
      "Sun 10: Met",
      "Mon 11 (today): Open",
    ]);
    expect(days.map((d) => d.getAttribute("data-outcome"))).toEqual([
      "met",
      "missed",
      "skipped",
      "none",
      "met",
      "met",
      "open",
    ]);
    // Met carries a tick and Missed a cross, so the two differ in shape, not just colour.
    expect(days[0].querySelector('[data-glyph="met"]')).not.toBeNull();
    expect(days[1].querySelector('[data-glyph="missed"]')).not.toBeNull();

    expect(c.textContent).toContain("2d");
    const rate = c.querySelector('[aria-label="Success Rate 75%"]');
    expect(rate?.textContent).toContain("75%");
    expect(pageErrors(p)).toEqual([]);
  });

  it("shows no Success Rate before any day was Met or Missed", () => {
    const p = habitsScreen({ createdAt: NOW }, []);
    expect(card(p).querySelector('ul[aria-label="Last 7 days"]')).not.toBeNull();
    expect(card(p).querySelector('[aria-label^="Success Rate"]')).toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });
});
