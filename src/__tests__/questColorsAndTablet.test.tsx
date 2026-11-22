// All 8 quest colours work end to end, and the phone page lays out for tablets.
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { QUEST_ACCENT_KEYS, type TimeLog } from "@/lib/domainTypes";
import { QUEST_ACCENT_STYLES } from "@/lib/questAccents";
import { toLocalDateKey } from "@/lib/dateUtils";
import { computeActivityHeatmap } from "@/lib/reviewAnalytics";
import { validateSyncPayload } from "@/lib/syncTypes";
import { ReviewHeatmapCard } from "@/components/ReviewHeatmapCard";
import { loadMobile, pageErrors } from "./helpers/loadMobile";
import { ROOT, makeQuest, makeTimeLog, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

// ---------------------------------------------------------------------------
// 5. All 8 Quest Colors & Tablet Responsive Layout
// ---------------------------------------------------------------------------
describe("8 Quest colors end-to-end & Tablet layout in Hunt Mobile", () => {
  it("accepts all 8 quest colors in validateSyncPayload and ReviewHeatmapCard while keeping unknown colors safe", () => {
    const quests = QUEST_ACCENT_KEYS.map((color, idx) =>
      makeQuest(`q-col-${idx}`, (idx % 3) as 0 | 1 | 2, `Color ${color}`, color, "", 5)
    );

    const validated = validateSyncPayload({
      quests,
      tasks: [],
      habits: [],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedHabitIds: [],
      deletedLogIds: [],
    });
    expect(validated.valid).toBe(true);
    expect(validated.payload?.quests.map((q) => q.accentColor)).toEqual([...QUEST_ACCENT_KEYS]);

    // Render ReviewHeatmapCard with each of the 8 colors active
    const now = Date.now();
    const todayKey = toLocalDateKey(now);
    const logs: TimeLog[] = quests.map((q, idx) =>
      makeTimeLog({
        id: `hm-log-${idx}`,
        taskId: `hm-t-${idx}`,
        taskTitleSnapshot: q.title,
        questId: q.id,
        accentColorSnapshot: q.accentColor,
        startTime: now - 60_000,
        durationSeconds: 1200,
        dateKey: todayKey,
      })
    );

    const baseHm = computeActivityHeatmap({
      logs,
      tasks: [],
      scope: "ALL",
      todayKey,
    });

    const { rerender, container } = render(
      <ReviewHeatmapCard heatmap={baseHm} scopeTitle="All quests" paletteAccent="amber" />
    );
    for (const q of quests) {
      const qHm = computeActivityHeatmap({
        logs,
        tasks: [],
        scope: q.id,
        todayKey,
      });
      rerender(<ReviewHeatmapCard heatmap={qHm} scopeTitle={q.title} paletteAccent={q.accentColor} />);
      expect(container.querySelector('[data-testid="activity-heatmap"]')).not.toBeNull();
      expect(QUEST_ACCENT_STYLES[q.accentColor].cssVar).toBe(`--q-${q.accentColor}`);
    }
  });

  it("renders all 8 quest color swatches and multi-column Tablet responsive grids in hunt-mobile.html", () => {
    const html = fs.readFileSync(path.join(ROOT, "public", "hunt-mobile.html"), "utf8");
    expect(html).toContain("@media (min-width: 768px)");
    expect(html).toContain("@media (min-width: 1120px)");
    expect(html).toContain(".today-tablet-split");
    expect(html).toContain(".quests-grid");
    expect(html).toContain(".habits-grid");
    expect(html).toContain(".review-tablet-split");
    expect(html).toContain(".guide-workshop-split");

    const now = Date.now();
    const w = loadMobile({
      seedState: {
        quests: QUEST_ACCENT_KEYS.map((c, idx) => ({
          id: `mq-${c}`,
          slotIndex: idx % 3,
          title: `Quest ${c}`,
          description: `Desc ${c}`,
          accentColor: c,
          targetWeeklyHours: 6,
          archived: false,
          createdAt: 1000,
          updatedAt: 1000,
        })),
        tasks: [
          {
            id: "mt-1",
            title: "Tablet Priority Task",
            notes: "Side-by-side with Day Timeline on tablet",
            status: "queued",
            questId: "mq-purple",
            rank: 1000,
            accumulatedSeconds: 180,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        habits: [
          {
            id: "mh-1",
            title: "Daily Stretch",
            notes: "5 min",
            questId: "mq-rose",
            rank: 1000,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        timeLogs: [
          {
            id: "ml-1",
            taskId: "mt-1",
            taskTitleSnapshot: "Tablet Priority Task",
            questId: "mq-purple",
            startTime: now - 1800_000,
            endTime: now - 600_000,
            durationSeconds: 1200,
            dateKey: toLocalDateKey(now),
          },
        ],
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });

    try {
      // TODAY ("command") view renders both queue pane and timeline pane inside .today-tablet-split
      expect(w.document.querySelector(".today-tablet-split")).not.toBeNull();
      expect(w.document.querySelector(".today-queue-pane")).not.toBeNull();
      expect(w.document.querySelector(".today-timeline-pane")).not.toBeNull();

      // QUESTS ("quests") view renders .quests-grid and 8 color options in New Quest & Edit Quest sheets
      w.switchView("quests");
      expect(w.document.querySelector(".quests-grid")).not.toBeNull();
      w.openNewQuestSheet();
      expect(w.document.querySelectorAll("#sheetContainer .sheet-pill[data-color]")).toHaveLength(8);
      w.closeSheet(true);

      w.openQuestEditorSheet("mq-purple");
      expect(w.document.querySelectorAll("#sheetContainer .sheet-pill[data-color]")).toHaveLength(8);
      w.closeSheet(true);

      // HABITS ("habits") view renders .habits-grid
      w.switchView("habits");
      expect(w.document.querySelector(".habits-grid")).not.toBeNull();

      // REVIEW ("telemetry") view renders .review-tablet-split
      w.switchView("telemetry");
      expect(w.document.querySelector(".review-tablet-split")).not.toBeNull();

      // GUIDE ("guide") view renders .guide-principles-grid, .guide-workshop-split, and 8 workshop color pills
      w.eval("openGuideView('quests')");
      expect(w.document.querySelector(".guide-principles-grid")).not.toBeNull();
      w.eval("openGuideView('workshop'); guideLabMode='quest'; renderApp();");
      expect(w.document.querySelector(".guide-workshop-split")).not.toBeNull();
      expect(w.document.querySelectorAll('[aria-label="Quest accent color"] button')).toHaveLength(8);

      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
