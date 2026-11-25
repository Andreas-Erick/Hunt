// N times per week Habits (GLOSSARY: Habit Week, Partial Week). Shared-core rules, so these
// cover the desktop and the phone page alike.
import { describe, expect, it } from "vitest";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, HabitFrequency, Task } from "@/lib/domainTypes";
import { habitTodayTally, summarizeHabitDays } from "@/lib/habitDay";
import { habitSkipRows } from "@/lib/habitSkip";
import { createEmptySyncPayload, mergeSyncPayloads, syncContentKey } from "@/lib/syncTypes";
import { missingHabitRows } from "@/lib/taskQueue";
import { buildWidgetSnapshot } from "@/lib/widgetSnapshot";

// 2026-05-11 is a Monday; today is the Wednesday of that Habit Week.
const TODAY = "2026-05-13";
const THREE_A_WEEK: HabitFrequency = { type: "perWeek", times: 3 };

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "h",
    title: "Gym",
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: 1,
    frequencyHistory: [{ effectiveFrom: "2026-04-27", frequency: THREE_A_WEEK }],
    ...overrides,
  };
}

function dayTask(dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h", dateKey),
    title: "Gym",
    notes: "",
    questId: null,
    habitId: "h",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ticked = (dateKey: string) => dayTask(dateKey, { status: "completed" });
const summary = (tasks: Task[], h: Habit = habit(), today = TODAY) =>
  summarizeHabitDays(tasks, today, [h]).summaryFor("h");

describe("Habit Week Outcome (N times per week)", () => {
  it("is Met once N days of the Monday-to-Sunday week are ticked, Missed below N", () => {
    const s = summary([
      // Week of 04-27: three ticks -> Met
      ticked("2026-04-27"),
      ticked("2026-04-29"),
      ticked("2026-05-03"),
      // Week of 05-04: two ticks -> Missed
      ticked("2026-05-04"),
      ticked("2026-05-10"),
    ]);
    expect(s.weekOutcomeOn("2026-04-30")).toBe("met");
    expect(s.weekOutcomeOn("2026-05-04")).toBe("missed");
    expect(s.weekOutcomeOn("2026-05-10")).toBe("missed");
  });

  it("keeps the current week Open below N, and never judges a single day Missed", () => {
    const s = summary([ticked("2026-05-11"), dayTask("2026-05-12")]);
    expect(s.weekOutcomeOn(TODAY)).toBe("open");
    expect(s.outcomeOn("2026-05-11")).toBe("met");
    expect(s.outcomeOn("2026-05-12")).toBeNull();
    expect(s.outcomeOn("2026-05-05")).toBeNull();
    expect(s.outcomeOn(TODAY)).toBe("open");
    expect(s.week).toMatchObject({ start: "2026-05-11", target: 3, met: 1 });
  });

  it("counts a Count Habit's day toward N only once its total reaches the target", () => {
    const run = habit({ kind: "count", target: 3, unit: "miles" });
    const s = summary(
      [
        dayTask("2026-05-04", { amount: 3 }),
        dayTask("2026-05-05", { amount: 2.5 }),
        dayTask("2026-05-06", { amount: 5 }),
        dayTask("2026-05-07", { amount: 3 }),
      ],
      run
    );
    expect(s.weekOutcomeOn("2026-05-04")).toBe("met");
    const short = summary([dayTask("2026-05-04", { amount: 3 }), dayTask("2026-05-05", { amount: 2 })], run);
    expect(short.weekOutcomeOn("2026-05-04")).toBe("missed");
  });

  it("has no week Outcome for a week the Habit was not asked N times per week, or a future week", () => {
    const s = summary([]);
    expect(s.weekOutcomeOn("2026-04-20")).toBeNull();
    expect(s.weekOutcomeOn("2026-05-18")).toBeNull();
    const daily = summary([], habit({ frequencyHistory: undefined }));
    expect(daily.weekOutcomeOn(TODAY)).toBeNull();
    expect(daily.week).toBeNull();
  });
});

describe("Partial Weeks and whole-week Skip", () => {
  it("ends a week the Habit began partway through Skipped, even with N ticks", () => {
    // Created on Wednesday 2026-05-06 (local noon), N per week from then on.
    const created = new Date(2026, 4, 6, 12).getTime();
    const h = habit({ createdAt: created, frequencyHistory: [{ effectiveFrom: "2026-05-06", frequency: THREE_A_WEEK }] });
    const s = summary([ticked("2026-05-06"), ticked("2026-05-07"), ticked("2026-05-08")], h);
    expect(s.weekOutcomeOn("2026-05-08")).toBe("skipped");
    expect(s.weekOutcomeOn(TODAY)).toBe("open");
  });

  it("ends a week whose Frequency changed partway through Skipped, and judges the old days daily", () => {
    // Every day until Thursday 05-07, then 3 times a week: the week of 05-04 is Partial.
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-05-07", frequency: THREE_A_WEEK }] });
    const s = summary([ticked("2026-05-04")], h);
    expect(s.weekOutcomeOn("2026-05-04")).toBe("skipped");
    expect(s.outcomeOn("2026-05-04")).toBe("met");
    expect(s.outcomeOn("2026-05-05")).toBe("missed");
    expect(s.outcomeOn("2026-05-08")).toBeNull();
    // A change of N partway through a week is Partial too.
    const changed = habit({
      frequencyHistory: [
        { effectiveFrom: "2026-04-27", frequency: THREE_A_WEEK },
        { effectiveFrom: "2026-05-06", frequency: { type: "perWeek", times: 2 } },
      ],
    });
    const c = summary([ticked("2026-05-04"), ticked("2026-05-06"), ticked("2026-05-07")], changed);
    expect(c.weekOutcomeOn("2026-05-04")).toBe("skipped");
    expect(c.week).toMatchObject({ target: 2 });
  });

  it("ends a week Skipped when one of its day Tasks is set aside, unless N are Met", () => {
    const s = summary([ticked("2026-05-04"), dayTask("2026-05-06", { skipped: true })]);
    expect(s.weekOutcomeOn("2026-05-05")).toBe("skipped");
    expect(s.skipState).toBe("open");
    const now = summary([dayTask("2026-05-12", { skipped: true })]);
    expect(now.weekOutcomeOn(TODAY)).toBe("skipped");
    expect(now.skipState).toBe("skipped");
    const met = summary([
      ticked("2026-05-04"),
      ticked("2026-05-05"),
      ticked("2026-05-06"),
      dayTask("2026-05-07", { skipped: true }),
    ]);
    expect(met.weekOutcomeOn("2026-05-04")).toBe("met");
  });
});

/** Three ticks from the Monday `monday` (a May or April date with room for three days). */
const metWeek = (monday: string) =>
  [0, 1, 2].map((i) => ticked(`${monday.slice(0, 8)}${String(Number(monday.slice(8)) + i).padStart(2, "0")}`));

describe("weekly Streak", () => {
  it("counts Met Habit Weeks, passing over the Open current week and Skipped weeks", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-04-13", frequency: THREE_A_WEEK }] });
    const tasks = [
      ...metWeek("2026-04-13"),
      dayTask("2026-04-22", { skipped: true }),
      ...metWeek("2026-04-27"),
      ...metWeek("2026-05-04"),
    ];
    const s = summary(tasks, h);
    expect(s.streakUnit).toBe("week");
    expect(s.streak).toBe(3);
  });

  it("is broken by a Missed week, and counts the current week once Met", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-04-20", frequency: THREE_A_WEEK }] });
    const tasks = [...metWeek("2026-04-20"), ticked("2026-04-27"), ...metWeek("2026-05-04"), ...metWeek("2026-05-11")];
    expect(summary(tasks, h).streak).toBe(2);
  });

  it("does not count days from before a switch between daily and N per week", () => {
    const h = habit({ frequencyHistory: [{ effectiveFrom: "2026-05-04", frequency: THREE_A_WEEK }] });
    const daily = Array.from({ length: 10 }, (_, i) => ticked(`2026-04-${String(20 + i).padStart(2, "0")}`));
    expect(summary([...daily, ...metWeek("2026-05-04")], h).streak).toBe(1);
    const back = habit({
      frequencyHistory: [
        { effectiveFrom: "2026-04-20", frequency: THREE_A_WEEK },
        { effectiveFrom: "2026-05-11", frequency: { type: "everyDay" } },
      ],
    });
    const b = summary([...metWeek("2026-05-04"), ticked("2026-05-11"), ticked("2026-05-12")], back);
    expect(b.streakUnit).toBe("day");
    expect(b.streak).toBe(2);
  });
});

