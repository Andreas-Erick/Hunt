import { describe, expect, it } from "vitest";
import { computeQuestWeekProgress, rollingWeekKeys } from "@/lib/questProgress";

const today = "2026-03-29"; // the Sunday Europe/Berlin springs forward
const quests = [
  { id: "q1", archived: false, targetWeeklyHours: 2 },
  { id: "q2", archived: false, targetWeeklyHours: 4 },
  { id: "old", archived: true, targetWeeklyHours: 10 },
];
const log = (questId: string | null, dateKey: string, durationSeconds: number) => ({
  questId,
  dateKey,
  durationSeconds,
});

describe("rollingWeekKeys", () => {
  it("is today and the 6 days before it, newest first, across DST", () => {
    expect(rollingWeekKeys(today)).toEqual([
      "2026-03-29",
      "2026-03-28",
      "2026-03-27",
      "2026-03-26",
      "2026-03-25",
      "2026-03-24",
      "2026-03-23",
    ]);
  });
});

describe("computeQuestWeekProgress", () => {
  const logs = [
    log("q1", today, 1800),
    log("q1", "2026-03-24", 1800),
    log("q2", "2026-03-25", 3600),
    log("old", "2026-03-26", 600),
    log(null, today, 9999),
    log("q1", "2026-03-22", 7200), // outside the week (stale live-query window)
  ];

  it("sums per quest for today and the week, ignoring Other work and stale days", () => {
    const p = computeQuestWeekProgress({ quests, logs, todayKey: today });
    expect(p.forQuest(quests[0])).toEqual({ todaySeconds: 1800, weekSeconds: 3600, targetHours: 2, pct: 50, met: false });
    expect(p.forQuest(quests[1])).toMatchObject({ todaySeconds: 0, weekSeconds: 3600, pct: 25 });
  });

  it("totals all quest work against the targets of active quests only", () => {
    const { total } = computeQuestWeekProgress({ quests, logs, todayKey: today });
    expect(total).toEqual({ todaySeconds: 1800, weekSeconds: 7800, targetHours: 6, pct: 36, met: false });
  });

  it("adds the running burst to its quest and to the total, so every view agrees mid-session", () => {
    const p = computeQuestWeekProgress({
      quests,
      logs,
      todayKey: today,
      live: { questId: "q1", seconds: 1800 },
    });
    expect(p.forQuest(quests[0])).toMatchObject({ todaySeconds: 3600, weekSeconds: 5400, pct: 75 });
    expect(p.total.weekSeconds).toBe(9600);
  });

  it("ignores a running burst on Other work", () => {
    const p = computeQuestWeekProgress({ quests, logs, todayKey: today, live: { questId: null, seconds: 500 } });
    expect(p.total.weekSeconds).toBe(7800);
  });

  it("reports 0 % for a non-positive or garbage target and caps at 100 %", () => {
    const odd = [
      { id: "z", archived: false, targetWeeklyHours: 0 },
      { id: "n", archived: false, targetWeeklyHours: Number.NaN },
      { id: "big", archived: false, targetWeeklyHours: 1 },
    ];
    const p = computeQuestWeekProgress({
      quests: odd,
      logs: [log("z", today, 3600), log("n", today, 3600), log("big", today, 36000)],
      todayKey: today,
    });
    expect(p.forQuest(odd[0]).pct).toBe(0);
    expect(p.forQuest(odd[1]).pct).toBe(0);
    expect(p.forQuest(odd[2]).pct).toBe(100);
  });

  it("calls a target met once the week reaches a positive target, not just rounds up to 100 %", () => {
    const q = [
      { id: "a", archived: false, targetWeeklyHours: 1 },
      { id: "b", archived: false, targetWeeklyHours: 1 },
      { id: "none", archived: false, targetWeeklyHours: 0 },
    ];
    const p = computeQuestWeekProgress({
      quests: q,
      logs: [log("a", today, 3600), log("b", today, 3599), log("none", today, 3600)],
      todayKey: today,
    });
    expect(p.forQuest(q[0])).toMatchObject({ pct: 100, met: true });
    expect(p.forQuest(q[1])).toMatchObject({ pct: 100, met: false });
    expect(p.forQuest(q[2]).met).toBe(false);
  });
});
