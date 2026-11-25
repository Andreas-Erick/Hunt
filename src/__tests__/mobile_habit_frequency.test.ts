// @vitest-environment node
// Phone Frequency: the Habit sheets offer every day / chosen weekdays, day Tasks are only made for
// scheduled days, and a change applies from today, through the same shared rules as the desktop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

// Monday 11 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 11, 10).getTime();
const MONDAY = "2026-05-11";
const HABIT_ID = "hab-gym";

type PhoneHabit = { id: string; frequencyHistory?: unknown };
type Phone = MobileWindow & {
  openNewHabitSheet(): void;
  saveNewHabit(): void;
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
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const TUE_THU = [{ effectiveFrom: "2026-05-01", frequency: { type: "weekdays", weekdays: [2, 4] } }];

function byLabel(p: Phone, label: string): Element {
  const el = p.document.querySelector(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element labelled ${label}`);
  return el;
}

function habitsOf(p: Phone): PhoneHabit[] {
  return (readState(p) as unknown as { habits: PhoneHabit[] }).habits;
}

describe("phone Habits: Frequency", () => {
  it("makes no day Task on a day the Habit is not asked for, and says so on its card", () => {
    const p = phone([habitRow({ frequencyHistory: TUE_THU })]);
    expect(p.materializeDailyHabits(MONDAY)).toBe(0);
    expect(readState(p).tasks).toHaveLength(0);

    p.switchView("habits");
    const card = p.document.querySelector("#mainContainer .habits-grid .queue-item-card");
    expect(card?.textContent).toContain("Tue, Thu");
    const ring = byLabel(p, "Not scheduled today: Gym") as HTMLButtonElement;
    expect(ring.disabled).toBe(true);
    expect(p.document.querySelector('[aria-label="Start focus on Gym"]')).toBeNull();
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("0 / 0 done today");
    expect(pageErrors(p)).toEqual([]);
  });

  it("creates a Habit for chosen weekdays from the new Habit sheet", () => {
    const p = phone([]);
    p.openNewHabitSheet();
    (p.document.getElementById("newHabitTitleInput") as HTMLInputElement).value = "Swim";
    click(p, byLabel(p, "Chosen days"));
    p.saveNewHabit(); // no weekday chosen yet: not saved
    expect(habitsOf(p)).toHaveLength(0);
    click(p, byLabel(p, "Tuesday"));
    expect(byLabel(p, "Tuesday").getAttribute("aria-pressed")).toBe("true");
    p.saveNewHabit();

    const [habit] = habitsOf(p);
    expect(habit.frequencyHistory).toEqual([
      { effectiveFrom: MONDAY, frequency: { type: "weekdays", weekdays: [2] } },
    ]);
    expect(readState(p).tasks).toHaveLength(0); // Monday is not asked for
    expect(pageErrors(p)).toEqual([]);
  });

  it("applies a Frequency change from today: today's untouched day Task leaves Today, earlier days stay", () => {
    const today = { id: `habtsk-${MONDAY}-${HABIT_ID}`, title: "Gym", notes: "", status: "queued", rank: 1000,
      questId: null, habitId: HABIT_ID, scheduledDate: MONDAY, accumulatedSeconds: 0, createdAt: 1, updatedAt: 1 };
    const p = phone([habitRow()], [today]);
    p.openHabitEditorSheet(HABIT_ID);
    expect(byLabel(p, "Every day").getAttribute("aria-pressed")).toBe("true");
    click(p, byLabel(p, "Chosen days"));
    click(p, byLabel(p, "Tuesday"));
    p.saveHabitEdits(HABIT_ID);

    expect(habitsOf(p)[0].frequencyHistory).toEqual([
      { effectiveFrom: MONDAY, frequency: { type: "weekdays", weekdays: [2] } },
    ]);
    expect(readState(p).tasks.find((t) => t.id === today.id)?.status).toBe("archived");
    p.switchView("command");
    expect(p.document.getElementById("mainContainer")?.textContent).not.toContain("Gym");
    expect(pageErrors(p)).toEqual([]);
  });
});
