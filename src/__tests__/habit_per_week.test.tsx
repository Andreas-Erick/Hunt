import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, HabitFrequency, Task } from "@/lib/domainTypes";
import { buildHabitTaskRow } from "@/lib/taskQueue";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

// Desktop N times per week: the editor offers it, Today keeps the Habit until N
// are Met that Habit Week, Skip sets the whole week aside, and the Streak reads "3w".

// Wednesday 13 May 2026, 10:00 local; the Habit Week began Monday 11 May.
const NOW = new Date(2026, 4, 13, 10).getTime();
const TODAY = "2026-05-13";
const TWICE: HabitFrequency = { type: "perWeek", times: 2 };

const gym = (frequency: HabitFrequency = TWICE): Habit => ({
  id: "h1",
  title: "Gym",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1,
  updatedAt: 1,
  frequencyHistory: [{ effectiveFrom: "2026-04-20", frequency }],
});
const ticked = (habit: Habit, day: string): Task => ({ ...buildHabitTaskRow(habit, day), status: "completed", completedAt: 2 });

async function onlyHabit(): Promise<Habit> {
  const habits = await db.habits.toArray();
  expect(habits).toHaveLength(1);
  return habits[0];
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

describe("desktop store: N times per week", () => {
  it("builds today's day Task until N are Met that Habit Week, then no more", async () => {
    const habit = gym();
    await db.habits.put(habit);
    await db.tasks.put(ticked(habit, "2026-05-11"));
    const store = useCommandStore.getState();
    expect(await store.materializeDailyHabits(TODAY)).toBe(1);
    await db.tasks.delete(habitTaskId("h1", TODAY));
    await db.tasks.put(ticked(habit, "2026-05-12"));
    expect(await store.materializeDailyHabits(TODAY)).toBe(0);
    expect(await store.materializeDailyHabits("2026-05-18")).toBe(1); // a new Habit Week asks again
  });

  it("sets the whole Habit Week aside and undoes it", async () => {
    const habit = gym();
    await db.habits.put(habit);
    await db.tasks.put({ ...buildHabitTaskRow(habit, "2026-05-11"), skipped: true });
    const store = useCommandStore.getState();
    expect(await store.materializeDailyHabits(TODAY)).toBe(0); // the week is Skipped
    await store.setHabitDaySkipped("h1", TODAY, false);
    expect(await db.tasks.get(habitTaskId("h1", "2026-05-11"))).not.toHaveProperty("skipped");
    expect(await store.materializeDailyHabits(TODAY)).toBe(1);
  });
});

describe("desktop Habits view: N times per week", () => {
  it("adds a Habit asked 3 times a week", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "Gym" } });
    const picker = screen.getByRole("group", { name: "Frequency for new habit" });
    fireEvent.click(within(picker).getByRole("button", { name: "Times a week" }));
    fireEvent.click(within(picker).getByRole("button", { name: "3 times a week" }));
    expect(within(picker).getByRole("button", { name: "3 times a week" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Add Habit" }));

    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("3 times a week")).toBeInTheDocument();
    expect(within(row).getByText("0 / 3 this week")).toBeInTheDocument();
    expect((await onlyHabit()).frequencyHistory).toEqual([
      { effectiveFrom: TODAY, frequency: { type: "perWeek", times: 3 } },
    ]);
    expect(await db.tasks.get(habitTaskId((await onlyHabit()).id, TODAY))).toMatchObject({ status: "queued" });
  });

  it("shows the week's progress, hides today once N are Met, and reads the Streak in weeks", async () => {
    const habit = gym();
    await db.habits.put(habit);
    await db.tasks.bulkPut([
      ticked(habit, "2026-04-27"),
      ticked(habit, "2026-04-29"),
      ticked(habit, "2026-05-04"),
      ticked(habit, "2026-05-08"),
      ticked(habit, "2026-05-11"),
      ticked(habit, "2026-05-12"),
    ]);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    expect(await within(row).findByText("2 / 2 this week")).toBeInTheDocument();
    expect(within(row).getByText("3w streak")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Not asked again this week: Gym" })).toBeDisabled();
    expect(within(row).queryByRole("button", { name: "Skip this week: Gym" })).toBeNull();
  });

  it("skips this week from the card and undoes it", async () => {
    await db.habits.put(gym());
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    fireEvent.click(await within(row).findByRole("button", { name: "Skip this week: Gym" }));
    await waitFor(async () => expect((await db.tasks.get(habitTaskId("h1", TODAY)))?.skipped).toBe(true));
    expect(await within(row).findByText("Skipped this week")).toBeInTheDocument();
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Undo skip: Gym" }));
    await waitFor(async () => expect((await db.tasks.get(habitTaskId("h1", TODAY)))?.skipped).toBeUndefined());
    expect(await within(row).findByRole("button", { name: "Skip this week: Gym" })).toBeInTheDocument();
  });
});