describe("Skipping a Habit Week (habitSkipRows)", () => {
  const AT = 5_000;

  it("sets a whole N per week Habit Week aside by marking today's day Task, building it when missing", () => {
    const rows = habitSkipRows(habit(), TODAY, [ticked("2026-05-11")], true, AT);
    expect(rows).toEqual([expect.objectContaining({ id: habitTaskId("h", TODAY), skipped: true, updatedAt: AT })]);
    const after = summary([ticked("2026-05-11"), ...rows]);
    expect(after.weekOutcomeOn(TODAY)).toBe("skipped");
    expect(after.skipState).toBe("skipped");
  });

  it("writes nothing when the week is already set aside", () => {
    expect(habitSkipRows(habit(), TODAY, [dayTask("2026-05-11", { skipped: true })], true, AT)).toEqual([]);
  });

  it("undoes the Skip on every day Task of the week, wherever it was written", () => {
    const tasks = [dayTask("2026-05-11", { skipped: true }), dayTask("2026-05-12", { skipped: true }), dayTask("2026-05-04", { skipped: true })];
    const rows = habitSkipRows(habit(), TODAY, tasks, false, AT);
    expect(rows.map((t) => t.id).sort()).toEqual([habitTaskId("h", "2026-05-11"), habitTaskId("h", "2026-05-12")]);
    expect(rows.every((t) => t.skipped === undefined && t.updatedAt === AT)).toBe(true);
    expect(summary([dayTask("2026-05-04", { skipped: true }), ...rows]).weekOutcomeOn(TODAY)).toBe("open");
  });

  it("merges a weekly Skip under row-level last-write-wins to the same week on either device", () => {
    const sync = (tasks: Task[]) => ({ ...createEmptySyncPayload(), habits: [habit()], tasks });
    const weekOf = (p: { tasks?: Task[] }) => summary(p.tasks ?? []).weekOutcomeOn(TODAY);
    const monday = ticked("2026-05-11");
    // A sets the week aside on Wednesday; B, offline, ticks Tuesday: different rows, both kept.
    const a = sync([monday, ...habitSkipRows(habit(), TODAY, [monday], true, 3_000)]);
    const b = sync([monday, ticked("2026-05-12")]);
    const ab = mergeSyncPayloads(a, b);
    expect(syncContentKey(ab)).toBe(syncContentKey(mergeSyncPayloads(b, a)));
    expect(weekOf(ab)).toBe("skipped");
    // B ticks Wednesday later than A's Skip: the same row, so the newer tick wins and the week is Open.
    const late = sync([monday, dayTask(TODAY, { status: "completed", updatedAt: 4_000 })]);
    expect(weekOf(mergeSyncPayloads(a, late))).toBe("open");
    expect(weekOf(mergeSyncPayloads(late, a))).toBe("open");
    // A's Undo (newer) clears the flag it wrote, whichever copy arrives first.
    const undone = sync([monday, ...habitSkipRows(habit(), TODAY, a.tasks, false, 5_000)]);
    expect(weekOf(mergeSyncPayloads(a, undone))).toBe("open");
    expect(weekOf(mergeSyncPayloads(undone, a))).toBe("open");
  });

  it("skips a single day of a daily Habit, as before", () => {
    const daily = habit({ frequencyHistory: undefined });
    expect(habitSkipRows(daily, TODAY, [], true, AT)).toEqual([
      expect.objectContaining({ id: habitTaskId("h", TODAY), skipped: true }),
    ]);
    expect(habitSkipRows(daily, TODAY, [dayTask("2026-05-12", { skipped: true })], false, AT)).toEqual([]);
  });
});

