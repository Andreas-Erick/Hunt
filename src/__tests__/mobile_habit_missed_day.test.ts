// @vitest-environment node
// Phone page: a daily habit that was not done yesterday is a missed day. Yesterday's still-queued
// habtsk-<yesterday>-<habitId> row stays in the data (history: streaks, Review, the heatmap) but it
// is never an open task again, so the habit never shows twice (yesterday's copy next to today's) in
// any list, count, picker or rank calculation. A copy whose focus session is running across
// midnight ("active") stays visible until it is finished.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, pageErrors, readState, type MobileWindow, type PageRow } from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const DAY = 86_400_000;
const HABIT_ID = "hab-read";

let w: MobileWindow | null = null;
function load(options: Parameters<typeof loadMobile>[0] = {}): MobileWindow {
  w = loadMobile(options);
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function localKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const TODAY = localKey(NOW);
const YESTERDAY = localKey(NOW - DAY);
const TODAY_TID = `habtsk-${TODAY}-${HABIT_ID}`;
const YESTERDAY_TID = `habtsk-${YESTERDAY}-${HABIT_ID}`;

function quest(id: string, title: string) {
  return { id, slotIndex: 0, title, description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1 };
}
function task(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, notes: "", status: "queued", rank: 0, questId: "quest-1", accumulatedSeconds: 0, updatedAt: 1, ...extra };
}
function habit(rank = 1500) {
  return { id: HABIT_ID, title: "Read 20 pages", notes: "", questId: "quest-1", rank, createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY };
}
/** Yesterday's materialized copy of the habit, never done. */
function missedRow(extra: Record<string, unknown> = {}) {
  return task(YESTERDAY_TID, "Read 20 pages", {
    habitId: HABIT_ID,
    scheduledDate: YESTERDAY,
    rank: -5000,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    ...extra,
  });
}
function state(tasks: unknown[], extra: Record<string, unknown> = {}) {
  return {
    quests: [quest("quest-1", "Launch")],
    tasks,
    habits: [habit()],
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...extra,
  };
}

function rowById(p: MobileWindow, id: string): PageRow {
  const row = readState(p).tasks.find((t) => t.id === id);
  if (!row) throw new Error("missing task " + id);
  return row;
}
function cardIds(p: MobileWindow, root: ParentNode = p.document): string[] {
  return Array.from(root.querySelectorAll("[data-flip-task-id]")).map((el) => el.getAttribute("data-flip-task-id") ?? "");
}
function pageJson(p: MobileWindow, expr: string): unknown {
  const text: unknown = p.eval(`JSON.stringify(${expr})`);
  return typeof text === "string" ? JSON.parse(text) : null;
}

