// @vitest-environment node
// Phone Ended Habits: the Habit sheet sets, moves and clears an end date; an Ended Habit leaves Today
// and the Habits list for a collapsed "Ended" section with its history, and a restart never counts
// the days it was Ended, through the same shared rules as the desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

// Wednesday 20 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 20, 10).getTime();
const TODAY = "2026-05-20";
const HABIT_ID = "hab-gym";

type PhoneHabit = { id: string; endDate?: string; endedSpans?: unknown };
type Phone = MobileWindow & {
  openHabitEditorSheet(id: string): void;
  saveHabitEdits(id: string): void;
  materializeDailyHabits(dk: string): number;
};

let w: Phone | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function phone(habits: unknown[], tasks: unknown[] = []): Phone {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks,
      habits,
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 0,
    },
  }) as Phone;
  return w;
}

const habitRow = (extra: Record<string, unknown> = {}) => ({
  id: HABIT_ID,
  title: "Gym",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: new Date(2026, 4, 1, 9).getTime(),
  updatedAt: 1,
  ...extra,
});
const dayTask = (dateKey: string, extra: Record<string, unknown> = {}) => ({
  id: `habtsk-${dateKey}-${HABIT_ID}`, title: "Gym", notes: "", status: "queued", rank: 1000, questId: null,
  habitId: HABIT_ID, scheduledDate: dateKey, accumulatedSeconds: 0, createdAt: 1, updatedAt: 1, ...extra,
});

function byLabel(p: Phone, label: string): Element {
  const el = p.document.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element labelled ${label}`);
  return el;
}

const habitsOf = (p: Phone) => (readState(p) as unknown as { habits: PhoneHabit[] }).habits;
const main = (p: Phone) => p.document.getElementById("mainContainer") as HTMLElement;

describe("phone Habits: end date", () => {
  it("sets an end date from the Habit sheet; ending it yesterday sets today's day Task aside", () => {
    const p = phone([habitRow()], [dayTask(TODAY)]);
    p.openHabitEditorSheet(HABIT_ID);
    (byLabel(p, "End date") as HTMLInputElement).value = "2026-05-19";
    p.saveHabitEdits(HABIT_ID);

    expect(habitsOf(p)[0].endDate).toBe("2026-05-19");
    expect(readState(p).tasks.find((t) => t.id === dayTask(TODAY).id)?.status).toBe("archived");
    expect(p.materializeDailyHabits(TODAY)).toBe(0);
    p.switchView("command");
    expect(main(p).textContent).not.toContain("Gym");
    expect(pageErrors(p)).toEqual([]);
  });

  it("clears an end date from the Habit sheet", () => {
    const p = phone([habitRow({ endDate: "2026-05-31" })]);
    p.openHabitEditorSheet(HABIT_ID);
    expect((byLabel(p, "End date") as HTMLInputElement).value).toBe("2026-05-31");
    click(p, byLabel(p, "Clear end date"));
    expect((byLabel(p, "End date") as HTMLInputElement).value).toBe("");
    p.saveHabitEdits(HABIT_ID);
    expect(habitsOf(p)[0].endDate).toBeUndefined();
    expect(pageErrors(p)).toEqual([]);
  });

  it("lists an Ended Habit only in the collapsed Ended section, with its history", () => {
    const p = phone([habitRow({ endDate: "2026-05-15" })], [dayTask("2026-05-15", { status: "completed", completedAt: 1 })]);
    p.switchView("habits");
    expect(main(p).querySelector(".habits-grid")?.textContent ?? "").not.toContain("Gym");
    const toggle = byLabel(p, "Ended habits (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(main(p).querySelector("[data-ended-habit]")).toBeNull();

    click(p, toggle);
    const card = main(p).querySelector("[data-ended-habit]");
    expect(card?.textContent).toContain("Gym");
    expect(card?.textContent).toContain("Ended 15 May");
    expect(card?.textContent).toContain("1d");
    expect(byLabel(p, "Ended habits (1)").getAttribute("aria-expanded")).toBe("true");
    expect(pageErrors(p)).toEqual([]);
  });

  it("restarts an Ended Habit from its card: the gap is kept as days with no Outcome", () => {
    const p = phone([habitRow({ endDate: "2026-05-15" })]);
    p.switchView("habits");
    click(p, byLabel(p, "Ended habits (1)"));
    click(p, byLabel(p, "Restart habit Gym"));

    const [habit] = habitsOf(p);
    expect(habit.endDate).toBeUndefined();
    expect(habit.endedSpans).toEqual([{ from: "2026-05-16", to: "2026-05-19" }]);
    expect(main(p).querySelector(".habits-grid")?.textContent).toContain("Gym");
    expect(readState(p).tasks.find((t) => t.id === dayTask(TODAY).id)?.status).toBe("queued");
    expect(pageErrors(p)).toEqual([]);
  });

  it("moves an Ended Habit's end date from the Habit sheet", () => {
    const p = phone([habitRow({ endDate: "2026-05-15" })]);
    p.openHabitEditorSheet(HABIT_ID);
    (byLabel(p, "End date") as HTMLInputElement).value = "2026-05-17";
    p.saveHabitEdits(HABIT_ID);
    expect(habitsOf(p)[0].endDate).toBe("2026-05-17");
    expect(habitsOf(p)[0].endedSpans).toBeUndefined();
    expect(pageErrors(p)).toEqual([]);
  });
});
