import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId } from "@/lib/dateUtils";
import type { Habit } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

// Desktop Ended Habits: an end date can be set, moved and cleared; an Ended Habit leaves Today and
// the Habits list for a collapsed "Ended" section that keeps its history; deleting removes it all.

// Wednesday 20 May 2026, 10:00 local.
const NOW = new Date(2026, 4, 20, 10).getTime();
const TODAY = "2026-05-20";

async function resetAll() {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
}

async function onlyHabit(): Promise<Habit> {
  const habits = await db.habits.toArray();
  expect(habits).toHaveLength(1);
  return habits[0];
}

async function seedHabit(extra: Partial<Habit> = {}): Promise<Habit> {
  const habit: Habit = {
    id: "hab-1763400000000-aaaa",
    title: "Stretch",
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: new Date(2026, 4, 1, 9).getTime(),
    updatedAt: 1,
    ...extra,
  };
  await db.habits.put(habit);
  return habit;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  await resetAll();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("desktop store: end date", () => {
  it("ending a Habit yesterday sets today's untouched day Task aside; clearing it restarts without the gap", async () => {
    const store = useCommandStore.getState();
    await store.createHabit({ title: "Read", questId: null });
    const habit = await onlyHabit();
    const todayId = habitTaskId(habit.id, TODAY);

    expect(await store.updateHabit(habit.id, { endDate: "2026-05-19" })).toBe(true);
    expect((await db.habits.get(habit.id))?.endDate).toBe("2026-05-19");
    expect((await db.tasks.get(todayId))?.status).toBe("archived");
    expect(await store.materializeDailyHabits(TODAY)).toBe(0);

    vi.setSystemTime(new Date(2026, 4, 25, 10).getTime());
    expect(await store.updateHabit(habit.id, { endDate: null })).toBe(true);
    const restarted = await db.habits.get(habit.id);
    expect(restarted?.endDate).toBeUndefined();
    expect(restarted?.endedSpans).toEqual([{ from: "2026-05-20", to: "2026-05-24" }]);
    expect(await db.tasks.get(habitTaskId(habit.id, "2026-05-25"))).toMatchObject({ status: "queued" });
  });

  it("writes nothing for an end date that is not a date", async () => {
    const habit = await seedHabit();
    await useCommandStore.getState().updateHabit(habit.id, { title: "Yoga", endDate: "soon" });
    expect(await db.habits.get(habit.id)).toMatchObject({ title: "Stretch", updatedAt: 1 });
    expect((await db.habits.get(habit.id))?.endDate).toBeUndefined();
  });
});

describe("desktop Habits view: Ended section", () => {
  it("sets an end date from the editor", async () => {
    const habit = await seedHabit();
    render(<HabitsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit habit Stretch" }));
    const form = await screen.findByRole("form", { name: "Edit habit Stretch" });
    fireEvent.change(within(form).getByLabelText("End date"), { target: { value: "2026-05-31" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await db.habits.get(habit.id))?.endDate).toBe("2026-05-31"));
  });

  it("clears the end date from the editor", async () => {
    const habit = await seedHabit({ endDate: "2026-05-31" });
    render(<HabitsView />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit habit Stretch" }));
    const form = await screen.findByRole("form", { name: "Edit habit Stretch" });
    expect(within(form).getByLabelText("End date")).toHaveValue("2026-05-31");
    fireEvent.click(within(form).getByRole("button", { name: "Clear end date" }));
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await db.habits.get(habit.id))?.endDate).toBeUndefined());
  });

  it("lists an Ended Habit only in the collapsed Ended section, with its history", async () => {
    await seedHabit({ endDate: "2026-05-15" });
    await db.tasks.put({
      id: habitTaskId("hab-1763400000000-aaaa", "2026-05-15"),
      title: "Stretch",
      notes: "",
      questId: null,
      habitId: "hab-1763400000000-aaaa",
      status: "completed",
      completedAt: 1,
      rank: 1000,
      accumulatedSeconds: 0,
      scheduledDate: "2026-05-15",
      createdAt: 1,
      updatedAt: 1,
    });
    render(<HabitsView />);
    const toggle = await screen.findByRole("button", { name: /Ended \(1\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByTestId("habit-row")).toHaveLength(0);
    expect(screen.queryByText("Stretch")).toBeNull();

    fireEvent.click(toggle);
    const card = await screen.findByTestId("ended-habit-row");
    expect(card).toHaveTextContent("Stretch");
    expect(card).toHaveTextContent("Ended 15 May");
    expect(card).toHaveTextContent("1d streak");
    // The week strip ends on the end date (not today), and the Success Rate shows.
    expect(within(card).getByLabelText("Fri 15: Met")).toBeInTheDocument();
    expect(within(card).getByLabelText(/^Success Rate \d+%$/)).toBeInTheDocument();
  });

  it("restarts an Ended Habit back into the list", async () => {
    const habit = await seedHabit({ endDate: "2026-05-15" });
    render(<HabitsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Ended \(1\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Restart habit Stretch" }));
    await waitFor(async () => expect((await db.habits.get(habit.id))?.endDate).toBeUndefined());
    expect((await db.habits.get(habit.id))?.endedSpans).toEqual([{ from: "2026-05-16", to: "2026-05-19" }]);
    expect(await screen.findByTestId("habit-row")).toHaveTextContent("Stretch");
  });

  it("moves an Ended Habit's end date", async () => {
    const habit = await seedHabit({ endDate: "2026-05-15" });
    render(<HabitsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Ended \(1\)/ }));
    const card = await screen.findByTestId("ended-habit-row");
    fireEvent.change(within(card).getByLabelText("End date of Stretch"), { target: { value: "2026-05-17" } });
    fireEvent.click(within(card).getByRole("button", { name: "Move end date of Stretch" }));
    await waitFor(async () => expect((await db.habits.get(habit.id))?.endDate).toBe("2026-05-17"));
  });

  it("deletes an Ended Habit and everything with it", async () => {
    const habit = await seedHabit({ endDate: "2026-05-15" });
    render(<HabitsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Ended \(1\)/ }));
    const del = await screen.findByRole("button", { name: "Delete habit Stretch" });
    fireEvent.click(del);
    fireEvent.click(await screen.findByRole("button", { name: "Delete habit?" }));
    await waitFor(async () => expect(await db.habits.get(habit.id)).toBeUndefined());
  });
});
