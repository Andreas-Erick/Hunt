// Habit detail, Statistics tab (#26), desktop: the Habit Score with its one-line explanation; a Count
// Habit adds a month bar chart of daily amounts (under target marked apart) and yearly totals.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, Task } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

const NOW = new Date(2026, 10, 18, 10, 0).getTime();

function dayTask(dayKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId("h1", dayKey),
    title: "Run",
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

async function openStatistics() {
  render(<HabitsView />);
  const row = await screen.findByTestId("habit-row");
  fireEvent.click(within(row).getByRole("button", { name: "Open habit: Run" }));
  const dialog = await screen.findByRole("dialog", { name: "Run" });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Statistics" }));
  return dialog;
}

async function seedHabit(extra: Partial<Habit>) {
  await db.habits.put({
    id: "h1",
    title: "Run",
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: new Date(2026, 9, 30, 8).getTime(),
    updatedAt: 1,
    ...extra,
  });
}

describe("desktop Habit detail: Statistics tab", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
    window.localStorage.clear();
    useCommandStore.setState({ activeView: "habits", activeTaskId: null, actionError: null });
  });
  afterEach(() => vi.useRealTimers());

  it("leads with the Habit Score and a one-line explanation", async () => {
    await seedHabit({ createdAt: new Date(2026, 10, 15, 8).getTime() });
    await db.tasks.bulkPut(
      ["2026-11-15", "2026-11-16", "2026-11-17"].map((k) => dayTask(k, { status: "completed", completedAt: NOW }))
    );
    const dialog = await openStatistics();
    expect(within(dialog).getByRole("tab", { name: "Statistics", selected: true })).toBeInTheDocument();
    const panel = within(dialog).getByRole("tabpanel", { name: "Statistics" });
    expect(within(panel).getByText("Habit Score")).toBeInTheDocument();
    expect(within(panel).getByText("100")).toBeInTheDocument();
    expect(within(panel).getByText(/Recent results count most/)).toBeInTheDocument();
    // A Check Habit has no amounts to chart.
    expect(within(panel).queryByRole("list", { name: /Daily amounts/ })).toBeNull();
  });

  it("shows no score before any day was Met or Missed", async () => {
    await seedHabit({ createdAt: NOW });
    const panel = within(await openStatistics()).getByRole("tabpanel", { name: "Statistics" });
    expect(within(panel).getByText("No score yet")).toBeInTheDocument();
  });

  it("charts a Count Habit's daily amounts for the month, under-target days marked apart, with month navigation", async () => {
    await seedHabit({ kind: "count", target: 3, unit: "miles" });
    await db.tasks.bulkPut([
      dayTask("2026-10-31", { amount: 6, status: "completed", completedAt: NOW }),
      dayTask("2026-11-02", { amount: 4, status: "completed", completedAt: NOW }),
      dayTask("2026-11-03", { amount: 1.5 }),
    ]);
    const panel = within(await openStatistics()).getByRole("tabpanel", { name: "Statistics" });
    const chart = within(panel).getByRole("list", { name: "Daily amounts, November 2026" });
    expect(within(chart).getByLabelText("2 November: 4 miles, target reached")).toBeInTheDocument();
    expect(within(chart).getByLabelText("3 November: 1.5 miles, under target")).toBeInTheDocument();
    expect(within(chart).getByLabelText("4 November: 0 miles, under target")).toBeInTheDocument();
    expect(within(chart).queryByLabelText(/^19 November/)).toBeNull();
    expect(within(panel).getByRole("button", { name: "Next month" })).toBeDisabled();
    fireEvent.click(within(panel).getByRole("button", { name: "Previous month" }));
    const october = within(panel).getByRole("list", { name: "Daily amounts, October 2026" });
    expect(within(october).getByLabelText("31 October: 6 miles, target reached")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Previous month" })).toBeDisabled();
  });

  it("shows a Count Habit's totals per month of the year, with year navigation", async () => {
    await seedHabit({ kind: "count", target: 3, unit: "miles", createdAt: new Date(2025, 11, 30, 8).getTime() });
    await db.tasks.bulkPut([
      dayTask("2025-12-31", { amount: 7, status: "completed", completedAt: NOW }),
      dayTask("2026-10-31", { amount: 6, status: "completed", completedAt: NOW }),
      dayTask("2026-11-02", { amount: 4.5, status: "completed", completedAt: NOW }),
    ]);
    const panel = within(await openStatistics()).getByRole("tabpanel", { name: "Statistics" });
    const table = within(panel).getByRole("table", { name: "Totals per month, 2026" });
    expect(within(table).getByRole("row", { name: "October 6 miles" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "November 4.5 miles" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "December —" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "Year 10.5 miles" })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Previous year" }));
    const last = within(panel).getByRole("table", { name: "Totals per month, 2025" });
    expect(within(last).getByRole("row", { name: "December 7 miles" })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Previous year" })).toBeDisabled();
  });
});
