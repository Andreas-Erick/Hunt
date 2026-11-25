// Desktop text fields cap input at the lengths localStore keeps, so a long
// title or description is stopped while typing instead of cut silently on save.
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import type { Quest } from "@/lib/domainTypes";
import {
  MAX_HABIT_TITLE_LENGTH,
  MAX_LONG_TEXT_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
} from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { TaskComposer } from "@/components/TaskComposer";
import { PlanWeekView } from "@/components/PlanWeekView";

const QUEST: Quest = {
  id: "q1",
  slotIndex: 0,
  code: "LAUNCH",
  title: "Launch",
  description: "",
  accentColor: "cyan",
  targetWeeklyHours: 10,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(async () => {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  useCommandStore.setState({ activeTaskId: null, actionError: null, discardGuard: null });
});

const maxLengthOf = (el: HTMLElement) => (el as HTMLInputElement).maxLength;

describe("desktop text fields cap at the stored lengths", () => {
  it("Quests: the New Quest form, the edit drawer and a card's quick-add", async () => {
    await db.quests.put(QUEST);
    render(<QuestMatrixPanel />);

    fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
    const newForm = screen.getByRole("heading", { name: "Create New Quest" }).closest("form") as HTMLElement;
    expect(maxLengthOf(within(newForm).getByLabelText("Quest Title"))).toBe(MAX_QUEST_TITLE_LENGTH);
    expect(maxLengthOf(within(newForm).getByLabelText("Description"))).toBe(MAX_LONG_TEXT_LENGTH);

    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    const drawer = screen.getByRole("form", { name: "Edit quest Launch" });
    expect(maxLengthOf(within(drawer).getByLabelText("Quest Title"))).toBe(MAX_QUEST_TITLE_LENGTH);
    expect(maxLengthOf(within(drawer).getByLabelText("Description"))).toBe(MAX_LONG_TEXT_LENGTH);

    expect(maxLengthOf(screen.getByRole("textbox", { name: "Add quest work to Launch" }))).toBe(MAX_TASK_TITLE_LENGTH);
    expect(maxLengthOf(screen.getByRole("textbox", { name: "Task description for Launch (optional)" }))).toBe(
      MAX_LONG_TEXT_LENGTH
    );
  });

  it("Home: the task composer", () => {
    render(<TaskComposer questsLoaded activeQuests={[]} activeQuestMap={new Map()} />);
    expect(maxLengthOf(screen.getByRole("textbox", { name: "Add quest work" }))).toBe(MAX_TASK_TITLE_LENGTH);
    expect(maxLengthOf(screen.getByRole("textbox", { name: "Task description (optional)" }))).toBe(MAX_LONG_TEXT_LENGTH);
  });

  it("Habits: the quick-add box and the habit editor", async () => {
    await db.habits.put({ id: "h1", title: "Stretch", notes: "", questId: null, rank: 1000, createdAt: 1, updatedAt: 1 });
    render(<HabitsView />);
    expect(maxLengthOf(screen.getByRole("textbox", { name: "Add a daily habit" }))).toBe(MAX_HABIT_TITLE_LENGTH);
    expect(maxLengthOf(screen.getByRole("textbox", { name: "Habit description (optional)" }))).toBe(MAX_LONG_TEXT_LENGTH);

    const row = await screen.findByTestId("habit-row");
    fireEvent.click(within(row).getByRole("button", { name: "Edit habit Stretch" }));
    const form = within(row).getByRole("form", { name: "Edit habit Stretch" });
    expect(maxLengthOf(within(form).getByLabelText("Habit title"))).toBe(MAX_HABIT_TITLE_LENGTH);
    expect(maxLengthOf(within(form).getByLabelText("Default notes"))).toBe(MAX_LONG_TEXT_LENGTH);
  });

  it("Plan the Week: every day's add-task title and notes", async () => {
    const { container } = render(<PlanWeekView />);
    // Days still open for planning each show a title field and a notes field.
    await waitFor(() => expect(container.querySelectorAll('input[type="text"]').length).toBeGreaterThan(0));
    const caps = [...container.querySelectorAll<HTMLInputElement>('input[type="text"]')].map((el) => el.maxLength);
    const titles = caps.filter((c) => c === MAX_TASK_TITLE_LENGTH).length;
    expect(titles).toBeGreaterThan(0);
    expect(caps.filter((c) => c === MAX_LONG_TEXT_LENGTH)).toHaveLength(titles);
    expect(caps).toHaveLength(titles * 2);
  });
});
