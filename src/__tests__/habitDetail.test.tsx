// Habit detail, Calendar tab (#25), desktop: opening a Habit shows its month of Outcomes and its
// notes; a past day can be ticked, unticked or Skipped from the grid with the shared row rule.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Task } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

const NOW = new Date(2026, 10, 18, 10, 0).getTime();

function dayTask(dayKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h1", dayKey),
    title: "Stretch",
    notes: "",
    questId: null,
    habitId: "h1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dayKey,
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

async function openDetail() {
  render(<HabitsView />);
  const row = await screen.findByTestId("habit-row");
  fireEvent.click(within(row).getByRole("button", { name: "Open habit: Stretch" }));
  return screen.findByRole("dialog", { name: "Stretch" });
}

describe("desktop Habit detail: Calendar tab", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
    window.localStorage.clear();
    useCommandStore.setState({ activeView: "habits", activeTaskId: null, actionError: null });
    await db.habits.put({
      id: "h1",
      title: "Stretch",
      notes: "Ten minutes after waking up",
      questId: null,
      rank: 1000,
      createdAt: new Date(2026, 9, 20, 8).getTime(),
      updatedAt: 1,
    });
  });
  afterEach(() => vi.useRealTimers());

  it("shows the month of Outcomes and the Habit's notes under a Calendar tab", async () => {
    await db.tasks.bulkPut([
      dayTask("2026-11-10", { status: "completed", completedAt: NOW - 8 * 86_400_000 }),
      dayTask("2026-11-11", { skipped: true }),
    ]);
    const dialog = await openDetail();
    expect(within(dialog).getByRole("tab", { name: "Calendar", selected: true })).toBeInTheDocument();
    expect(within(dialog).getByText("November 2026")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "10 November: Met" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "11 November: Skipped" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "12 November: Missed" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "18 November: Open" })).toBeInTheDocument();
    expect(within(dialog).getByText("19", { selector: "[aria-label='19 November: no Outcome']" })).toBeInTheDocument();
    expect(within(dialog).getByText("Ten minutes after waking up")).toBeInTheDocument();
  });

  it("moves between months, back to the month the Habit began and no later than today's", async () => {
    const dialog = await openDetail();
    expect(within(dialog).getByRole("button", { name: "Next month" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Previous month" }));
    expect(await within(dialog).findByText("October 2026")).toBeInTheDocument();
    // Before the Habit began (20 Oct) a day has no Outcome.
    expect(within(dialog).getByText("19", { selector: "[aria-label='19 October: no Outcome']" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "20 October: Missed" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Previous month" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Next month" }));
    expect(within(dialog).getByText("November 2026")).toBeInTheDocument();
  });

  it("ticks a Missed past day, unticks it, and Skips it, writing the day's Task", async () => {
    const dialog = await openDetail();
    const tid = habitTaskId("h1", "2026-11-12");
    fireEvent.click(within(dialog).getByRole("button", { name: "12 November: Missed" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Tick 12 November" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.status).toBe("completed"));
    expect(await within(dialog).findByRole("button", { name: "12 November: Met" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Untick 12 November" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.status).toBe("queued"));

    fireEvent.click(await within(dialog).findByRole("button", { name: "Skip 12 November" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.skipped).toBe(true));
    expect(await within(dialog).findByRole("button", { name: "12 November: Skipped" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo skip 12 November" }));
    await waitFor(async () => expect((await db.tasks.get(tid))?.skipped).toBeUndefined());
  });

  it("shows an unscheduled day as no Outcome, with nothing to correct", async () => {
    await db.habits.update("h1", {
      frequencyHistory: [{ effectiveFrom: "2026-10-20", frequency: { type: "weekdays", weekdays: [1] } }],
    });
    const dialog = await openDetail();
    // 12 November 2026 is a Thursday; 16 November a Monday.
    expect(within(dialog).getByText("12", { selector: "[aria-label='12 November: no Outcome']" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^12 November/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "16 November: Missed" })).toBeInTheDocument();
  });

  it("on a Count Habit, Tick sets the day's total to the target, Untick clears it, and the day takes an exact total", async () => {
    await db.habits.update("h1", { kind: "count", target: 3, unit: "sets" });
    await db.tasks.put(dayTask("2026-11-12", { amount: 1 }));
    const dialog = await openDetail();
    const tid = habitTaskId("h1", "2026-11-12");
    fireEvent.click(within(dialog).getByRole("button", { name: "12 November: Missed" }));
    expect(within(dialog).getByText("1 / 3 sets")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Tick 12 November" }));
    await waitFor(async () => expect(await db.tasks.get(tid)).toMatchObject({ amount: 3, status: "completed" }));

    fireEvent.click(await within(dialog).findByRole("button", { name: "Untick 12 November" }));
    await waitFor(async () => expect(await db.tasks.get(tid)).toMatchObject({ amount: 0, status: "queued" }));

    const field = await within(dialog).findByRole("textbox", { name: "Total for 12 November" });
    fireEvent.change(field, { target: { value: "4.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Set total" }));
    await waitFor(async () => expect(await db.tasks.get(tid)).toMatchObject({ amount: 4.5, status: "completed" }));
    expect(await within(dialog).findByRole("button", { name: "12 November: Met" })).toBeInTheDocument();
  });

  it("on an N per week Habit, Skip sets the whole Habit Week aside and Undo skip on another day of it brings it back", async () => {
    await db.habits.update("h1", {
      frequencyHistory: [{ effectiveFrom: "2026-10-20", frequency: { type: "perWeek", times: 3 } }],
    });
    const dialog = await openDetail();
    // Week of Mon 9 - Sun 15 November 2026.
    fireEvent.click(within(dialog).getByRole("button", { name: /^10 November: / }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip 10 November" }));
    await waitFor(async () => expect((await db.tasks.get(habitTaskId("h1", "2026-11-10")))?.skipped).toBe(true));
    expect(await within(dialog).findByRole("button", { name: "13 November: Skipped" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "9 November: Skipped" })).toBeInTheDocument();
    expect(within(dialog).getByText("Habit Week: Skipped")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "13 November: Skipped" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo skip 13 November" }));
    await waitFor(async () => expect((await db.tasks.get(habitTaskId("h1", "2026-11-10")))?.skipped).toBeUndefined());
    expect(await within(dialog).findByRole("button", { name: /^10 November: (?!Skipped)/ })).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const dialog = await openDetail();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
