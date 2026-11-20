import { describe, it, expect } from "vitest";
import { dateFromKey, type Quest, type Task, type TimeLog } from "@/lib/db";
import {
  buildHorizonWindow,
  computeActivityHeatmap,
  computePeriodReport,
  getCompletedTaskDateKey,
  getHeatmapStartKey,
  type ReviewHorizon,
} from "@/lib/reviewAnalytics";

const T0 = 1_700_000_000_000;

function makeQuest(
  id: string,
  title: string,
  slotIndex: 0 | 1 | 2 = 0,
  targetWeeklyHours = 14,
  archived = false
): Quest {
  return {
    id,
    slotIndex,
    code: title.toUpperCase().slice(0, 8),
    title,
    description: "",
    accentColor: slotIndex === 0 ? "cyan" : slotIndex === 1 ? "emerald" : "amber",
    targetWeeklyHours,
    archived,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeTask(
  id: string,
  questId: string | null,
  completedDateKey: string | null,
  extra: Partial<Task> = {}
): Task {
  const completedAt = completedDateKey
    ? dateFromKey(completedDateKey).getTime() + 3600_000
    : undefined;
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId,
    status: completedDateKey ? "completed" : "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: completedDateKey ?? "2026-03-30",
    completedAt,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeLog(
  id: string,
  dateKey: string,
  questId: string | null,
  durationSeconds: number,
  hourOfDay = 10
): TimeLog {
  const dayStart = new Date(
    Number(dateKey.slice(0, 4)),
    Number(dateKey.slice(5, 7)) - 1,
    Number(dateKey.slice(8, 10)),
    hourOfDay,
    15
  ).getTime();
  return {
    id,
    taskId: "tsk-1",
    taskTitleSnapshot: `Log ${id}`,
    questId,
    questCodeSnapshot: questId ?? "OTHER",
    accentColorSnapshot: questId ? "cyan" : "slate",
    startTime: dayStart,
    endTime: dayStart + durationSeconds * 1000,
    durationSeconds,
    dateKey,
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("reviewAnalytics: calendar windows & boundary rollovers", () => {
  it("clamps positive offsets to 0 and builds exact Day, Week, Month, Quarter, and Year ranges", () => {
    const day = buildHorizonWindow("day", 5, "2026-03-30");
    expect(day.offset).toBe(0);
    expect(day.startKey).toBe("2026-03-30");
    expect(day.endKey).toBe("2026-03-30");
    expect(day.totalDays).toBe(1);

    const prevDay = buildHorizonWindow("day", -1, "2026-03-30");
    expect(prevDay.startKey).toBe("2026-03-29");

    const week = buildHorizonWindow("week", 0, "2026-03-30");
    expect(week.startKey).toBe("2026-03-24");
    expect(week.endKey).toBe("2026-03-30");
    expect(week.totalDays).toBe(7);

    // Leap year February 2024 vs non-leap February 2026
    const leapFeb = buildHorizonWindow("month", -25, "2026-03-30");
    expect(leapFeb.startKey).toBe("2024-02-01");
    expect(leapFeb.endKey).toBe("2024-02-29");
    expect(leapFeb.totalDays).toBe(29);

    const regFeb = buildHorizonWindow("month", -1, "2026-03-30");
    expect(regFeb.startKey).toBe("2026-02-01");
    expect(regFeb.endKey).toBe("2026-02-28");
    expect(regFeb.totalDays).toBe(28);

    // Quarter rollover across year boundary (Q1 2026 -> Q4 2025 -> Q3 2025)
    const q1 = buildHorizonWindow("quarter", 0, "2026-03-30");
    expect(q1.rangeLabel).toBe("Q1 2026");
    expect(q1.startKey).toBe("2026-01-01");
    expect(q1.endKey).toBe("2026-03-31");
    expect(q1.totalDays).toBe(90);
    expect(q1.elapsedDays).toBe(89);

    const q4Prev = buildHorizonWindow("quarter", -1, "2026-03-30");
    expect(q4Prev.rangeLabel).toBe("Q4 2025");
    expect(q4Prev.startKey).toBe("2025-10-01");
    expect(q4Prev.endKey).toBe("2025-12-31");
    expect(q4Prev.totalDays).toBe(92);

    // Year leap vs non-leap
    const yr2026 = buildHorizonWindow("year", 0, "2026-03-30");
    expect(yr2026.startKey).toBe("2026-01-01");
    expect(yr2026.endKey).toBe("2026-12-31");
    expect(yr2026.totalDays).toBe(365);

    const yr2024 = buildHorizonWindow("year", -2, "2026-03-30");
    expect(yr2024.totalDays).toBe(366);
  });

  it("resolves completed task dates safely across completedAt, scheduledDate, and legacy updatedAt", () => {
    const queued = makeTask("q", "quest-1", null);
    expect(getCompletedTaskDateKey(queued)).toBeNull();

    const withStamp = makeTask("c1", "quest-1", "2026-03-28");
    expect(getCompletedTaskDateKey(withStamp)).toBe("2026-03-28");

    const fallbackSched: Task = {
      ...withStamp,
      completedAt: undefined,
      scheduledDate: "2026-03-25",
    };
    expect(getCompletedTaskDateKey(fallbackSched)).toBe("2026-03-25");

    const fallbackUpdated: Task = {
      ...withStamp,
      completedAt: undefined,
      scheduledDate: "not-a-date",
      updatedAt: dateFromKey("2026-03-21").getTime(),
    };
    expect(getCompletedTaskDateKey(fallbackUpdated)).toBe("2026-03-21");
  });
});

describe("reviewAnalytics: Quest X deep-dive across Day, Week, Month, Quarter, Year", () => {
  const qAlpha = makeQuest("quest-alpha", "Engine Rewrite", 0, 14);
  const qBeta = makeQuest("quest-beta", "Research Paper", 1, 7);
  const quests = [qAlpha, qBeta];

  const logs: TimeLog[] = [
    makeLog("l1", "2026-03-30", "quest-alpha", 7200, 9), // 2.0h morning
    makeLog("l2", "2026-03-30", "quest-alpha", 3600, 15), // 1.0h afternoon
    makeLog("l3", "2026-03-25", "quest-beta", 5400, 11), // 1.5h in week
    makeLog("l4", "2026-03-10", "quest-alpha", 10800, 10), // 3.0h earlier in March
    makeLog("l5", "2026-01-15", "quest-alpha", 14400, 14), // 4.0h in Jan (Q1 & Year)
    makeLog("l6", "2026-03-30", null, 1800, 18), // 0.5h Other
    // Corrupted / negative duration ignored gracefully
    { ...makeLog("l-bad", "2026-03-30", "quest-alpha", -500), durationSeconds: Number.NaN },
  ];

  const tasks: Task[] = [
    makeTask("t1", "quest-alpha", "2026-03-30"),
    makeTask("t2", "quest-alpha", "2026-03-30", { habitId: "hab-1" }),
    makeTask("t3", "quest-beta", "2026-03-26"),
    makeTask("t4", "quest-alpha", "2026-03-12"),
    makeTask("t5", "quest-alpha", "2026-02-04"),
    makeTask("t6", null, "2026-03-30"),
    makeTask("t-open", "quest-alpha", null), // open task never counted
  ];

  it("counts exact hours and completed tasks for Quest X across every horizon", () => {
    const expectedByHorizon: Record<
      ReviewHorizon,
      { hours: number; tasks: number; bucketsLen: number }
    > = {
      day: { hours: 3.0, tasks: 2, bucketsLen: 6 },
      week: { hours: 3.0, tasks: 2, bucketsLen: 7 },
      month: { hours: 6.0, tasks: 3, bucketsLen: 5 },
      quarter: { hours: 10.0, tasks: 4, bucketsLen: 3 },
      year: { hours: 10.0, tasks: 4, bucketsLen: 12 },
    };

    for (const [horizon, exp] of Object.entries(expectedByHorizon) as Array<
      [ReviewHorizon, { hours: number; tasks: number; bucketsLen: number }]
    >) {
      const win = buildHorizonWindow(horizon, 0, "2026-03-30");
      const rep = computePeriodReport({
        window: win,
        logs,
        tasks,
        quests,
        scope: "quest-alpha",
        todayKey: "2026-03-30",
      });
      expect(rep.focusHours, horizon).toBe(exp.hours);
      expect(rep.completedTasksCount, horizon).toBe(exp.tasks);
      expect(rep.buckets, horizon).toHaveLength(exp.bucketsLen);
      expect(
        rep.buckets.reduce((s, b) => s + b.completedTasks, 0),
        horizon
      ).toBe(exp.tasks);
      expect(rep.filteredLogs.every((l) => l.questId === "quest-alpha")).toBe(true);
    }

    // Check step vs habit split on Today for Quest Alpha
    const dayRep = computePeriodReport({
      window: buildHorizonWindow("day", 0, "2026-03-30"),
      logs,
      tasks,
      quests,
      scope: "quest-alpha",
      todayKey: "2026-03-30",
    });
    expect(dayRep.stepTasksCompleted).toBe(1);
    expect(dayRep.habitTasksCompleted).toBe(1);
    expect(dayRep.sessionsCount).toBe(2);
    expect(dayRep.avgSessionMinutes).toBe(90);
    expect(dayRep.longestSessionMinutes).toBe(120);
  });

  it("computes Activity Heatmap streaks, intensity levels, and Quest X isolation", () => {
    const streakLogs = [
      makeLog("s1", "2026-03-29", "quest-alpha", 3600),
      makeLog("s2", "2026-03-28", "quest-alpha", 7200),
      makeLog("s3", "2026-03-27", "quest-beta", 18000), // Beta only on Mar 27!
    ];
    const streakTasks = [
      makeTask("st1", "quest-alpha", "2026-03-27"), // Alpha task done on Mar 27 bridges the streak!
    ];

    // Even before logging today (2026-03-30), yesterday..Mar 27 = 3-day active streak for Alpha!
    const alphaHm = computeActivityHeatmap({
      logs: streakLogs,
      tasks: streakTasks,
      scope: "quest-alpha",
      weeksCount: 16,
      todayKey: "2026-03-30",
    });
    expect(alphaHm.columns).toHaveLength(16);
    expect(alphaHm.currentStreak).toBe(3);
    expect(alphaHm.longestStreak).toBe(3);
    expect(alphaHm.activeDays).toBe(3);
    expect(alphaHm.totalHours).toBe(3.0);
    expect(alphaHm.totalCompletedTasks).toBe(1);

    // Beta only has Mar 27 -> currentStreak is 0 (broken on Mar 28 & 29), longestStreak is 1
    const betaHm = computeActivityHeatmap({
      logs: streakLogs,
      tasks: streakTasks,
      scope: "quest-beta",
      weeksCount: 16,
      todayKey: "2026-03-30",
    });
    expect(betaHm.currentStreak).toBe(0);
    expect(betaHm.longestStreak).toBe(1);
    expect(betaHm.totalHours).toBe(5.0);
    expect(betaHm.startKey).toBe(getHeatmapStartKey(16, "2026-03-30"));
  });

  it("100-seed property test: quest breakdown + Other sums match totals across all horizons", () => {
    const horizons: ReviewHorizon[] = ["day", "week", "month", "quarter", "year"];
    for (let seed = 1; seed <= 100; seed++) {
      const rand = mulberry32(seed);
      const qList = [
        makeQuest("q0", "Q0", 0, 10),
        makeQuest("q1", "Q1", 1, 8),
        makeQuest("q2", "Q2", 2, 6, rand() < 0.3),
      ];
      const horizon = horizons[seed % horizons.length];
      const offset = -Math.floor(rand() * 4);
      const win = buildHorizonWindow(horizon, offset, "2026-06-18");

      const randLogs: TimeLog[] = [];
      const randTasks: Task[] = [];
      for (let i = 0; i < 25; i++) {
        const dayShift = -Math.floor(rand() * 400);
        const d = dateFromKey("2026-06-18", dayShift);
        const dk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate()
        ).padStart(2, "0")}`;
        const qPick = rand() < 0.25 ? null : qList[Math.floor(rand() * qList.length)].id;
        randLogs.push(makeLog(`l-${i}`, dk, qPick, Math.floor(rand() * 9000), Math.floor(rand() * 24)));
        if (rand() < 0.7) {
          randTasks.push(
            makeTask(`t-${i}`, qPick, dk, {
              habitId: rand() < 0.35 ? "hab-x" : undefined,
            })
          );
        }
      }

      const allRep = computePeriodReport({
        window: win,
        logs: randLogs,
        tasks: randTasks,
        quests: qList,
        scope: "ALL",
        todayKey: "2026-06-18",
      });

      const sumQuestSec = qList.reduce((acc, q) => {
        const sub = computePeriodReport({
          window: win,
          logs: randLogs,
          tasks: randTasks,
          quests: qList,
          scope: q.id,
          todayKey: "2026-06-18",
        });
        return acc + sub.focusSeconds;
      }, 0);
      const otherRep = computePeriodReport({
        window: win,
        logs: randLogs,
        tasks: randTasks,
        quests: qList,
        scope: "OTHER",
        todayKey: "2026-06-18",
      });

      expect(sumQuestSec).toBe(allRep.focusSeconds);
      expect(allRep.stepTasksCompleted + allRep.habitTasksCompleted).toBe(
        allRep.completedTasksCount
      );
      expect(allRep.buckets.reduce((s, b) => s + b.completedTasks, 0)).toBe(
        allRep.completedTasksCount
      );
      expect(
        qList.reduce((acc, q) => {
          const sub = computePeriodReport({
            window: win,
            logs: randLogs,
            tasks: randTasks,
            quests: qList,
            scope: q.id,
            todayKey: "2026-06-18",
          });
          return acc + sub.completedTasksCount;
        }, 0) + otherRep.completedTasksCount
      ).toBe(allRep.completedTasksCount);
      expect(allRep.focusSharePct).toBeGreaterThanOrEqual(0);
      expect(allRep.focusSharePct).toBeLessThanOrEqual(100);
    }
  });
});
