// @vitest-environment node
// Phone Habit detail, Statistics tab (#26): the Habit Score with its one-line explanation (shared
// HuntCore.habitScore); a Count Habit adds its month chart of daily amounts and yearly totals. Also the
// Count rules in the Calendar tab: Tick / Untick / Skip go through the Count rule, and a chosen day
// takes an exact total.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 18, 10, 0).getTime();
const HABIT_ID = "hab-run";

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
    title: "Run",
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

function load(tasks: unknown[], habit: Record<string, unknown> = {}): MobileWindow {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks,
      habits: [
        {
          id: HABIT_ID,
          title: "Run",
          notes: "",
          questId: null,
          rank: 1000,
          createdAt: new Date(2026, 9, 30, 8).getTime(),
          updatedAt: 1,
          ...habit,
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
  click(w, w.document.querySelector('[aria-label="Open habit Run"]'));
  return w;
}

const sheet = (p: MobileWindow) => p.document.getElementById("sheetContainer") as HTMLElement;
const inSheet = (p: MobileWindow, label: string) => sheet(p).querySelector(`[aria-label="${label}"]`);
const tab = (p: MobileWindow, name: string) =>
  Array.from(sheet(p).querySelectorAll('[role="tab"]')).find((t) => t.textContent?.trim() === name) as HTMLElement;
const row = (p: MobileWindow, key: string) =>
  (readState(p).tasks as Record<string, unknown>[]).find((t) => t.id === `habtsk-${key}-${HABIT_ID}`);
const COUNT = { kind: "count", target: 3, unit: "miles" };

describe("phone Habit detail: Statistics tab", () => {
  it("leads with the Habit Score and a one-line explanation", () => {
    const p = load(
      ["2026-11-15", "2026-11-16", "2026-11-17"].map((k) => dayRow(k, { status: "completed", completedAt: NOW })),
      { createdAt: new Date(2026, 10, 15, 8).getTime() }
    );
    click(p, tab(p, "Statistics"));
    expect(tab(p, "Statistics").getAttribute("aria-selected")).toBe("true");
    const panel = sheet(p).querySelector("#habitPanel-statistics") as HTMLElement;
    expect(panel.textContent).toContain("Habit Score");
    expect(panel.querySelector(".habit-score-value")?.textContent).toBe("100");
    expect(panel.textContent).toContain("Recent results count most");
    expect(panel.querySelector('[aria-label^="Daily amounts"]')).toBeNull();
    click(p, tab(p, "Calendar"));
    expect(sheet(p).querySelector("#habitPanel-calendar")).not.toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });

  it("charts a Count Habit's daily amounts and yearly totals, with month and year navigation", () => {
    const p = load(
      [
        dayRow("2025-12-31", { amount: 7, status: "completed", completedAt: NOW }),
        dayRow("2026-10-31", { amount: 6, status: "completed", completedAt: NOW }),
        dayRow("2026-11-02", { amount: 4, status: "completed", completedAt: NOW }),
        dayRow("2026-11-03", { amount: 1.5 }),
      ],
      { ...COUNT, createdAt: new Date(2025, 11, 30, 8).getTime() }
    );
    click(p, tab(p, "Statistics"));
    const chart = inSheet(p, "Daily amounts, November 2026") as HTMLElement;
    expect(chart.querySelector('[aria-label="2 November: 4 miles, target reached"]')).not.toBeNull();
    expect(chart.querySelector('[aria-label="3 November: 1.5 miles, under target"]')).not.toBeNull();
    expect(chart.querySelector('[aria-label^="19 November"]')).toBeNull();
    click(p, inSheet(p, "Previous month"));
    expect(inSheet(p, "Daily amounts, October 2026")?.querySelector('[aria-label="31 October: 6 miles, target reached"]')).not.toBeNull();

    const table = inSheet(p, "Totals per month, 2026") as HTMLElement;
    const cells = (name: string) =>
      Array.from(table.querySelectorAll("tr"))
        .find((tr) => tr.querySelector("th")?.textContent === name)
        ?.querySelector("td:last-child")?.textContent;
    expect(cells("October")).toBe("6 miles");
    expect(cells("December")).toBe("—");
    expect(cells("Year")).toBe("11.5 miles");
    click(p, inSheet(p, "Previous year"));
    expect(inSheet(p, "Totals per month, 2025")).not.toBeNull();
    expect((inSheet(p, "Previous year") as HTMLButtonElement).disabled).toBe(true);
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("phone Habit detail: Calendar tab on an N per week Habit", () => {
  it("Skip sets the whole Habit Week aside, every day reads Skipped, and Undo skip on another day brings it back", () => {
    const p = load([], { frequencyHistory: [{ effectiveFrom: "2026-10-20", frequency: { type: "perWeek", times: 3 } }] });
    // Week of Mon 9 - Sun 15 November 2026.
    click(p, sheet(p).querySelector('[aria-label^="10 November: "]'));
    click(p, inSheet(p, "Skip 10 November"));
    expect(row(p, "2026-11-10")?.skipped).toBe(true);
    expect(inSheet(p, "13 November: Skipped")).not.toBeNull();
    expect(inSheet(p, "9 November: Skipped")).not.toBeNull();
    expect(sheet(p).textContent).toContain("Habit Week: Skipped");
    click(p, inSheet(p, "13 November: Skipped"));
    click(p, inSheet(p, "Undo skip 13 November"));
    expect(row(p, "2026-11-10")).not.toHaveProperty("skipped");
    expect(inSheet(p, "13 November: Skipped")).toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("phone Habit detail: Calendar tab on an Avoid Habit", () => {
  it("a past day offers Log a Slip and Undo Slip instead of Tick / Untick", () => {
    const p = load([], { kind: "avoid" });
    click(p, inSheet(p, "12 November: Met"));
    expect(inSheet(p, "Tick 12 November")).toBeNull();
    click(p, inSheet(p, "Log a Slip 12 November"));
    expect(row(p, "2026-11-12")?.slips).toBe(1);
    expect(inSheet(p, "12 November: Missed")).not.toBeNull();
    click(p, inSheet(p, "Undo Slip 12 November"));
    expect(row(p, "2026-11-12")).not.toHaveProperty("slips");
    expect(inSheet(p, "12 November: Met")).not.toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("phone Habit detail: Calendar tab on a Count Habit", () => {
  it("Tick sets the day's total to the target, Untick and Skip clear it, and a day takes an exact total", () => {
    const p = load([dayRow("2026-11-12", { amount: 1 })], COUNT);
    click(p, inSheet(p, "12 November: Missed"));
    expect(sheet(p).textContent).toContain("1 / 3 miles");
    click(p, inSheet(p, "Tick 12 November"));
    expect(row(p, "2026-11-12")).toMatchObject({ amount: 3, status: "completed" });
    click(p, inSheet(p, "Untick 12 November"));
    expect(row(p, "2026-11-12")).toMatchObject({ amount: 0, status: "queued" });
    expect(row(p, "2026-11-12")).not.toHaveProperty("completedAt");

    const field = inSheet(p, "Total for 12 November") as HTMLInputElement;
    field.value = "4.5";
    click(p, sheet(p).querySelector('[data-action="save-day-total"]'));
    expect(row(p, "2026-11-12")).toMatchObject({ amount: 4.5, status: "completed" });
    expect(inSheet(p, "12 November: Met")).not.toBeNull();

    click(p, inSheet(p, "Skip 12 November"));
    expect(row(p, "2026-11-12")).toMatchObject({ amount: 0, skipped: true });
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("phone Habit detail: Edit tab", () => {
  it("shows the Kind read-only with the target and unit, the Frequency, the end date and the reminders, and saves", () => {
    const p = load([], COUNT);
    click(p, tab(p, "Edit"));
    expect(tab(p, "Edit").getAttribute("aria-selected")).toBe("true");
    const panel = sheet(p).querySelector("#habitPanel-edit") as HTMLElement;
    expect(panel.textContent).toContain("Count Habit");
    expect((panel.querySelector('[aria-label="Daily target"]') as HTMLInputElement).value).toBe("3");
    expect((panel.querySelector('[aria-label="Unit"]') as HTMLInputElement).value).toBe("miles");
    expect(panel.querySelector('[aria-label="Habit frequency"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="End date"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="Habit reminders"]')).not.toBeNull();

    (panel.querySelector('[aria-label="Daily target"]') as HTMLInputElement).value = "5";
    click(p, panel.querySelector('[aria-label="Chosen days"]'));
    click(p, sheet(p).querySelector('#habitPanel-edit [aria-label="Monday"]'));
    click(p, Array.from(sheet(p).querySelectorAll("#habitPanel-edit button")).find((b) => b.textContent?.trim() === "Save") ?? null);
    const habit = (readState(p).habits as Record<string, unknown>[])[0];
    expect(habit.target).toBe(5);
    expect(habit.frequencyHistory).toEqual([{ effectiveFrom: "2026-11-18", frequency: { type: "weekdays", weekdays: [1] } }]);
    expect(pageErrors(p)).toEqual([]);
  });
});
