// Avoid Habits on the desktop (GLOSSARY: Avoid Habit, Slip): chosen as a Habit Kind when the Habit
// is made; its card reads "Kept so far" until a Slip is logged, and a Slip can be undone.
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import { habitTaskId, toLocalDateKey } from "@/lib/dateUtils";
import type { Habit, Quest } from "@/lib/domainTypes";
import { localStore } from "@/lib/localStore";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";
import { TaskRow } from "@/components/TaskRow";
import { PlanWeekView } from "@/components/PlanWeekView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";

async function resetAll() {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
  useCommandStore.setState({ activeView: "command", activeTaskId: null, isRunning: false, actionError: null });
}

const DRY: Habit = {
  id: "hab-dry",
  title: "No alcohol",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  kind: "avoid",
};

const todayRow = () => db.tasks.get(habitTaskId(DRY.id, toLocalDateKey()));

describe("Avoid Habits — desktop", () => {
  beforeEach(resetAll);

  it("offers Avoid as a Habit Kind when the Habit is made", async () => {
    render(<HabitsView />);
    await screen.findByText(/No daily habits yet/);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Habit Kind" })).getByRole("radio", { name: "Avoid" }));
    fireEvent.change(screen.getByLabelText("Add a daily habit"), { target: { value: "No alcohol" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Habit" }));

    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("Kept so far")).toBeInTheDocument();
    const [habit] = await db.habits.toArray();
    expect(habit).toMatchObject({ title: "No alcohol", kind: "avoid" });
  });

  it("logs a Slip, which makes today Missed, and undoes it", async () => {
    await db.habits.put(DRY);
    render(<HabitsView />);
    const row = await screen.findByTestId("habit-row");
    expect(within(row).queryByRole("button", { name: /Start focus/ })).toBeNull();

    fireEvent.click(within(row).getByRole("button", { name: "Log a Slip on No alcohol" }));
    await waitFor(async () => expect((await todayRow())?.slips).toBe(1));
    expect(await within(row).findByText("1 Slip")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Undo Slip on No alcohol" }));
    await waitFor(async () => expect((await todayRow())?.slips).toBeUndefined());
    expect(await within(row).findByText("Kept so far")).toBeInTheDocument();
  });

  it("a tick from any list on an Avoid day logs a Slip; reopening clears it", async () => {
    await db.habits.put(DRY);
    await localStore.materializeHabits(toLocalDateKey());
    const id = habitTaskId(DRY.id, toLocalDateKey());
    await localStore.completeTask(id);
    expect(await db.tasks.get(id)).toMatchObject({ slips: 1, status: "queued" });
    await localStore.reopenTask(id);
    expect((await db.tasks.get(id))?.slips).toBeUndefined();
  });

  it("an Avoid day in Today reads Kept so far, and its tick is a labelled Slip button with no focus", async () => {
    await db.habits.put(DRY);
    await localStore.materializeHabits(toLocalDateKey());
    const task = (await todayRow())!;
    const onComplete = vi.fn();
    render(<TaskRow variant="maintenance" task={task} isCompleting={false} onComplete={onComplete} />);
    const slip = await screen.findByRole("button", { name: "Log a Slip on No alcohol" });
    expect(screen.getByText("Kept so far")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Start focus/ })).toBeNull();
    fireEvent.click(slip);
    expect(onComplete).toHaveBeenCalledWith(task.id);
  });

  it.each([
    ["Plan the Week", () => <PlanWeekView />],
    ["the Quest panel", () => <QuestMatrixPanel />],
  ])("an Avoid day in %s reads Kept so far with a labelled Log a Slip button, not a tick", async (_name, view) => {
    const quest: Quest = {
      id: "qst-calm",
      slotIndex: 0,
      code: "Q-1",
      title: "Stay calm",
      description: "",
      accentColor: "cyan",
      targetWeeklyHours: 1,
      archived: false,
      createdAt: 1,
    };
    await db.quests.put(quest);
    await db.habits.put({ ...DRY, questId: "qst-calm" });
    await localStore.materializeHabits(toLocalDateKey());
    render(view());
    const slip = await screen.findByRole("button", { name: "Log a Slip on No alcohol" });
    const row = slip.closest("[data-task-id]") as HTMLElement;
    expect(within(row).getByText("Kept so far")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Mark complete" })).toBeNull();
    fireEvent.click(slip);
    await waitFor(async () => expect((await todayRow())?.slips).toBe(1));
  });
});
