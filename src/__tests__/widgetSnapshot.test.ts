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
