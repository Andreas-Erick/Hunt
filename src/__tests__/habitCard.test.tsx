import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, Task } from "@/lib/domainTypes";
import { HabitsView } from "@/components/HabitsView";

// Desktop Habit card: Frequency label, a week strip whose days are told apart by
// shape and name (not colour alone), the Streak and the Success Rate.

// Monday 11 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 11, 10).getTime();
const BEGAN = new Date(2026, 4, 5, 9).getTime(); // Tue 5 May

const HABIT: Habit = {
  id: "hab-gym",
  title: "Gym",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: BEGAN,
  // Every day but Friday.
  frequencyHistory: [{ effectiveFrom: "2026-05-05", frequency: { type: "weekdays", weekdays: [0, 1, 2, 3, 4, 6] } }],
};

function dayTask(dateKey: string, overrides: Partial<Task> = {}): Task {
  return {
    id: habitTaskId(HABIT.id, dateKey),
    title: HABIT.title,
    notes: "",
    questId: null,
    habitId: HABIT.id,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: BEGAN,
    updatedAt: BEGAN,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("desktop Habit card", () => {
  it("shows the Frequency, a week strip of named Outcomes, the Streak and the Success Rate", async () => {
    await db.habits.put(HABIT);
    await db.tasks.bulkPut([
      dayTask("2026-05-05", { status: "completed" }),
      // Wed 6: no day Task, Missed.
      dayTask("2026-05-07", { skipped: true }),
      // Fri 8: not scheduled.
      dayTask("2026-05-09", { status: "completed" }),
      dayTask("2026-05-10", { status: "completed" }),
      dayTask("2026-05-11"),
    ]);
    render(<HabitsView />);
    const row = (await screen.findAllByTestId("habit-row"))[0];

    expect(within(row).getByText("Mon, Tue, Wed, Thu, Sat, Sun")).toBeInTheDocument();

    const strip = await within(row).findByRole("list", { name: "Last 7 days" });
    const days = within(strip).getAllByRole("listitem");
    expect(days.map((d) => d.getAttribute("aria-label"))).toEqual([
      "Tue 5: Met",
      "Wed 6: Missed",
      "Thu 7: Skipped",
      "Fri 8: Not scheduled",
      "Sat 9: Met",
      "Sun 10: Met",
      "Mon 11 (today): Open",
    ]);
    // Each state has its own shape, not only its own colour.
    const shapes = days.map((d) => d.getAttribute("data-outcome"));
    expect(shapes).toEqual(["met", "missed", "skipped", "none", "met", "met", "open"]);
    expect(within(days[0]).getByTestId("strip-glyph-met")).toBeInTheDocument();
    expect(within(days[1]).getByTestId("strip-glyph-missed")).toBeInTheDocument();

    // Streak: Sat + Sun Met, today Open and Skipped Thu passed over; Wed Missed ends it.
    expect(within(row).getByText("2d streak")).toBeInTheDocument();
    // Success Rate: Met 3 (Tue, Sat, Sun) of Met + Missed 4 (Wed).
    expect(within(row).getByLabelText("Success Rate 75%")).toHaveTextContent("75%");
  });

  it("shows no Success Rate before any day was Met or Missed", async () => {
    await db.habits.put({ ...HABIT, createdAt: NOW, frequencyHistory: undefined });
    render(<HabitsView />);
    const row = (await screen.findAllByTestId("habit-row"))[0];
    await within(row).findByRole("list", { name: "Last 7 days" });
    expect(within(row).queryByLabelText(/^Success Rate/)).toBeNull();
  });
});
