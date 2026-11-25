// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Habit, Quest, Task } from "@/lib/domainTypes";
import type { SyncPayload } from "@/lib/syncTypes";
import { buildWidgetSnapshot, WIDGET_SNAPSHOT_VERSION } from "@/mobile/huntCore";

const TODAY = "2026-11-22";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const quest: Quest = {
  id: "q1",
  slotIndex: 0,
  code: "WRT",
  title: "Write",
  description: "",
  accentColor: "amber",
  targetWeeklyHours: 8,
  archived: false,
  createdAt: 1,
};

const habit: Habit = { id: "h1", title: "Meditate", notes: "", questId: null, rank: 500, createdAt: 5 };

function state(over: Partial<SyncPayload> = {}): SyncPayload {
  return {
    quests: [],
    tasks: [],
    timeLogs: [],
    habits: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    deletedHabitIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...over,
  };
}

const todayIds = (s: SyncPayload) =>
  buildWidgetSnapshot(s, TODAY, "neon").days[0].today.map((r) => r.id);

describe("buildWidgetSnapshot (Day Widget, today view)", () => {
  it("is versioned, carries the look and starts its day list on today", () => {
    const snap = buildWidgetSnapshot(state({ tasks: [task("a")] }), TODAY, "dawn");
    expect(snap.version).toBe(WIDGET_SNAPSHOT_VERSION);
    expect(snap.look).toBe("dawn");
    expect(snap.todayKey).toBe(TODAY);
    expect(snap.days[0].dateKey).toBe(TODAY);
  });

  it("rolls overdue and unscheduled Tasks into today, leaves future ones out, in app order", () => {
    const s = state({
      tasks: [
        task("future", { scheduledDate: "2026-11-23", rank: 1 }),
        task("overdue", { scheduledDate: "2026-11-01", rank: 3000 }),
        task("loose", { rank: 2000 }),
        task("today", { scheduledDate: TODAY, rank: 2000 }),
      ],
    });
    expect(todayIds(s)).toEqual(["loose", "today", "overdue"]);
  });

  it("fills in today's Habits by their fixed ids before Hunt has created them", () => {
    const s = state({ habits: [habit], tasks: [task("a", { rank: 2000 })] });
    const rows = buildWidgetSnapshot(s, TODAY, "neon").days[0].today;
    expect(rows.map((r) => r.id)).toEqual(["habtsk-2026-11-22-h1", "a"]);
    expect(rows[0]).toMatchObject({ title: "Meditate", habit: true, tickable: true });
  });

  it("is version 2: a Count Habit row taps +1, which a version-1 widget would read as done", () => {
    expect(WIDGET_SNAPSHOT_VERSION).toBe(2);
  });

  it("gives each Habit row its Kind, and a Count Habit row its progress, n / target", () => {
    const jog: Habit = { ...habit, id: "jog", title: "Jog", rank: 600, kind: "count", target: 3, unit: "miles" };
    const partway = task("habtsk-2026-11-22-jog", { habitId: "jog", scheduledDate: TODAY, amount: 2, rank: 600 });
    const rows = buildWidgetSnapshot(state({ habits: [habit, jog], tasks: [partway, task("a", { rank: 2000 })] }), TODAY, "neon")
      .days[0].today;
    expect(rows.map((r) => [r.id, r.habitKind])).toEqual([
      ["habtsk-2026-11-22-h1", "check"],
      ["habtsk-2026-11-22-jog", "count"],
      ["a", undefined],
    ]);
    expect(rows[1]).toMatchObject({ tickable: true, progress: "2 / 3 miles" });
    expect(rows[0].progress).toBeUndefined();
  });

  it("shows a Count Habit Hunt has not created a row for yet at 0 / target", () => {
    const glasses: Habit = { ...habit, id: "w", title: "Water", kind: "count", target: 7 };
    const [row] = buildWidgetSnapshot(state({ habits: [glasses] }), TODAY, "neon").days[0].today;
    expect(row).toMatchObject({ habitKind: "count", progress: "0 / 7" });
  });

  it("does not duplicate a Habit row that exists, nor revive a deleted one", () => {
    const made = task("habtsk-2026-11-22-h1", { habitId: "h1", scheduledDate: TODAY, status: "completed" });
    expect(todayIds(state({ habits: [habit], tasks: [made] }))).toEqual([]);
    expect(todayIds(state({ habits: [habit], deletedTaskIds: ["habtsk-2026-11-22-h1"] }))).toEqual([]);
  });

  it("leaves done and archived Tasks out, and yesterday's missed Habit", () => {
    const s = state({
      tasks: [
        task("done", { status: "completed" }),
        task("archived", { status: "archived" }),
        task("missed", { habitId: "hX", scheduledDate: "2026-11-21" }),
        task("open"),
      ],
    });
    expect(todayIds(s)).toEqual(["open"]);
  });

  it("marks the Focus Task with focus and makes it not tickable", () => {
    const s = state({
      tasks: [task("f", { status: "active" }), task("b", { rank: 2000 })],
      activeFocus: { activeTaskId: "f", isRunning: true, sessionStartedAt: 10, updatedAt: 10 },
    });
    const rows = buildWidgetSnapshot(s, TODAY, "neon").days[0].today;
    expect(rows[0]).toMatchObject({ id: "f", focus: true, tickable: false });
    expect(rows[1]).toMatchObject({ id: "b", focus: false, tickable: true });
  });

  it("gives each row its Quest accent, slate for Other work", () => {
    const s = state({ quests: [quest], tasks: [task("a", { questId: "q1" }), task("b", { rank: 2000 })] });
    const rows = buildWidgetSnapshot(s, TODAY, "neon").days[0].today;
    expect(rows.map((r) => r.accent)).toEqual(["amber", "slate"]);
  });

  it("flags no data for a fresh install, and an empty day without the flag", () => {
    const fresh = buildWidgetSnapshot(state(), TODAY, "neon");
    expect(fresh.noData).toBe(true);
    const allDone = buildWidgetSnapshot(state({ tasks: [task("d", { status: "completed" })] }), TODAY, "neon");
    expect(allDone.noData).toBe(false);
    expect(allDone.days[0].today).toEqual([]);
  });
});

