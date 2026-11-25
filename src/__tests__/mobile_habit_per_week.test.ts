// @vitest-environment node
// Phone N times per week: the Habit sheets offer it, Today and the Day Widget rows keep the Habit
// until N are Met that Habit Week, Skip sets the whole week aside, and the Streak reads "3w" —
// through the same shared rules as the desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

// Wednesday 13 May 2026, 10:00 local; the Habit Week began Monday 11 May.
const NOW = new Date(2026, 4, 13, 10).getTime();
const TODAY = "2026-05-13";
const HABIT_ID = "hab-gym";

type PhoneHabit = { id: string; frequencyHistory?: unknown };
type PhoneTask = { id: string; status: string; skipped?: boolean };
type Phone = MobileWindow & {
  openNewHabitSheet(): void;
  saveNewHabit(): void;
  openHabitEditorSheet(id: string): void;
  materializeDailyHabits(dk: string): number;
  setHabitTodaySkipped(id: string, skipped: boolean): void;
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

const TWICE = [{ effectiveFrom: "2026-04-20", frequency: { type: "perWeek", times: 2 } }];
const habitRow = (extra: Record<string, unknown> = {}) => ({
  id: HABIT_ID,
  title: "Gym",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1,
  updatedAt: 1,
  frequencyHistory: TWICE,
  ...extra,
});
const dayTask = (day: string, extra: Record<string, unknown> = {}) => ({
  id: `habtsk-${day}-${HABIT_ID}`,
  title: "Gym",
  notes: "",
  status: "queued",
  rank: 1000,
  questId: null,
  habitId: HABIT_ID,
  scheduledDate: day,
  accumulatedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const ticked = (day: string) => dayTask(day, { status: "completed", completedAt: 2 });

function byLabel(p: Phone, label: string): Element {
  const el = p.document.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element labelled ${label}`);
  return el;
}
const tasksOf = (p: Phone) => readState(p).tasks as unknown as PhoneTask[];
const card = (p: Phone) => p.document.querySelector("#mainContainer .habits-grid .queue-item-card");

describe("phone Habits: N times per week", () => {
  it("creates a Habit asked 3 times a week from the new Habit sheet", () => {
    const p = phone([]);
    p.openNewHabitSheet();
    (p.document.getElementById("newHabitTitleInput") as HTMLInputElement).value = "Swim";
    click(p, byLabel(p, "Times a week"));
    click(p, byLabel(p, "4 times a week"));
    expect(byLabel(p, "4 times a week").getAttribute("aria-pressed")).toBe("true");
    p.saveNewHabit();
    const [habit] = (readState(p) as unknown as { habits: PhoneHabit[] }).habits;
    expect(habit.frequencyHistory).toEqual([{ effectiveFrom: TODAY, frequency: { type: "perWeek", times: 4 } }]);
    expect(tasksOf(p)).toHaveLength(1); // asked today
    expect(pageErrors(p)).toEqual([]);
  });

  it("makes a day Task each day until N are Met that week, then leaves the Habit out of Today", () => {
    // The page materializes today when it starts.
    const p = phone([habitRow()], [ticked("2026-05-11")]);
    expect(tasksOf(p).map((t) => t.id)).toContain(`habtsk-${TODAY}-${HABIT_ID}`);
    p.close();
    const met = phone([habitRow()], [ticked("2026-05-11"), ticked("2026-05-12")]);
    expect(met.materializeDailyHabits(TODAY)).toBe(0);
    met.switchView("command");
    expect(met.document.getElementById("mainContainer")?.textContent).not.toContain("Gym");
    met.switchView("habits");
    expect(card(met)?.textContent).toContain("2 / 2 this week");
    expect((byLabel(met, "Not asked again this week: Gym") as HTMLButtonElement).disabled).toBe(true);
    expect(pageErrors(met)).toEqual([]);
  });

  it("reads an N per week Streak in weeks", () => {
    const p = phone([habitRow()], ["2026-04-27", "2026-04-29", "2026-05-04", "2026-05-06", "2026-05-11"].map(ticked));
    p.switchView("habits");
    expect(card(p)?.textContent).toContain("2w");
    expect(card(p)?.textContent).toContain("1 / 2 this week");
    expect(card(p)?.textContent).toContain("2 times a week");
  });

  it("skips the whole Habit Week from the Habit sheet and undoes it from the card", () => {
    const p = phone([habitRow()], [dayTask("2026-05-11")]);
    p.openHabitEditorSheet(HABIT_ID);
    click(p, byLabel(p, "Skip this week: Gym"));
    expect(tasksOf(p).find((t) => t.id === `habtsk-${TODAY}-${HABIT_ID}`)?.skipped).toBe(true);
    p.switchView("habits");
    expect(card(p)?.textContent).toContain("Skipped this week");
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("0 / 0 done today");
    click(p, byLabel(p, "Undo skip: Gym"));
    expect(tasksOf(p).some((t) => t.skipped)).toBe(false);
    expect(pageErrors(p)).toEqual([]);
  });

  it("undoes a Skip written on an earlier day of the week", () => {
    const p = phone([habitRow()], [dayTask("2026-05-11", { skipped: true })]);
    expect(p.materializeDailyHabits(TODAY)).toBe(0);
    p.switchView("habits");
    click(p, byLabel(p, "Undo skip: Gym"));
    expect(tasksOf(p).find((t) => t.id === `habtsk-2026-05-11-${HABIT_ID}`)?.skipped).toBeUndefined();
    expect(pageErrors(p)).toEqual([]);
  });
});
