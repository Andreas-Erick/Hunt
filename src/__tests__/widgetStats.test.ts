// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Habit, Quest, Task, TimeLog } from "@/lib/domainTypes";
import { computeQuestWeekProgress } from "@/lib/questProgress";
import { summarizeHabitDays } from "@/lib/habitDay";
import type { SyncPayload } from "@/lib/syncTypes";
import { buildWidgetSnapshot } from "@/mobile/huntCore";

const TODAY = "2026-11-22";
const TOMORROW = "2026-11-23";

function quest(id: string, over: Partial<Quest> = {}): Quest {
  return {
    id,
    slotIndex: 0,
    code: id.toUpperCase(),
    title: `Quest ${id}`,
    description: "",
    accentColor: "amber",
    targetWeeklyHours: 8,
    archived: false,
    createdAt: 1,
    ...over,
  };
}

function log(id: string, questId: string | null, dateKey: string, durationSeconds: number): TimeLog {
  return {
    id,
    taskId: "t",
    taskTitleSnapshot: "",
    questId,
    questCodeSnapshot: "",
    accentColorSnapshot: "slate",
    startTime: 1,
    endTime: 2,
    durationSeconds,
    dateKey,
  };
}

function habit(id: string, title: string, rank: number): Habit {
  return { id, title, notes: "", questId: null, rank, createdAt: 1 };
}

/** A completed instance of habit `habitId` on `dateKey`. */
function doneHabitDay(habitId: string, dateKey: string): Task {
  return {
    id: `habtsk-${dateKey}-${habitId}`,
    title: habitId,
    notes: "",
    questId: null,
    habitId,
    scheduledDate: dateKey,
    status: "completed",
    completedAt: 1,
    rank: 1,
    accumulatedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

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

const statsOf = (s: SyncPayload) => buildWidgetSnapshot(s, TODAY, "neon").stats;

describe("buildWidgetSnapshot (Stats Widget)", () => {
  const quests = [
    quest("lrn", { slotIndex: 2, accentColor: "lime", targetWeeklyHours: 5 }),
    quest("wrt", { slotIndex: 0, accentColor: "cyan", targetWeeklyHours: 8 }),
    quest("fit", { slotIndex: 1, accentColor: "nope" as Quest["accentColor"], targetWeeklyHours: 6 }),
    quest("old", { slotIndex: 2, archived: true }),
  ];
  const timeLogs = [
    log("a", "wrt", TODAY, 3600),
    log("b", "wrt", "2026-11-16", 16200), // 6 days ago: inside the rolling week
    log("c", "wrt", "2026-11-15", 7200), // 7 days ago: outside
    log("d", "fit", "2026-11-20", 36000),
    log("e", null, TODAY, 600), // Other work: not Quest time
    log("f", "old", TODAY, 900),
  ];

  it("has an entry for today and one for tomorrow", () => {
    expect(statsOf(state()).map((e) => e.dateKey)).toEqual([TODAY, TOMORROW]);
  });

  it("lists every active Quest in slot order with its rolling-week hours and target", () => {
    const [today] = statsOf(state({ quests, timeLogs }));
    expect(today.quests).toEqual([
      { code: "WRT", accent: "cyan", weekSeconds: 19800, targetHours: 8, pct: 69, met: false },
      { code: "FIT", accent: "slate", weekSeconds: 36000, targetHours: 6, pct: 100, met: true },
      { code: "LRN", accent: "lime", weekSeconds: 0, targetHours: 5, pct: 0, met: false },
    ]);
  });

  it("matches the app's Quest progress (computeQuestWeekProgress) for every Quest", () => {
    const [today] = statsOf(state({ quests, timeLogs }));
    const progress = computeQuestWeekProgress({ quests, logs: timeLogs, todayKey: TODAY });
    const active = quests.filter((q) => !q.archived).sort((a, b) => a.slotIndex - b.slotIndex);
    expect(today.quests.map((q) => [q.weekSeconds, q.targetHours, q.pct])).toEqual(
      active.map((q) => {
        const p = progress.forQuest(q);
        return [p.weekSeconds, p.targetHours, p.pct];
      }),
    );
    expect(today.focusSeconds).toBe(progress.total.todaySeconds);
  });

  it("counts today's Quest focus time, archived Quests included, Other work not", () => {
    expect(statsOf(state({ quests, timeLogs }))[0].focusSeconds).toBe(4500);
  });

  it("lists Habit streaks in Habit order with the app's streak rule", () => {
    const habits = [habit("run", "Run", 300), habit("med", "Meditate", 100), habit("read", "Read", 200)];
    const tasks = [
      doneHabitDay("med", TODAY),
      doneHabitDay("med", "2026-11-21"),
      doneHabitDay("med", "2026-11-20"),
      doneHabitDay("read", "2026-11-21"), // today still open: the streak runs to yesterday
      doneHabitDay("run", "2026-11-19"), // broken
    ];
    const [today] = statsOf(state({ habits, tasks }));
    expect(today.streaks).toEqual([
      { title: "Meditate", days: 3 },
      { title: "Read", days: 1 },
      { title: "Run", days: 0 },
    ]);
    const { summaryFor } = summarizeHabitDays(tasks, TODAY);
    expect(today.streaks.map((s) => s.days)).toEqual(["med", "read", "run"].map((id) => summaryFor(id).streak));
  });

  it("rolls over for tomorrow: the week moves on a day, focus restarts at 0, streaks keep today's tick", () => {
    const habits = [habit("med", "Meditate", 100), habit("read", "Read", 200)];
    const tasks = [doneHabitDay("med", TODAY), doneHabitDay("med", "2026-11-21"), doneHabitDay("read", "2026-11-21")];
    const [, tomorrow] = statsOf(state({ quests, timeLogs, habits, tasks }));
    expect(tomorrow.dateKey).toBe(TOMORROW);
    expect(tomorrow.focusSeconds).toBe(0);
    // 2026-11-16 drops out of the week ending tomorrow; today's hour stays.
    expect(tomorrow.quests[0]).toMatchObject({ code: "WRT", weekSeconds: 3600, pct: 13, met: false });
    expect(tomorrow.streaks).toEqual([
      { title: "Meditate", days: 2 },
      { title: "Read", days: 0 },
    ]);
  });

  it("has no Quest rows and no streaks for a user without Quests or Habits", () => {
    const [today] = statsOf(state({ tasks: [doneHabitDay("x", TODAY)] }));
    expect(today).toEqual({ dateKey: TODAY, focusSeconds: 0, quests: [], streaks: [] });
  });
});