describe("buildWidgetSnapshot (Day Widget, ‹ › days)", () => {
  it("covers today to today + 7, across a month end", () => {
    const keys = buildWidgetSnapshot(state(), "2026-11-27", "neon").days.map((d) => d.dateKey);
    expect(keys).toEqual([
      "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30",
      "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04",
    ]);
  });

  const s = state({
    habits: [habit],
    tasks: [
      task("loose", { rank: 4000 }),
      task("overdue", { scheduledDate: "2026-11-01", rank: 3000 }),
      task("today", { scheduledDate: TODAY, rank: 2000 }),
      task("tomorrow-b", { scheduledDate: "2026-11-23", rank: 2000 }),
      task("tomorrow-a", { scheduledDate: "2026-11-23", rank: 1000 }),
      task("tomorrow-done", { scheduledDate: "2026-11-23", status: "completed" }),
      task("in-6", { scheduledDate: "2026-11-28" }),
      // A Habit row that already exists for tomorrow (e.g. synced from the desktop).
      task("habtsk-2026-11-23-h1", { habitId: "h1", scheduledDate: "2026-11-23", rank: 500 }),
    ],
  });
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const days = buildWidgetSnapshot(s, TODAY, "neon").days;

  it("a future view lists only the open Tasks scheduled on that date, in rank order", () => {
    expect(ids(days[1].future)).toEqual(["tomorrow-a", "tomorrow-b"]);
    expect(ids(days[6].future)).toEqual(["in-6"]);
    expect(days[3].future).toEqual([]);
  });

  it("a future view never has Habits, while that day's today view does", () => {
    for (const d of days) expect(d.future.some((r) => r.habit), d.dateKey).toBe(false);
    expect(days[1].today.find((r) => r.habit)).toMatchObject({ id: "habtsk-2026-11-23-h1" });
  });

  it("tomorrow's today view is what the app shows tomorrow, for the midnight rollover", () => {
    const rolledOver = buildWidgetSnapshot(s, "2026-11-23", "neon").days[0].today;
    expect(days[1].today).toEqual(rolledOver);
    expect(ids(days[1].today)).toEqual([
      "habtsk-2026-11-23-h1", "tomorrow-a", "today", "tomorrow-b", "overdue", "loose",
    ]);
  });
});
