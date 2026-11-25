// Review statistics stay exact (seconds conserved, no NaN) and render on small and large datasets.
import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QUEST_ACCENT_KEYS, type Quest, type Task, type TimeLog } from "@/lib/domainTypes";
import { db } from "@/lib/db";
import { toLocalDateKey } from "@/lib/dateUtils";
import {
  buildHorizonWindow,
  computeActivityHeatmap,
  computePeriodReport,
  formatTelemetryDuration,
  layoutTimelineBlocks,
} from "@/lib/reviewAnalytics";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { click as mobileClick, loadMobile, pageErrors } from "./helpers/loadMobile";
import { mulberry32, makeQuest, makeTimeLog, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

// ---------------------------------------------------------------------------
// 4. Statistics Accuracy & Appeal (Zero, Small <6m, Scope Isolation, Large Data, Fuzz)
// ---------------------------------------------------------------------------
describe("Statistics accuracy & visual rendering across small and large datasets", () => {
  it("formats boundary durations cleanly without NaN/Infinity or hiding sub-6m sessions", () => {
    expect(formatTelemetryDuration(0)).toBe("0.0h");
    expect(formatTelemetryDuration(0, { zeroAs: "0h" })).toBe("0h");
    expect(formatTelemetryDuration(-25)).toBe("0.0h");
    expect(formatTelemetryDuration(Number.NaN)).toBe("0.0h");
    expect(formatTelemetryDuration(Number.POSITIVE_INFINITY)).toBe("0.0h");
    expect(formatTelemetryDuration(45)).toBe("45s");
    expect(formatTelemetryDuration(125)).toBe("2m");
    expect(formatTelemetryDuration(299)).toBe("5m");
    expect(formatTelemetryDuration(359)).toBe("6m");
    expect(formatTelemetryDuration(360)).toBe("0.1h");
    expect(formatTelemetryDuration(3600 * 105, { compactLarge: true })).toBe("105h");
    expect(formatTelemetryDuration(3600 * 1500, { compactLarge: true })).toBe("1.5kh");
  });

  it("handles tiny (<6m) sessions accurately in computePeriodReport, computeActivityHeatmap, Desktop UI, and Mobile UI", async () => {
    const todayKey = "2026-06-17";
    const yesterdayKey = "2026-06-16";
    const anchor = new Date(2026, 5, 17, 14, 0, 0).getTime();

    const quests: Quest[] = [makeQuest("q-small", 0, "Micro Practice", "purple", "", 5)];
    const tasks: Task[] = [];
    // 45s on quest today, plus an unassigned ("OTHER") log yesterday to verify activeDays scope isolation!
    const logs: TimeLog[] = [
      makeTimeLog({
        id: "log-45s",
        taskId: "t-1",
        taskTitleSnapshot: "Quick Drill",
        questId: "q-small",
        accentColorSnapshot: "purple",
        startTime: anchor - 60_000,
        durationSeconds: 45,
        dateKey: todayKey,
      }),
      makeTimeLog({
        id: "log-other",
        taskId: "t-2",
        taskTitleSnapshot: "Ad-hoc Admin",
        questId: null,
        startTime: anchor - 86_400_000,
        durationSeconds: 1800,
        dateKey: yesterdayKey,
      }),
    ];

    const weekWin = buildHorizonWindow("week", 0, todayKey);
    const weekAll = computePeriodReport({
      window: weekWin,
      logs,
      tasks,
      quests,
      scope: "ALL",
      todayKey,
    });
    expect(weekAll.questSeconds).toBe(45);
    expect(weekAll.otherSeconds).toBe(1800);
    expect(weekAll.grandTotalSeconds).toBe(1845);
    // Quest activeDaysCount must ONLY count days with quest activity (1 day), NOT yesterday's OTHER log!
    expect(weekAll.activeDaysCount).toBe(1);
    expect(weekAll.dailyAverageSeconds).toBe(45);
    expect(weekAll.avgSessionMinutes).toBe(1);
    expect(weekAll.longestSessionMinutes).toBe(1);
    expect(weekAll.peakBucket?.seconds).toBe(45);

    const hm = computeActivityHeatmap({
      logs,
      tasks,
      scope: "q-small",
      todayKey,
    });
    const todayCell = hm.columns.flatMap((col) => col.cells).find((c) => c.dateKey === todayKey);
    expect(todayCell?.seconds).toBe(45);
    expect(todayCell?.level).toBe(1);

    // Render Desktop Review with the 45s session
    const liveNow = Date.now();
    const liveKey = toLocalDateKey(liveNow);
    await db.quests.bulkAdd(quests);
    await db.timeLogs.bulkAdd([
      makeTimeLog({
        id: "live-45s",
        taskId: "t-1",
        taskTitleSnapshot: "Quick Drill",
        questId: "q-small",
        accentColorSnapshot: "purple",
        startTime: liveNow - 50_000,
        durationSeconds: 45,
        dateKey: liveKey,
      }),
    ]);

    render(<TelemetryDashboardView />);
    await waitFor(() => {
      expect(screen.getAllByText("45s").length).toBeGreaterThan(0);
    });

    // Mobile Review ("telemetry") with 45s session
    const w = loadMobile({
      seedState: {
        quests,
        tasks: [],
        habits: [],
        timeLogs: [
          {
            id: "m-log-45s",
            taskId: "t-1",
            taskTitleSnapshot: "Quick Drill",
            questId: "q-small",
            startTime: liveNow - 50_000,
            endTime: liveNow - 5_000,
            durationSeconds: 45,
            dateKey: liveKey,
          },
        ],
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });
    try {
      w.switchView("telemetry");
      const text = w.document.getElementById("mainContainer")?.textContent ?? "";
      expect(text).toContain("45s");
      expect(text).not.toContain("NaN");
    } finally {
      w.close();
    }
  });

  it("paginates large session logs (135 rows) cleanly at 50 per page on Desktop and Mobile", async () => {
    const now = Date.now();
    const todayKey = toLocalDateKey(now);
    const quest = makeQuest("q-large", 0, "Scale Engine", "orange", "", 40);
    const logs: TimeLog[] = Array.from({ length: 135 }, (_, i) =>
      makeTimeLog({
        id: `log-bulk-${i}`,
        taskId: `t-bulk-${i}`,
        taskTitleSnapshot: `Deep Session #${i + 1}`,
        questId: "q-large",
        accentColorSnapshot: "orange",
        startTime: now - (i + 1) * 1000,
        durationSeconds: 36_000, // 10h each -> 1,350h total!
        dateKey: todayKey,
      })
    );

    await db.quests.add(quest);
    await db.timeLogs.bulkAdd(logs);

    render(<TelemetryDashboardView />);

    const openLogsBtn = await screen.findByRole("button", { name: /Session log \(135 sessions/i });
    fireEvent.click(openLogsBtn);

    const showMoreBtn = await screen.findByTestId("review-logs-show-more");
    expect(showMoreBtn.textContent).toContain("85 remaining");
    expect(screen.getByText("Deep Session #1")).toBeTruthy();
    expect(screen.queryByText("Deep Session #51")).toBeNull();

    fireEvent.click(showMoreBtn);
    await waitFor(() => {
      expect(screen.getByText("Deep Session #51")).toBeTruthy();
      expect(screen.getByTestId("review-logs-show-more").textContent).toContain("35 remaining");
    });

    fireEvent.click(screen.getByTestId("review-logs-show-more"));
    await waitFor(() => {
      expect(screen.getByText("Deep Session #135")).toBeTruthy();
      expect(screen.queryByTestId("review-logs-show-more")).toBeNull();
    });

    // Verify Mobile Review ("telemetry") also paginates 135 sessions at 50 per page
    const w = loadMobile({
      seedState: {
        quests: [quest],
        tasks: [],
        habits: [],
        timeLogs: logs,
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });
    try {
      w.switchView("telemetry");
      w.eval("showReviewSessionLog=true;renderApp();");
      const mBtn = w.document.querySelector('[data-testid="mobile-logs-show-more"]');
      expect(mBtn).not.toBeNull();
      expect(mBtn?.textContent).toContain("85 remaining");
      mobileClick(w, mBtn);
      expect(w.document.querySelector('[data-testid="mobile-logs-show-more"]')?.textContent).toContain(
        "35 remaining"
      );
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });

  it("expands early/late timeline hours and lays out concurrent overlapping sessions without collision", () => {
    const dayStart = new Date(2026, 5, 17, 0, 0, 0).getTime();
    const hm = (h: number, m: number) => dayStart + (h * 60 + m) * 60_000;

    const layout = layoutTimelineBlocks(
      [
        { id: "early", startTime: hm(5, 30), durationSeconds: 45 * 60 },
        { id: "overlap-1", startTime: hm(10, 0), durationSeconds: 90 * 60 },
        { id: "overlap-2", startTime: hm(10, 15), durationSeconds: 45 * 60 },
        { id: "overlap-3", startTime: hm(10, 20), durationSeconds: 100 * 60 },
        { id: "overlap-4", startTime: hm(10, 25), durationSeconds: 25 * 60 },
        { id: "overlap-5", startTime: hm(10, 30), durationSeconds: 25 * 60 },
        { id: "late", startTime: hm(23, 15), durationSeconds: 35 * 60 },
      ],
      8,
      22
    );

    expect(layout.windowStartHour).toBe(5);
    expect(layout.windowEndHour).toBe(24);
    expect(layout.placements.size).toBe(7);

    for (const p of Array.from(layout.placements.values())) {
      expect(p.colIndex).toBeGreaterThanOrEqual(0);
      expect(p.colIndex).toBeLessThan(4);
      expect(p.totalCols).toBeGreaterThanOrEqual(1);
      expect(p.totalCols).toBeLessThanOrEqual(4);
      expect(p.endHour).toBeGreaterThan(p.startHour);
    }

    const overlapCols = ["overlap-1", "overlap-2", "overlap-3", "overlap-4"].map(
      (id) => layout.placements.get(id)?.colIndex
    );
    expect(new Set(overlapCols).size).toBe(4);
  });

  it("conserves exact seconds and stays NaN-free across 100 seeded fuzz datasets over all 8 quest colors", () => {
    const anchor = new Date(2026, 7, 20, 15, 0, 0).getTime();
    const todayKey = toLocalDateKey(anchor);
    const weekWin = buildHorizonWindow("week", 0, todayKey);
    const rand = mulberry32(0x180077);

    for (let iter = 0; iter < 100; iter++) {
      const count = 1 + Math.floor(rand() * 3);
      const quests: Quest[] = Array.from({ length: count }, (_, idx) => {
        const accent = QUEST_ACCENT_KEYS[Math.floor(rand() * QUEST_ACCENT_KEYS.length)];
        return makeQuest(
          `q-${idx}`,
          idx as 0 | 1 | 2,
          `Quest ${accent}`,
          accent,
          "",
          Math.floor(rand() * 30)
        );
      });

      const logCount = Math.floor(rand() * 25);
      const logs: TimeLog[] = Array.from({ length: logCount }, (_, i) => {
        const dayOffset = -Math.floor(rand() * 14);
        const ts = anchor + dayOffset * 86_400_000;
        const dur = rand() < 0.3 ? Math.floor(rand() * 120) + 1 : Math.floor(rand() * 7200);
        const qPick = rand() < 0.25 ? null : quests[Math.floor(rand() * quests.length)].id;
        return makeTimeLog({
          id: `flog-${iter}-${i}`,
          taskId: `ft-${i}`,
          taskTitleSnapshot: `Task ${i}`,
          questId: qPick,
          startTime: ts,
          durationSeconds: dur,
          dateKey: toLocalDateKey(ts),
        });
      });

      const report = computePeriodReport({
        window: weekWin,
        logs,
        tasks: [],
        quests,
        scope: "ALL",
        todayKey,
      });
      const msg = `iter=${iter}`;
      expect(Number.isFinite(report.focusHours), msg).toBe(true);
      expect(Number.isFinite(report.dailyAverageHours), msg).toBe(true);
      expect(report.grandTotalSeconds, msg).toBe(report.questSeconds + report.otherSeconds);

      const bucketSum = report.buckets.reduce((s, b) => s + b.seconds, 0);
      expect(bucketSum, msg).toBe(report.questSeconds);

      const hm = computeActivityHeatmap({
        logs,
        tasks: [],
        scope: "ALL",
        todayKey,
      });
      expect(Number.isFinite(hm.totalHours), msg).toBe(true);
    }
  });
});
