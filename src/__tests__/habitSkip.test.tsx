// Skip a habit day (#18): the shared row rule both apps write, and the desktop Habits card's
// Skip / Undo skip control. A Skipped day leaves Today, keeps the Streak, and is un-Skipped in place.
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { completeTaskRow, pickNextFocusTask, skipHabitDayRow } from "@/mobile/huntCore";
import { db } from "@/lib/db";
import { habitTaskId, isOpenTask, isTaskVisibleToday, toLocalDateKey } from "@/lib/dateUtils";
import type { Task } from "@/lib/domainTypes";
import { createEmptySyncPayload, mergeSyncPayloads } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

const DAY = "2026-11-22";

function dayTask(overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h1", DAY),
    title: "Stretch",
    notes: "",
    questId: null,
    habitId: "h1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: DAY,
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

describe("skipHabitDayRow (shared Skip rule)", () => {
  it("sets the day aside and stamps it newer, without touching the input row", () => {
    const before = dayTask();
    const skipped = skipHabitDayRow(before, true, 9_000);
    expect(skipped).toEqual({ ...before, skipped: true, updatedAt: 9_000 });
    expect(before.skipped).toBeUndefined();
    expect(isOpenTask(skipped, DAY)).toBe(false);
  });

  it("un-Skips the day back to an open day, stamped newer than a clock that runs ahead", () => {
    const back = skipHabitDayRow(dayTask({ skipped: true, updatedAt: 20_000 }), false, 9_000);
    expect(back.skipped).toBeUndefined();
    expect(back.updatedAt).toBe(20_001);
    expect(isOpenTask(back, DAY)).toBe(true);
  });

  it("keeps a Skipped day out of today's queue and the focus picker", () => {
    const skipped = skipHabitDayRow(dayTask(), true, 9_000);
    expect(isTaskVisibleToday(skipped, DAY)).toBe(false);
    expect(pickNextFocusTask([skipped], DAY)).toBeNull();
    expect(pickNextFocusTask([dayTask()], DAY)?.id).toBe(dayTask().id);
  });

  it("ticking a Skipped day makes it Met and drops the Skip", () => {
    const done = completeTaskRow(dayTask({ skipped: true }), 9_000);
    expect(done.status).toBe("completed");
    expect(done.skipped).toBeUndefined();
  });
});

describe("Skipped state syncs under row-level last-write-wins", () => {
  const payload = (task: Task) => ({ ...createEmptySyncPayload(), tasks: [task] });
  const mergedTask = (a: Task, b: Task) => mergeSyncPayloads(payload(a), payload(b)).tasks[0];

  it("a later Skip wins over the older ordinary day, from either side", () => {
    const plain = dayTask({ updatedAt: 500 });
    const skipped = skipHabitDayRow(plain, true, 600);
    expect(mergedTask(plain, skipped).skipped).toBe(true);
    expect(mergedTask(skipped, plain).skipped).toBe(true);
  });

  it("a later un-Skip wins over the older Skip, from either side", () => {
    const skipped = dayTask({ skipped: true, updatedAt: 500 });
    const back = skipHabitDayRow(skipped, false, 600);
    expect(mergedTask(skipped, back).skipped).toBeUndefined();
    expect(mergedTask(back, skipped).skipped).toBeUndefined();
  });
});

describe("desktop Habits card: Skip today and Undo skip", () => {
  beforeEach(async () => {
    await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
    window.localStorage.clear();
    useCommandStore.setState({ activeView: "command", activeTaskId: null, actionError: null });
  });

  it("writes the same row as the shared rule, so phone and desktop Skips sync alike", async () => {
    const before = dayTask({ updatedAt: 1 });
    await db.tasks.put(before);
    const at = Date.now();
    await useCommandStore.getState().setHabitDaySkipped("h1", DAY, true);
    const after = await db.tasks.get(before.id);
    expect(after).toEqual({ ...skipHabitDayRow(before, true, at), updatedAt: after?.updatedAt });
    expect(after?.updatedAt).toBeGreaterThanOrEqual(at);
    await useCommandStore.getState().setHabitDaySkipped("h1", DAY, false);
    expect(await db.tasks.get(before.id)).not.toHaveProperty("skipped");
  });

  it("skips today's day, shows it Skipped, and undoes the Skip", async () => {
    const todayKey = toLocalDateKey();
    await db.habits.put({ id: "h1", title: "Stretch", notes: "", questId: null, rank: 1000, createdAt: 1, updatedAt: 1 });
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    const tid = habitTaskId("h1", todayKey);

    fireEvent.click(await within(row).findByRole("button", { name: "Skip today: Stretch" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.skipped).toBe(true));
    expect(await within(row).findByText("Skipped today")).toBeInTheDocument();
    // A Skipped Habit does not count toward today's total.
    expect(screen.getByText("0 / 0")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Undo skip: Stretch" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.skipped).toBeUndefined());
    expect(await within(row).findByRole("button", { name: "Skip today: Stretch" })).toBeInTheDocument();
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
  });
});
