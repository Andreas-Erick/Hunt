import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit, HabitFrequency } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

// Desktop Frequency: day Tasks only for scheduled days, the editor offers
// every day / chosen weekdays, and a change applies from today.

// Monday 11 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 11, 10).getTime();
const MONDAY = "2026-05-11";
const TUESDAY = "2026-05-12";
const TUE_THU: HabitFrequency = { type: "weekdays", weekdays: [2, 4] };

async function resetAll() {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
}

async function onlyHabit(): Promise<Habit> {
  const habits = await db.habits.toArray();
  expect(habits).toHaveLength(1);
  return habits[0];
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("desktop store: Frequency", () => {
  it("creates a chosen-weekdays Habit without a day Task on an unscheduled day", async () => {
    const store = useCommandStore.getState();
    expect(await store.createHabit({ title: "Gym", questId: null, frequency: TUE_THU })).toBe(true);
    const habit = await onlyHabit();
    expect(habit.frequencyHistory).toEqual([{ effectiveFrom: MONDAY, frequency: TUE_THU }]);
    expect(await db.tasks.count()).toBe(0);

    expect(await store.materializeDailyHabits(MONDAY)).toBe(0);
    expect(await store.materializeDailyHabits(TUESDAY)).toBe(1);
    expect(await db.tasks.get(habitTaskId(habit.id, TUESDAY))).toBeDefined();
  });

  it("creates an every-day Habit as before, with no Frequency history", async () => {
    await useCommandStore.getState().createHabit({ title: "Read", questId: null });
    const habit = await onlyHabit();
    expect(habit.frequencyHistory).toBeUndefined();
    expect(await db.tasks.get(habitTaskId(habit.id, MONDAY))).toMatchObject({ status: "queued" });
  });

  it("applies a Frequency change from today: today's untouched day Task leaves Today and comes back", async () => {
    const store = useCommandStore.getState();
    await store.createHabit({ title: "Read", questId: null });
    const habit = await onlyHabit();
    const todayId = habitTaskId(habit.id, MONDAY);

    expect(await store.updateHabit(habit.id, { frequency: TUE_THU })).toBe(true);
    expect((await db.habits.get(habit.id))?.frequencyHistory).toEqual([
      { effectiveFrom: MONDAY, frequency: TUE_THU },
    ]);
    expect((await db.tasks.get(todayId))?.status).toBe("archived");

    expect(await store.updateHabit(habit.id, { frequency: { type: "everyDay" } })).toBe(true);
    expect((await db.habits.get(habit.id))?.frequencyHistory).toEqual([]);
    expect((await db.tasks.get(todayId))?.status).toBe("queued");
  });

  it("leaves today's ticked day Task alone when today is no longer scheduled", async () => {
    const store = useCommandStore.getState();
    await store.createHabit({ title: "Read", questId: null });
    const habit = await onlyHabit();
    const todayId = habitTaskId(habit.id, MONDAY);
    await store.completeTaskById(todayId);
    await store.updateHabit(habit.id, { frequency: TUE_THU });
    expect((await db.tasks.get(todayId))?.status).toBe("completed");
  });
});

describe("desktop Habits view: Frequency", () => {
  it("adds a Habit for chosen weekdays and shows its Frequency and that today is not scheduled", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "Gym" } });

    const picker = screen.getByRole("group", { name: "Frequency for new habit" });
    fireEvent.click(within(picker).getByRole("button", { name: "Chosen days" }));
    const addBtn = screen.getByRole("button", { name: "Add Habit" });
    expect(addBtn).toBeDisabled(); // no weekday chosen yet
    fireEvent.click(within(picker).getByRole("button", { name: "Tuesday" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Thursday" }));
    expect(within(picker).getByRole("button", { name: "Tuesday" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(addBtn);

    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("Tue, Thu")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Not scheduled today: Gym" })).toBeDisabled();
    expect(within(row).queryByRole("button", { name: "Start focus: Gym" })).toBeNull();
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
    expect((await onlyHabit()).frequencyHistory).toEqual([{ effectiveFrom: MONDAY, frequency: TUE_THU }]);
  });

  it("changes a Habit's Frequency in the editor", async () => {
    await useCommandStore.getState().createHabit({ title: "Read", questId: null });
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("Every day")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Edit habit Read" }));
    const picker = within(row).getByRole("group", { name: "Habit frequency" });
    expect(within(picker).getByRole("button", { name: "Every day" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(picker).getByRole("button", { name: "Chosen days" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Tuesday" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(within(row).getByText("Tue")).toBeInTheDocument());
    const habit = await onlyHabit();
    expect(habit.frequencyHistory).toEqual([
      { effectiveFrom: MONDAY, frequency: { type: "weekdays", weekdays: [2] } },
    ]);
  });
});

describe("desktop Habits view: completing keeps the row's layout", () => {
  it("swaps Start focus for an invisible slot of the same size, and back on reopen", async () => {
    await useCommandStore.getState().createHabit({ title: "Read", questId: null });
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByRole("button", { name: "Start focus: Read" })).toBeInTheDocument();
    expect(within(row).queryByTestId("focus-slot")).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Complete today's habit: Read" }));
    await within(row).findByRole("button", { name: "Reopen today's habit: Read" });
    expect(within(row).queryByRole("button", { name: "Start focus: Read" })).toBeNull();
    const slot = within(row).getByTestId("focus-slot");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot.className).toContain("h-9 w-9");

    fireEvent.click(within(row).getByRole("button", { name: "Reopen today's habit: Read" }));
    await within(row).findByRole("button", { name: "Start focus: Read" });
    expect(within(row).queryByTestId("focus-slot")).toBeNull();
  });
});