describe("phone: a missed daily habit never shows up twice the next day", () => {
  it("boot keeps yesterday's missed copy as history and adds exactly one copy for today", () => {
    const p = load({ seedState: state([missedRow()]) });
    const ids = readState(p).tasks.map((t) => t.id).sort();
    expect(ids).toEqual([TODAY_TID, YESTERDAY_TID].sort());
    // the missed day is not deleted or rewritten: Review, streaks and the heatmap keep counting it as missed
    expect(rowById(p, YESTERDAY_TID)).toEqual(missedRow());
    expect(pageErrors(p)).toEqual([]);
  });

  it("the shared predicates: a past-day queued habit copy is missed, today's copy and an active one are open", () => {
    const p = load({ seedState: state([]) });
    const check = (t: Record<string, unknown>) =>
      pageJson(p, `[isMissedHabitTask(${JSON.stringify(t)}, ${JSON.stringify(TODAY)}), isOpenTask(${JSON.stringify(t)}, ${JSON.stringify(TODAY)})]`);
    expect(check(missedRow())).toEqual([true, false]);
    expect(check(missedRow({ status: "active" }))).toEqual([false, true]);
    expect(check(missedRow({ status: "completed", completedAt: NOW - DAY }))).toEqual([false, false]);
    expect(check(task(TODAY_TID, "Read", { habitId: HABIT_ID, scheduledDate: TODAY }))).toEqual([false, true]);
    // a habit copy without a day is never today's (isTaskVisibleToday hides it too): same rule as desktop
    expect(check(task("habtsk-x", "Read", { habitId: HABIT_ID }))).toEqual([true, false]);
    // ordinary tasks are untouched: overdue, unscheduled and future steps stay open
    expect(check(task("tsk-old", "Overdue", { scheduledDate: YESTERDAY }))).toEqual([false, true]);
    expect(check(task("tsk-free", "Unscheduled"))).toEqual([false, true]);
    expect(check(task("tsk-later", "Later", { scheduledDate: localKey(NOW + DAY) }))).toEqual([false, true]);
  });

  it("Quests: the quest card lists today's copy once and counts one open step", () => {
    const p = load({ seedState: state([missedRow()]) });
    p.switchView("quests");
    expect(cardIds(p).filter((id) => id.includes(HABIT_ID))).toEqual([TODAY_TID]);
    expect(p.document.body.textContent).toContain("Next Steps (1)");
    expect(pageErrors(p)).toEqual([]);
  });

  it("Quests: a habit copy whose focus is still running from yesterday stays listed", () => {
    const p = load({
      seedState: state([missedRow({ status: "active" })], {
        activeFocus: { activeTaskId: YESTERDAY_TID, isRunning: true, sessionStartedAt: NOW - 60_000, updatedAt: NOW - 60_000 },
      }),
    });
    p.switchView("quests");
    expect(cardIds(p).filter((id) => id.includes(HABIT_ID)).sort()).toEqual([TODAY_TID, YESTERDAY_TID].sort());
  });

  it("Home and Plan (today's column) show today's copy only", () => {
    const p = load({ seedState: state([missedRow()]) });
    p.switchView("command");
    expect(cardIds(p).filter((id) => id.includes(HABIT_ID))).toEqual([TODAY_TID]);
    p.switchView("plan");
    const todayCard = p.document.querySelector(`[aria-label*=", today, "]`);
    expect(todayCard?.getAttribute("aria-label")).toMatch(/, today, 1 open$/);
  });

  it("Plan: yesterday's column still lists its missed copy under its own day (history)", () => {
    const p = load({ seedState: state([missedRow()]) });
    p.switchView("plan");
    const labels = Array.from(p.document.querySelectorAll(".plan-day-card")).map((el) => el.getAttribute("aria-label") ?? "");
    expect(labels[1]).toMatch(/, 1 open$/); // the strip is day -2..+2: [1] is yesterday
    p.eval(`selectedPlanDateKey = ${JSON.stringify(YESTERDAY)}; renderApp();`);
    expect(cardIds(p).filter((id) => id.includes(HABIT_ID))).toEqual([YESTERDAY_TID]);
  });

  it("Plan: a dateless habit copy (no day of its own) is not open work in today's column (same as desktop)", () => {
    const dateless = task("habtsk-legacy", "Read 20 pages", { habitId: HABIT_ID, rank: -5000 });
    const p = load({ seedState: state([dateless]) });
    p.switchView("plan");
    const todayCard = p.document.querySelector(`[aria-label*=", today, "]`);
    expect(todayCard?.getAttribute("aria-label")).toMatch(/, today, 1 open$/); // today's dated copy only
    expect(cardIds(p).filter((id) => id.includes(HABIT_ID))).toEqual([TODAY_TID]);
    expect(rowById(p, "habtsk-legacy")).toEqual(dateless);
  });

  it("Move to top ranks against open tasks only (the missed copy's rank is ignored)", () => {
    const p = load({
      seedState: state([missedRow(), task("tsk-a", "Draft", { rank: 1000 }), task("tsk-b", "Ship", { rank: 2000 })]),
    });
    p.promoteTaskToTop("tsk-b");
    expect(rowById(p, "tsk-b").rank).toBe(0); // 1000 - 1000, not -5000 - 1000
    expect(rowById(p, YESTERDAY_TID)).toEqual(missedRow());
  });

  it("a new task added at the bottom ranks below the last open task, not the missed copy", () => {
    const p = load({ seedState: state([missedRow({ rank: 90_000 }), task("tsk-a", "Draft", { rank: 1000 })]) });
    p.openNewTaskSheet("quest-1");
    const title = p.document.getElementById("sheetTaskTitle");
    if (!(title instanceof p.HTMLInputElement || title instanceof p.HTMLTextAreaElement)) throw new Error("no title field");
    title.value = "Outline";
    p.eval("submitNewTaskFromSheet(false)");
    const added = readState(p).tasks.find((t) => t.title === "Outline");
    expect(added?.rank).toBe(2500); // today's habit copy (1500) is the last open task: 1500 + 1000
  });

  it("Guide: the clarity audit counts open tasks without the missed copy", () => {
    const p = load({ seedState: state([missedRow(), task("tsk-a", "Draft", { rank: 1000 })]) });
    const audit = pageJson(p, "auditGuideWorkspace()");
    expect(audit).toMatchObject({ openTaskCount: 2 }); // tsk-a + today's habit copy
  });

  it("Guide: a task added from the Guide ranks above the top open task, not the missed copy", () => {
    const p = load({ seedState: state([missedRow(), task("tsk-a", "Draft", { rank: 1000 })]) });
    p.eval(`guideTaskTitle = "Plan the launch"; saveGuideTask();`);
    const added = readState(p).tasks.find((t) => t.title === "Plan the launch");
    expect(added?.rank).toBe(0); // 1000 - 1000, not -5000 - 1000
  });

  it("Complete quest unlinks open steps only; the missed copy keeps its quest (history is not rewritten)", () => {
    const p = load({ seedState: state([missedRow(), task("tsk-a", "Draft", { rank: 1000 })]) });
    p.eval(`completeQuestItem("quest-1")`);
    expect(rowById(p, "tsk-a").questId).toBeNull();
    expect(rowById(p, TODAY_TID).questId).toBeNull();
    expect(rowById(p, YESTERDAY_TID)).toEqual(missedRow());
  });

  it("Focus with nothing open today never falls back to yesterday's missed copy", () => {
    const seeded = state([missedRow({ questId: null })], { habits: [] });
    const p = load({ seedState: seeded });
    p.initializeFocus(null);
    expect(readState(p).activeFocus.activeTaskId).toBeNull();
    expect(rowById(p, YESTERDAY_TID).status).toBe("queued");
  });
});
