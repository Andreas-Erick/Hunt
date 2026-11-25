// @vitest-environment node
// Phone page: a Habit's reminder times (#31) are added and removed in the Habit's sheet, saved on
// the Habit row (so they sync), handed to the shell in the Reminder Plan only for Open scheduled
// days, and a notification tap opens the Habit.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, readState, type AndroidBridgeStub, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 25, 8, 0).getTime();
const TODAY = "2026-11-25";

let w: MobileWindow | null = null;

type Page = MobileWindow & {
  openHabitEditorSheet(id: string): void;
  __huntOpenReminder(target: unknown): void;
  switchView(view: string): void;
};

function habit(extra: Record<string, unknown> = {}) {
  return { id: "hab-1", title: "Read", notes: "", questId: null, rank: 1000, createdAt: 1, updatedAt: 1, ...extra };
}

function state(habits: Record<string, unknown>[], tasks: Record<string, unknown>[] = []) {
  return {
    quests: [],
    tasks,
    timeLogs: [],
    habits,
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    deletedHabitIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
  };
}

type Plan = { version: number; reminders: { key: string; kind: string; itemId: string }[] };

function shell() {
  const plans: Plan[] = [];
  const bridge: AndroidBridgeStub & Record<string, unknown> = {
    saveState: () => undefined,
    saveReminderPlan: (json: string) => plans.push(JSON.parse(json)),
    getReminderPermissions: () => JSON.stringify({ notifications: true, exactAlarms: true }),
    requestReminderPermissions: () => undefined,
  };
  return { bridge, plans };
}

function sheetButton(p: MobileWindow, label: string): Element | null {
  return (
    Array.from(p.document.querySelectorAll("#sheetContainer button")).find(
      (b) => b.getAttribute("aria-label") === label
    ) ?? null
  );
}

function addTime(p: MobileWindow, value: string) {
  const input = p.document.querySelector<HTMLInputElement>('#sheetContainer input[aria-label="New reminder time"]');
  expect(input).not.toBeNull();
  input!.value = value;
  click(p, sheetButton(p, "Add reminder"));
}

const savedHabit = (p: MobileWindow) => (readState(p).habits as Record<string, unknown>[]).find((h) => h.id === "hab-1");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

describe("phone Habit reminders", () => {
  it("adds reminder times in the Habit sheet, in time order, stamped so they sync", () => {
    const p = (w = loadMobile({ seedState: state([habit()]) })) as Page;
    p.openHabitEditorSheet("hab-1");
    addTime(p, "20:00");
    addTime(p, "07:30");
    expect(savedHabit(p)?.reminderTimes).toEqual(["07:30", "20:00"]);
    expect(Number(savedHabit(p)?.updatedAt)).toBeGreaterThan(1);
    expect(sheetButton(p, "Remove reminder at 07:30")).not.toBeNull();
  });

  it("removes a time, and the field when the last one goes", () => {
    const p = (w = loadMobile({ seedState: state([habit({ reminderTimes: ["07:30", "20:00"] })]) })) as Page;
    p.openHabitEditorSheet("hab-1");
    click(p, sheetButton(p, "Remove reminder at 07:30"));
    expect(savedHabit(p)?.reminderTimes).toEqual(["20:00"]);
    click(p, sheetButton(p, "Remove reminder at 20:00"));
    expect(savedHabit(p)).not.toHaveProperty("reminderTimes");
  });

  it("keeps the reminder times when the sheet is then saved", () => {
    const p = (w = loadMobile({ seedState: state([habit()]) })) as Page;
    p.openHabitEditorSheet("hab-1");
    addTime(p, "20:00");
    click(p, Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent === "Save") ?? null);
    expect(savedHabit(p)?.reminderTimes).toEqual(["20:00"]);
  });

  it("drops malformed reminder times arriving in stored or synced state", () => {
    const p = (w = loadMobile({ seedState: state([habit({ reminderTimes: ["8pm", "20:00"] })]) })) as Page;
    expect(savedHabit(p)?.reminderTimes).toEqual(["20:00"]);
  });

  it("plans a Habit reminder for an Open day only: a Met day is left out", () => {
    const s = shell();
    const p = (w = loadMobile({ seedState: state([habit()]), bridge: s.bridge })) as Page;
    p.openHabitEditorSheet("hab-1");
    addTime(p, "20:00");
    vi.advanceTimersByTime(100);
    const keys = () => s.plans[s.plans.length - 1].reminders.map((r) => r.key);
    expect(keys()[0]).toBe(`habit:hab-1:${TODAY}T20:00`);
    expect(s.plans[s.plans.length - 1].reminders[0].kind).toBe("habit");

    const done = { id: `habit:hab-1:${TODAY}`, title: "Read", status: "completed", rank: 0, questId: null, accumulatedSeconds: 0, scheduledDate: TODAY, habitId: "hab-1", completedAt: NOW, updatedAt: NOW };
    p.close();
    const s2 = shell();
    w = loadMobile({ seedState: state([habit({ reminderTimes: ["20:00"] })], [done]), bridge: s2.bridge });
    vi.advanceTimersByTime(100);
    const plan = s2.plans[s2.plans.length - 1];
    expect(plan.reminders.map((r) => r.key)).not.toContain(`habit:hab-1:${TODAY}T20:00`);
    expect(plan.reminders.map((r) => r.key)).toContain("habit:hab-1:2026-11-26T20:00");
  });

  it("opens the Habit when its notification is tapped; a gone Habit just leaves Hunt open", () => {
    const p = (w = loadMobile({ seedState: state([habit({ reminderTimes: ["20:00"] })]) })) as Page;
    p.__huntOpenReminder({ kind: "habit", itemId: "hab-1", dateKey: TODAY });
    expect(p.document.getElementById("editHabitTitleInput")).not.toBeNull();
    expect(p.document.getElementById("nav-habits")?.classList.contains("active")).toBe(true);
    expect(() => p.__huntOpenReminder({ kind: "habit", itemId: "gone", dateKey: TODAY })).not.toThrow();
  });
});
