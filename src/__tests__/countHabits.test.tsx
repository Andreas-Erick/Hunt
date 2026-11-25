// Count Habits on the desktop (GLOSSARY: Habit Kind, Count Habit): the Kind is chosen when the
// Habit is made and shown read-only after; the card's +1 taps add one, a long press types an
// exact total, and the card shows "n / target unit".
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId, toLocalDateKey } from "@/lib/dateUtils";
import type { Habit } from "@/lib/domainTypes";
import { localStore } from "@/lib/localStore";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

async function resetAll() {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: 0,
    lastCompletedFeedback: null,
    actionError: null,
  });
}

const JOG: Habit = {
  id: "hab-jog",
  title: "Jog",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  kind: "count",
  target: 3,
  unit: "miles",
};

const todayRow = () => db.tasks.get(habitTaskId(JOG.id, toLocalDateKey()));

describe("Count Habits — desktop", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetAll();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("chooses the Habit Kind when the Habit is made: Check by default, or Count with a target and unit", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    const kinds = screen.getByRole("radiogroup", { name: "Habit Kind" });
    expect(within(kinds).getByRole("radio", { name: "Check" })).toBeChecked();

    fireEvent.click(within(kinds).getByRole("radio", { name: "Count" }));
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "Jog" } });
    fireEvent.change(screen.getByLabelText("Daily target"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Unit"), { target: { value: "miles" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Habit" }));

    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("0 / 3 miles")).toBeInTheDocument();
    const [habit] = await db.habits.toArray();
    expect(habit).toMatchObject({ title: "Jog", kind: "count", target: 3, unit: "miles" });
  });

  it("will not make a Count Habit without a positive target", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    fireEvent.click(screen.getByRole("radio", { name: "Count" }));
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "Jog" } });
    fireEvent.change(screen.getByLabelText("Daily target"), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Add Habit" })).toBeDisabled();
  });

  it("stores a new Check Habit as Check", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "Stretch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Habit" }));
    await screen.findByTestId("habit-row");
    const [habit] = await db.habits.toArray();
    expect(habit.kind).toBe("check");
  });

  it("+1 adds one to today's total; reaching the target makes today Met and starts the Streak", async () => {
    await db.habits.put(JOG);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    const plus = within(row).getByRole("button", { name: "Add 1 to Jog" });

    fireEvent.click(plus);
    expect(await within(row).findByText("1 / 3 miles")).toBeInTheDocument();
    expect((await todayRow())?.status).toBe("queued");

    fireEvent.click(plus);
    fireEvent.click(plus);
    expect(await within(row).findByText("3 / 3 miles")).toBeInTheDocument();
    expect(await screen.findByText("1d streak")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument(); // done today

    fireEvent.click(plus); // going over is allowed and shown
    expect(await within(row).findByText("4 / 3 miles")).toBeInTheDocument();
  });

  it("a long press on +1 types an exact total, below the target too", async () => {
    await db.habits.put(JOG);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    const plus = within(row).getByRole("button", { name: "Add 1 to Jog" });

    vi.useFakeTimers();
    fireEvent.pointerDown(plus, { pointerType: "touch" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
    fireEvent.pointerUp(plus, { pointerType: "touch" });
    fireEvent.click(plus); // the click that ends a long press adds nothing
    vi.useRealTimers();

    const amount = within(row).getByLabelText("Today's total for Jog");
    fireEvent.change(amount, { target: { value: "2.5" } });
    fireEvent.submit(amount);
    expect(await within(row).findByText("2.5 / 3 miles")).toBeInTheDocument();
    expect((await todayRow())?.amount).toBe(2.5);
  });

  it("the progress text also opens exact entry, so it works without a long press", async () => {
    await db.habits.put(JOG);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    fireEvent.click(within(row).getByRole("button", { name: "Set today's total for Jog" }));
    const amount = within(row).getByLabelText("Today's total for Jog");
    fireEvent.change(amount, { target: { value: "5" } });
    fireEvent.submit(amount);
    expect(await within(row).findByText("5 / 3 miles")).toBeInTheDocument();
  });

  it("shows the Kind read-only when the Habit is edited", async () => {
    await db.habits.put(JOG);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    fireEvent.click(within(row).getByRole("button", { name: "Edit habit Jog" }));
    const form = screen.getByRole("form", { name: "Edit habit Jog" });
    expect(within(form).getByText("Count Habit")).toBeInTheDocument();
    expect(within(form).queryByRole("radio")).toBeNull();
  });

  it("ticking a Count Habit's day Task anywhere else (Home) adds one, and reopening clears the day", async () => {
    await db.habits.put(JOG);
    await localStore.materializeHabits(toLocalDateKey());
    const id = habitTaskId(JOG.id, toLocalDateKey());
    await localStore.completeTask(id);
    expect(await todayRow()).toMatchObject({ amount: 1, status: "queued" });
    await localStore.completeTask(id);
    await localStore.completeTask(id);
    expect(await todayRow()).toMatchObject({ amount: 3, status: "completed" });
    await localStore.reopenTask(id);
    await waitFor(async () => expect(await todayRow()).toMatchObject({ amount: 0, status: "queued" }));
  });
});
