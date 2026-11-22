import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, act, within } from "@testing-library/react";
import { db } from "@/lib/db";
import {
  dateKeyFromOffset,
  habitTaskId,
  isMissedHabitTask,
  isOpenTask,
  toLocalDateKey,
} from "@/lib/dateUtils";
import type { Habit, Quest, Task } from "@/lib/domainTypes";
import { auditWorkspace } from "@/lib/questScience";
import { pickNextFocusTask, useCommandStore } from "@/store/useCommandStore";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";

/**
 * User report: "if a user doesn't do a daily habit in one day, that habit
 * appears twice the next day". Yesterday's still-queued habit instance is a
 * missed day (history), never an open task on a later day.
 */

const T0 = 1_700_000_000_000;
const HABIT_TITLE = "Read 20 pages";

const realActions = (() => {
  const s = useCommandStore.getState();
  return {
    syncNow: s.syncNow,
    requestSync: s.requestSync,
    initializeFocus: s.initializeFocus,
    completeQuest: s.completeQuest,
    materializeDailyHabits: s.materializeDailyHabits,
  };
})();

function makeQuest(id: string, title: string): Quest {
  return {
    id,
    slotIndex: 0,
    code: title.slice(0, 6).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 5,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeHabit(id: string, questId: string | null): Habit {
  return {
    id,
    title: HABIT_TITLE,
    notes: "",
    questId,
    rank: 1000,
    createdAt: T0,
    updatedAt: T0,
  };
}

function habitTask(habit: Habit, dateKey: string, extra: Partial<Task> = {}): Task {
  return {
    id: habitTaskId(habit.id, dateKey),
    title: habit.title,
    notes: "",
    questId: habit.questId,
    habitId: habit.id,
    status: "queued",
    rank: habit.rank,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function regularTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    notes: "",
    questId: null,
    status: "queued",
    rank: 2000,
    accumulatedSeconds: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

beforeEach(async () => {
  await Promise.all([
    db.quests.clear(),
    db.tasks.clear(),
    db.timeLogs.clear(),
    db.habits.clear(),
  ]);
  window.localStorage.clear();
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: 0,
    lastCompletedFeedback: null,
    actionError: null,
    syncNow: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  useCommandStore.setState({
    ...realActions,
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
  });
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("missed daily habit: pure predicates", () => {
  const today = "2026-11-21";
  const yesterday = "2026-11-20";
  const tomorrow = "2026-11-22";

  it("a queued habit instance from a past day is missed; today's, active, or completed ones are not", () => {
    const h = { habitId: "hab-1" } as const;
    expect(isMissedHabitTask({ ...h, status: "queued", scheduledDate: yesterday }, today)).toBe(true);
    expect(isMissedHabitTask({ ...h, status: "queued", scheduledDate: "2025-01-01" }, today)).toBe(true);
    expect(isMissedHabitTask({ ...h, status: "queued", scheduledDate: undefined }, today)).toBe(true);
    expect(isMissedHabitTask({ ...h, status: "queued", scheduledDate: today }, today)).toBe(false);
    expect(isMissedHabitTask({ ...h, status: "queued", scheduledDate: tomorrow }, today)).toBe(false);
    // Focus still running across midnight on yesterday's habit: still open.
    expect(isMissedHabitTask({ ...h, status: "active", scheduledDate: yesterday }, today)).toBe(false);
    expect(isMissedHabitTask({ ...h, status: "completed", scheduledDate: yesterday }, today)).toBe(false);
    // Regular tasks are never "missed" (overdue ones roll over).
    expect(isMissedHabitTask({ status: "queued", scheduledDate: yesterday }, today)).toBe(false);
  });

  it("isOpenTask = queued/active minus missed habit days", () => {
    const h = { habitId: "hab-1" } as const;
    expect(isOpenTask({ ...h, status: "queued", scheduledDate: today }, today)).toBe(true);
    expect(isOpenTask({ ...h, status: "active", scheduledDate: yesterday }, today)).toBe(true);
    expect(isOpenTask({ ...h, status: "queued", scheduledDate: yesterday }, today)).toBe(false);
    expect(isOpenTask({ ...h, status: "completed", scheduledDate: today }, today)).toBe(false);
    expect(isOpenTask({ status: "queued", scheduledDate: yesterday }, today)).toBe(true);
    expect(isOpenTask({ status: "queued", scheduledDate: tomorrow }, today)).toBe(true);
    expect(isOpenTask({ status: "active" }, today)).toBe(true);
    expect(isOpenTask({ status: "archived" }, today)).toBe(false);
  });

  it("auditWorkspace (Guide Lab) does not count a missed habit day as an open task", () => {
    const habit = makeHabit("hab-1", null);
    const audit = auditWorkspace(
      [],
      [habitTask(habit, yesterday), habitTask(habit, today)],
      today
    );
    expect(audit.openTaskCount).toBe(1);
    expect(audit.otherTaskCount).toBe(1);
  });
});

describe("missed daily habit: desktop views and actions", () => {
  it("Quests view lists the habit once (today's instance) and counts it once", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const quest = makeQuest("q-1", "Writing");
    const habit = makeHabit("hab-1", quest.id);
    const missed = habitTask(habit, yesterdayKey);
    await db.quests.add(quest);
    await db.habits.add(habit);
    await db.tasks.bulkAdd([missed, habitTask(habit, todayKey)]);

    render(<QuestMatrixPanel />);
    const card = await screen.findByTestId("quest-card");
    await waitFor(() => expect(within(card).getByText("Next Steps (1)")).toBeInTheDocument());
    const rows = card.querySelectorAll("[data-task-id]");
    expect(Array.from(rows, (r) => r.getAttribute("data-task-id"))).toEqual([
      habitTaskId(habit.id, todayKey),
    ]);

    // History row stays untouched.
    expect(await db.tasks.get(missed.id)).toEqual(missed);
  });

  it("Quests view keeps yesterday's habit visible while its focus is still running", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const quest = makeQuest("q-1", "Writing");
    const habit = makeHabit("hab-1", quest.id);
    await db.quests.add(quest);
    await db.habits.add(habit);
    await db.tasks.bulkAdd([
      habitTask(habit, yesterdayKey, { status: "active" }),
      habitTask(habit, todayKey),
    ]);

    render(<QuestMatrixPanel />);
    const card = await screen.findByTestId("quest-card");
    await waitFor(() => expect(within(card).getByText("Next Steps (2)")).toBeInTheDocument());
  });

  it("Home shows the habit once after a missed day", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const habit = makeHabit("hab-1", null);
    await db.habits.add(habit);
    await db.tasks.add(habitTask(habit, yesterdayKey));

    render(<CommandCenterView />);
    // Home materializes today's instance; yesterday's stays hidden.
    await waitFor(async () =>
      expect(await db.tasks.get(habitTaskId(habit.id, todayKey))).toBeDefined()
    );
    await waitFor(() => expect(screen.getAllByText(HABIT_TITLE)).toHaveLength(1));
    expect((await db.tasks.get(habitTaskId(habit.id, yesterdayKey)))?.status).toBe("queued");
  });

  it("Focus picker never offers a missed habit day", () => {
    const todayKey = "2026-11-21";
    const habit = makeHabit("hab-1", null);
    expect(pickNextFocusTask([habitTask(habit, "2026-11-20")], todayKey)).toBeNull();
  });

  it("starting focus with nothing for today does not pick a missed habit day", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const tomorrowKey = dateKeyFromOffset(todayKey, 1);
    const habit = makeHabit("hab-1", null);
    // Lower rank than the future task, so a plain rank fallback would pick it.
    const missed = habitTask(habit, yesterdayKey, { rank: 1 });
    const future = regularTask("tsk-future", "Plan trip", { scheduledDate: tomorrowKey });
    await db.tasks.bulkAdd([missed, future]);

    await act(async () => {
      await useCommandStore.getState().initializeFocus();
    });
    expect(useCommandStore.getState().activeTaskId).toBe(future.id);
    expect(await db.tasks.get(missed.id)).toEqual(missed);
  });

  it("starting focus with only a missed habit day starts nothing", async () => {
    const todayKey = toLocalDateKey();
    const habit = makeHabit("hab-1", null);
    const missed = habitTask(habit, dateKeyFromOffset(todayKey, -1));
    await db.tasks.add(missed);

    await act(async () => {
      await useCommandStore.getState().initializeFocus();
    });
    expect(useCommandStore.getState().activeTaskId).toBeNull();
    expect(await db.tasks.get(missed.id)).toEqual(missed);
  });

  it("completing a quest moves open tasks to Other work but leaves missed habit days as history", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const quest = makeQuest("q-1", "Writing");
    const habit = makeHabit("hab-1", quest.id);
    const missed = habitTask(habit, yesterdayKey);
    const todays = habitTask(habit, todayKey);
    await db.quests.add(quest);
    await db.habits.add(habit);
    await db.tasks.bulkAdd([missed, todays]);

    await act(async () => {
      await useCommandStore.getState().completeQuest(quest.id);
    });
    expect(await db.tasks.get(missed.id)).toEqual(missed);
    expect((await db.tasks.get(todays.id))?.questId).toBeNull();
  });

  it("Plan the week keeps a missed day in its own column and never as open work for today", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const habit = makeHabit("hab-1", null);
    const missed = habitTask(habit, yesterdayKey);
    // A synced habit row may arrive without a date: it is no day's instance.
    const dateless: Task = { ...habitTask(habit, todayKey), id: "habtsk-dateless", scheduledDate: undefined };
    const todays = habitTask(habit, todayKey);
    await db.habits.add(habit);
    await db.tasks.bulkAdd([missed, dateless, todays]);

    render(<PlanWeekView />);
    const idsIn = (dateKey: string) =>
      Array.from(
        document.querySelectorAll(`[data-testid='task-row'][data-date-key='${dateKey}']`),
        (r) => r.getAttribute("data-task-id")
      );
    await waitFor(() => expect(idsIn(todayKey)).toEqual([todays.id]));
    expect(idsIn(yesterdayKey)).toEqual([missed.id]);
    expect(await db.tasks.get(dateless.id)).toEqual(dateless);
  });
});
