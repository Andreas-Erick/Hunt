// Tasks, habits and quests accept an optional description when they are created.
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/db";
import { useCommandStore } from "@/store/useCommandStore";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { loadMobile, pageErrors, readState } from "./helpers/loadMobile";
import { makeQuest, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

// ---------------------------------------------------------------------------
// 3. Optional Description When Creating Task / Habit / Quest (Desktop & Mobile)
// ---------------------------------------------------------------------------
describe("Optional description on creation for Task, Habit, and Quest", () => {
  const EDGE_DESC = "Verify <img src=x onerror=alert(1)> & edge notes 👨‍👩‍👧‍👦";

  it("creates a Task with optional description on Home, omits blank descriptions, and rolls back on write failure", async () => {
    render(<CommandCenterView />);

    await waitFor(() => {
      expect(screen.queryByTestId("home-loading-skeleton")).toBeNull();
    });

    const titleInput = screen.getByPlaceholderText("Add quest work...") as HTMLInputElement;
    const descInput = screen.getByLabelText("Task description (optional)") as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: "Write architecture spec" } });
    fireEvent.change(descInput, { target: { value: EDGE_DESC } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(async () => {
      const tasks = await db.tasks.toArray();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Write architecture spec");
      expect(tasks[0].notes).toBe(EDGE_DESC);
    });

    expect(titleInput.value).toBe("");
    expect(descInput.value).toBe("");
    await waitFor(() => {
      expect(screen.getByText(EDGE_DESC)).toBeTruthy();
    });

    // Blank description saves empty string notes cleanly without whitespace
    fireEvent.change(titleInput, { target: { value: "Task without notes" } });
    fireEvent.change(descInput, { target: { value: "   " } });
    fireEvent.keyDown(descInput, { key: "Enter" });

    await waitFor(async () => {
      const second = (await db.tasks.toArray()).find((t) => t.title === "Task without notes");
      expect(second).toBeDefined();
      expect(second?.notes).toBe("");
    });

    // Write failure rolls back both title and description inputs
    useCommandStore.setState({
      createTask: vi.fn(async () => false),
    });
    fireEvent.change(titleInput, { target: { value: "Unsaved task" } });
    fireEvent.change(descInput, { target: { value: "Keep my draft on error" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(titleInput.value).toBe("Unsaved task");
      expect(descInput.value).toBe("Keep my draft on error");
    });
  });

  it("creates Tasks with optional descriptions from PlanWeekView and QuestMatrixPanel", async () => {
    await db.quests.add(makeQuest("q-desc", 0, "Deep Research", "sky", "Initial quest goal"));

    const { unmount } = render(<PlanWeekView />);
    const planDescInputs = await screen.findAllByPlaceholderText("Description (optional)...");
    expect(planDescInputs.length).toBeGreaterThanOrEqual(1);

    const firstDayDesc = planDescInputs[0] as HTMLInputElement;
    const dayBox = firstDayDesc.parentElement!.parentElement!;
    const firstDayTitle = dayBox.querySelector('input[placeholder="Add a task..."]') as HTMLInputElement;

    fireEvent.change(firstDayTitle, { target: { value: "Planned milestone" } });
    fireEvent.change(firstDayDesc, { target: { value: "Bring benchmark numbers" } });
    fireEvent.keyDown(firstDayDesc, { key: "Enter" });

    await waitFor(async () => {
      const planned = (await db.tasks.toArray()).find((t) => t.title === "Planned milestone");
      expect(planned?.notes).toBe("Bring benchmark numbers");
    });
    unmount();

    // QuestMatrixPanel: create a Quest with optional description + create a Task under a Quest with optional description
    render(<QuestMatrixPanel />);
    const newQuestBtn = await screen.findByRole("button", { name: /New Quest/i });
    fireEvent.click(newQuestBtn);

    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Fitness Block" } });
    fireEvent.change(screen.getByLabelText(/Description/i), { target: { value: "Zone 2 + strength" } });
    fireEvent.click(screen.getByRole("button", { name: "Rose" }));
    fireEvent.click(screen.getByRole("button", { name: /Create Quest/i }));

    await waitFor(async () => {
      const createdQuest = (await db.quests.toArray()).find((q) => q.title === "Fitness Block");
      expect(createdQuest).toBeDefined();
      expect(createdQuest?.description).toBe("Zone 2 + strength");
      expect(createdQuest?.accentColor).toBe("rose");
    });

    const questTaskTitle = screen.getByPlaceholderText("Add task to Deep Research...");
    const questTaskDesc = screen.getByLabelText("Task description for Deep Research (optional)");
    fireEvent.change(questTaskTitle, { target: { value: "Read paper section 4" } });
    fireEvent.change(questTaskDesc, { target: { value: "Focus on ablation table" } });
    fireEvent.keyDown(questTaskDesc, { key: "Enter" });

    await waitFor(async () => {
      const qTask = (await db.tasks.toArray()).find((t) => t.title === "Read paper section 4");
      expect(qTask?.notes).toBe("Focus on ablation table");
      expect(qTask?.questId).toBe("q-desc");
    });
  });

  it("creates a Habit with optional description on Desktop and materializes today's task with those notes", async () => {
    render(<HabitsView />);
    await waitFor(() => {
      expect(screen.queryByTestId("habits-loading-skeleton")).toBeNull();
    });

    const habitTitle = screen.getByLabelText("Add a daily habit");
    const habitDesc = screen.getByLabelText("Habit description (optional)");

    fireEvent.change(habitTitle, { target: { value: "Evening Mobility" } });
    fireEvent.change(habitDesc, { target: { value: "Hips, ankles, thoracic spine" } });
    fireEvent.submit(habitTitle.closest("form")!);

    await waitFor(async () => {
      const habits = await db.habits.toArray();
      expect(habits).toHaveLength(1);
      expect(habits[0].title).toBe("Evening Mobility");
      expect(habits[0].notes).toBe("Hips, ankles, thoracic spine");

      const tasks = await db.tasks.toArray();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].habitId).toBe(habits[0].id);
      expect(tasks[0].notes).toBe("Hips, ankles, thoracic spine");
    });
  });

  it("creates Tasks, Habits (including Ctrl+Enter), and Quests with optional descriptions on Mobile/Tablet", () => {
    const w = loadMobile();
    try {
      // 1. Mobile Task with optional description
      w.openNewTaskSheet(null);
      const tTitle = w.document.getElementById("sheetTaskTitle") as HTMLInputElement;
      const tNotes = w.document.getElementById("sheetTaskNotes") as HTMLTextAreaElement;
      expect(tNotes).not.toBeNull();
      tTitle.value = "Tablet Sketch";
      tNotes.value = EDGE_DESC;
      w.eval("submitNewTaskFromSheet(true)");

      let st = readState(w);
      const createdTask = st.tasks.find((t) => t.title === "Tablet Sketch");
      expect(createdTask?.notes).toBe(EDGE_DESC);
      expect(w.document.getElementById("mainContainer")?.textContent).toContain("Verify <img");
      expect(w.__pwned).toBeUndefined();

      // 2. Mobile Quest with optional description and new color ("lime")
      w.switchView("quests");
      w.openNewQuestSheet();
      const qTitle = w.document.getElementById("newQuestTitleInput") as HTMLInputElement;
      const qDesc = w.document.getElementById("newQuestDescInput") as HTMLTextAreaElement;
      qTitle.value = "Lime Sprint";
      qDesc.value = "Optional quest goal on tablet";
      w.eval("selectedQuestColor='lime'; createNewQuestFromSheet();");

      st = readState(w);
      const createdQuest = st.quests.find((q) => q.title === "Lime Sprint");
      expect(createdQuest?.description).toBe("Optional quest goal on tablet");
      expect(createdQuest?.accentColor).toBe("lime");

      // 3. Mobile Habit with optional description via Ctrl+Enter
      w.switchView("habits");
      w.eval("openNewHabitSheet()");
      const hTitle = w.document.getElementById("newHabitTitleInput") as HTMLInputElement;
      const hNotes = w.document.getElementById("newHabitNotesInput") as HTMLTextAreaElement;
      expect(hNotes.getAttribute("aria-label")).toBe("Habit description");
      hTitle.value = "Hydrate 500ml";
      hNotes.value = "Right after waking up";
      hNotes.dispatchEvent(
        new w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })
      );

      st = readState(w);
      const habits = (st.habits as Array<{ id: string; title: string; notes?: string }>) ?? [];
      const createdHabit = habits.find((h) => h.title === "Hydrate 500ml");
      expect(createdHabit?.notes).toBe("Right after waking up");
      const habitTask = st.tasks.find((t) => t.habitId === createdHabit?.id);
      expect(habitTask?.notes).toBe("Right after waking up");
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