describe("Today for an N per week Habit", () => {
  const TWICE = habit({ frequencyHistory: [{ effectiveFrom: "2026-04-27", frequency: { type: "perWeek", times: 2 } }] });

  it("is asked each day until N are Met that Habit Week, then not for the rest of it", () => {
    expect(summary([ticked("2026-05-11")]).askedToday).toBe(true);
    const metEarlier = summary([ticked("2026-05-11"), ticked("2026-05-12")], TWICE);
    expect(metEarlier.askedToday).toBe(false);
    expect(metEarlier.skipState).toBe("met");
    // Today's own tick reaching N keeps today asked (so it can be reopened).
    const metToday = summary([ticked("2026-05-11"), ticked(TODAY)], TWICE);
    expect(metToday.askedToday).toBe(true);
    expect(metToday.doneToday).toBe(true);
  });

  it("builds today's day Task only while the Habit Week still asks for it", () => {
    const rows = (tasks: Task[]) => missingHabitRows({ habits: [TWICE], tasks }, TODAY).map((t) => t.id);
    expect(rows([ticked("2026-05-11")])).toEqual([habitTaskId("h", TODAY)]);
    expect(rows([ticked("2026-05-11"), ticked("2026-05-12")])).toEqual([]);
    expect(rows([dayTask("2026-05-11", { skipped: true })])).toEqual([]);
  });

  it("lists the Habit on the Day Widget until N are Met that Habit Week, then again next week", () => {
    const widgetDays = (tasks: Task[]) =>
      buildWidgetSnapshot({ ...createEmptySyncPayload(), habits: [TWICE], tasks }, TODAY, "neon").days;
    const rowIds = (tasks: Task[], i: number) => widgetDays(tasks)[i].today.map((r) => r.id);
    expect(rowIds([ticked("2026-05-11")], 0)).toEqual([habitTaskId("h", TODAY)]);
    const met = [ticked("2026-05-11"), ticked("2026-05-12")];
    expect(rowIds(met, 0)).toEqual([]);
    expect(rowIds(met, 4)).toEqual([]); // Sunday 05-17, same Habit Week
    expect(rowIds(met, 5)).toEqual([habitTaskId("h", "2026-05-18")]); // the next Habit Week
    expect(rowIds([dayTask("2026-05-12", { skipped: true })], 0)).toEqual([]);
  });

  it("counts toward the done-today tally only while asked", () => {
    const tally = (tasks: Task[]) => habitTodayTally([TWICE], summarizeHabitDays(tasks, TODAY, [TWICE]).summaryFor, TODAY);
    expect(tally([])).toEqual({ done: 0, asked: 1 });
    expect(tally([ticked("2026-05-11"), ticked("2026-05-12")])).toEqual({ done: 0, asked: 0 });
    expect(tally([ticked("2026-05-11"), ticked(TODAY)])).toEqual({ done: 1, asked: 1 });
    expect(tally([dayTask("2026-05-12", { skipped: true })])).toEqual({ done: 0, asked: 0 });
  });
});
