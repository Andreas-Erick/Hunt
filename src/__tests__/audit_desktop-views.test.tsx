import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  db,
  QUEST_ACCENT_STYLES,
  dateKeyFromOffset,
  habitTaskId,
  toLocalDateKey,
  type Habit,
  type Quest,
  type Task,
} from "@/lib/db";
import {
  SETTLING_COMPLETED_CARD_CLASS,
  reopenDotBgClass,
} from "@/lib/taskCompletionMotion";
import { useCommandStore } from "@/store/useCommandStore";
import { useTransientHighlight } from "@/components/useTransientHighlight";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { FocusHudView } from "@/components/FocusHudView";

const T0 = 1_700_000_000_000;
const DISCARD_PROMPT = "Discard unsaved changes?";

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, requestSync: s.requestSync };
})();

function makeQuest(id: string, title: string, extra: Partial<Quest> = {}): Quest {
  return {
    id,
    slotIndex: 0,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeTask(
  id: string,
  title: string,
  questId: string | null,
  rank: number,
  extra: Partial<Task> = {}
): Task {
  return {
    id,
    title,
    notes: "",
    questId,
    status: "queued",
    rank,
    accumulatedSeconds: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeHabit(id: string, title: string, extra: Partial<Habit> = {}): Habit {
  return {
    id,
    title,
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

async function seed({
  quests = [],
  tasks = [],
  habits = [],
}: {
  quests?: Quest[];
  tasks?: Task[];
  habits?: Habit[];
}) {
  await db.quests.bulkAdd(quests);
  await db.tasks.bulkAdd(tasks);
  await db.habits.bulkAdd(habits);
}

const taskRow = (taskId: string, completed = false): HTMLElement => {
  const found = screen
    .getAllByTestId(completed ? "completed-task-row" : "task-row")
    .find((r) => r.dataset.taskId === taskId);
  if (!found) throw new Error(`No row for ${taskId}`);
  return found;
};

beforeEach(async () => {
  await Promise.all([
    db.quests.clear(),
    db.tasks.clear(),
    db.timeLogs.clear(),
    db.habits.clear(),
  ]);
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
    syncNow: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  useCommandStore.setState({
    ...realActions,
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// P03-03: one hook owns the highlight state, its timer and the unmount cleanup.
describe("useTransientHighlight", () => {
  it("highlights for the duration, restarts on a new flash and never clears a newer id", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientHighlight(650));
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]("a"));
    expect(result.current[0]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(649);
    });
    expect(result.current[0]).toBe("a");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current[0]).toBeNull();

    act(() => result.current[1]("a"));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => result.current[1]("b"));
    // a's timer was replaced: 400 + 300 ms later "b" is still highlighted.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current[0]).toBe("b");
    act(() => {
      vi.advanceTimersByTime(350);
    });
    expect(result.current[0]).toBeNull();
  });

  it("clears the pending timer on unmount", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTransientHighlight(700));
    act(() => result.current[1]("q"));
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// P13-01: the dimmed Reopen dot of the slate "Other" accent meets 3:1.
describe("reopenDotBgClass", () => {
  it("lifts only the slate accent to slate-400", () => {
    expect(reopenDotBgClass(QUEST_ACCENT_STYLES.slate)).toBe("bg-slate-400");
    expect(reopenDotBgClass(QUEST_ACCENT_STYLES.cyan)).toBe(
      QUEST_ACCENT_STYLES.cyan.bg
    );
    expect(reopenDotBgClass(QUEST_ACCENT_STYLES.purple)).toBe(
      QUEST_ACCENT_STYLES.purple.bg
    );
  });
});

describe("Home (CommandCenterView)", () => {
  // P07-03
  it("with no active quest, the empty queue points to Quests instead of 'add above'", async () => {
    await seed({ quests: [makeQuest("q-done", "Shipped", { archived: true })] });
    render(<CommandCenterView />);
    expect(
      await screen.findByText(
        "No active quests. Create a quest to give your most important work a home."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/Add your most important work above/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Go to Quests" }));
    expect(useCommandStore.getState().activeView).toBe("quests");
  });

  it("with an active quest and nothing queued, keeps the 'add above' copy and no Quests button", async () => {
    await seed({ quests: [makeQuest("q-0", "Launch")] });
    render(<CommandCenterView />);
    expect(
      await screen.findByText(
        "No quest tasks queued. Add your most important work above."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to Quests" })).toBeNull();
  });

  // P10-03
  it("Escape in the notes drawer returns focus to the row's notes toggle", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [
        makeTask("tsk-a", "Alpha", "q-0", 1000),
        makeTask("tsk-b", "Bravo", "q-0", 2000),
      ],
    });
    render(<CommandCenterView />);
    await screen.findByRole("button", { name: "Bravo" });

    // Open Alpha's drawer, then switch to Bravo's: the ref follows the open one.
    fireEvent.click(within(taskRow("tsk-a")).getByTitle("Task notes & options"));
    const bravoToggle = within(taskRow("tsk-b")).getByTitle("Task notes & options");
    fireEvent.click(bravoToggle);
    const notes = await screen.findByLabelText("Notes for Bravo");
    notes.focus();
    fireEvent.keyDown(notes, { key: "Escape" });

    expect(screen.queryByLabelText("Notes for Bravo")).toBeNull();
    expect(bravoToggle).toHaveFocus();
    expect(bravoToggle).toHaveAttribute("aria-expanded", "false");
  });

  // P16-02
  it("queue rows show grab cursors and their title announces the Alt+Arrow shortcut", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [makeTask("tsk-a", "Alpha", "q-0", 1000)],
    });
    render(<CommandCenterView />);
    const title = await screen.findByRole("button", { name: "Alpha" });
    expect(title).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    expect(taskRow("tsk-a")).toHaveClass("cursor-grab", "active:cursor-grabbing");

    // The notes drawer sits inside the row: it resets the inherited grab
    // cursor so the notes field keeps its text cursor.
    fireEvent.click(within(taskRow("tsk-a")).getByTitle("Task notes & options"));
    const notes = await screen.findByLabelText("Notes for Alpha");
    expect(notes.parentElement).toHaveClass("cursor-auto");
  });

  // P13-01, P11-04, P14-01
  it("resting complete rings use the 3:1 border, the h1 has display leading and the week bar animates a transform", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [
        makeTask("tsk-a", "Alpha", "q-0", 1000),
        makeTask("tsk-o", "Chore", null, 2000),
        makeTask("tsk-d", "Done chore", null, 3000, {
          status: "completed",
          completedAt: T0,
        }),
      ],
    });
    render(<CommandCenterView />);
    await screen.findByRole("button", { name: "Chore" });

    for (const id of ["tsk-a", "tsk-o"]) {
      const ring = within(taskRow(id)).getByRole("button", { name: "Mark complete" });
      expect(ring).toHaveClass("border-white/40");
      expect(ring.className).not.toMatch(/(^|\s)border-white\/(20|25)(\s|$)/);
    }

    // Completed Other work: slate-400 Reopen dot, still dimmed to opacity-65.
    const reopen = within(taskRow("tsk-d", true)).getByRole("button", {
      name: "Reopen task",
    });
    expect(reopen).toHaveClass("bg-slate-400", "opacity-65");
    expect(reopen).not.toHaveClass("bg-slate-500");

    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");

    const fill = screen.getByTestId("week-progress-fill");
    expect(fill).toHaveClass("w-full", "transition-transform", "duration-300");
    expect(fill.className).not.toMatch(/transition-all|duration-500/);
    expect(fill.style.width).toBe("");
    expect(fill.style.transform).toBe("translateX(-100%)");
  });

  // P12-06
  it("a settling completed card uses the shared settle surface", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [makeTask("tsk-a", "Alpha", "q-0", 1000)],
    });
    render(<CommandCenterView />);
    await screen.findByRole("button", { name: "Alpha" });
    fireEvent.click(
      within(taskRow("tsk-a")).getByRole("button", { name: "Mark complete" })
    );
    await waitFor(() =>
      expect(taskRow("tsk-a", true).className).toContain(
        SETTLING_COMPLETED_CARD_CLASS
      )
    );
  });
});

describe("Plan the week (PlanWeekView)", () => {
  const dayColumn = (dateKey: string): HTMLElement => {
    const found = screen
      .getAllByTestId("day-column")
      .find((c) => c.dataset.dateKey === dateKey);
    if (!found) throw new Error(`No column ${dateKey}`);
    return found;
  };
  const titlesIn = (col: HTMLElement, completed: boolean) =>
    within(col)
      .queryAllByTestId("task-row")
      .filter((r) => (r.dataset.completedRow === "true") === completed)
      .map((r) => r.dataset.taskId);

  // P19-02: one grouped index per render, same columns as before.
  it("puts each task in its day column, split and ordered by rank", async () => {
    const todayKey = toLocalDateKey();
    const tomorrowKey = dateKeyFromOffset(todayKey, 1);
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [
        makeTask("t-late", "Late", "q-0", 3000, { scheduledDate: todayKey }),
        makeTask("t-unsched", "Unscheduled", null, 1000),
        makeTask("t-done", "Done today", null, 500, {
          scheduledDate: todayKey,
          status: "completed",
          completedAt: T0,
        }),
        makeTask("t-arch", "Archived", null, 10, {
          scheduledDate: todayKey,
          status: "archived",
        }),
        makeTask("t-tom-b", "Tomorrow B", "q-0", 2000, { scheduledDate: tomorrowKey }),
        makeTask("t-tom-a", "Tomorrow A", "q-0", 2000, {
          scheduledDate: tomorrowKey,
          status: "active",
        }),
      ],
    });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Tomorrow A" });

    const today = dayColumn(todayKey);
    expect(titlesIn(today, false)).toEqual(["t-unsched", "t-late"]);
    expect(titlesIn(today, true)).toEqual(["t-done"]);
    expect(within(today).queryByText("Archived")).toBeNull();
    // Equal ranks fall back to id order.
    expect(titlesIn(dayColumn(tomorrowKey), false)).toEqual(["t-tom-a", "t-tom-b"]);
    expect(
      screen.getByText("Alt+Shift+←/→ moves a task to the previous or next day")
    ).toBeInTheDocument();
  });

  it("hides the reschedule hint when no visible day has open work", async () => {
    await seed({
      tasks: [
        makeTask("t-far", "Far away", null, 1000, {
          scheduledDate: dateKeyFromOffset(toLocalDateKey(), 30),
        }),
        makeTask("t-done", "Done", null, 1000, { status: "completed", completedAt: T0 }),
      ],
    });
    render(<PlanWeekView />);
    await screen.findByText("Done");
    expect(screen.queryByText(/Alt\+Shift\+←\/→ moves a task/)).toBeNull();
  });

  // P12-04, P16-02, P13-01, P11-04, P12-03, P12-06
  it("selector, cards, rings, Reopen dot, heading and settle surface follow the spec", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch")],
      tasks: [
        makeTask("t-a", "Alpha", "q-0", 1000, { accumulatedSeconds: 90 }),
        makeTask("t-d", "Done chore", null, 2000, {
          status: "completed",
          completedAt: T0,
        }),
      ],
    });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });

    const selector = screen.getByRole("group", { name: "Quest for new tasks" });
    expect(selector).toHaveClass("gap-1", "p-1", "rounded-2xl", "sm:rounded-full");
    expect(selector).not.toHaveClass("gap-1.5");

    const card = taskRow("t-a");
    expect(card).toHaveClass("cursor-grab", "active:cursor-grabbing");
    expect(within(card).getByRole("button", { name: "Mark complete" })).toHaveClass(
      "border-white/40"
    );
    expect(
      within(card).getByRole("button", { name: "Delete task" }).parentElement
    ).toHaveClass("gap-2");

    const done = screen
      .getAllByTestId("task-row")
      .find((r) => r.dataset.taskId === "t-d");
    expect(
      within(done as HTMLElement).getByRole("button", { name: "Reopen task" })
    ).toHaveClass("bg-slate-400", "opacity-65");

    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");

    fireEvent.click(within(card).getByRole("button", { name: "Mark complete" }));
    await waitFor(() => {
      const settled = screen
        .getAllByTestId("task-row")
        .find((r) => r.dataset.taskId === "t-a" && r.dataset.completedRow === "true");
      expect(settled?.className).toContain(SETTLING_COMPLETED_CARD_CLASS);
    });
  });
});

describe("Quests (QuestMatrixPanel)", () => {
  // P19-01: grouped once per tasks change, same card contents as before.
  it("each card lists only its open tasks in rank order, with the right count", async () => {
    await seed({
      quests: [makeQuest("q-0", "Launch"), makeQuest("q-1", "Write", { slotIndex: 1 })],
      tasks: [
        makeTask("t-2", "Second", "q-0", 2000),
        makeTask("t-1", "First", "q-0", 1000, { status: "active" }),
        makeTask("t-done", "Finished", "q-0", 500, {
          status: "completed",
          completedAt: T0,
        }),
        makeTask("t-other", "Chore", null, 100),
        makeTask("t-w", "Draft", "q-1", 100),
      ],
    });
    render(<QuestMatrixPanel />);
    await screen.findByText("Draft");

    const card = (questId: string): HTMLElement => {
      const found = screen
        .getAllByTestId("quest-card")
        .find((c) => c.dataset.questId === questId);
      if (!found) throw new Error(`No quest card ${questId}`);
      return found;
    };
    const launch = card("q-0");
    const first = within(launch).getByText("First");
    const second = within(launch).getByText("Second");
    expect(
      first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(within(launch).queryByText("Finished")).toBeNull();
    expect(within(launch).queryByText("Chore")).toBeNull();
    expect(within(launch).getByText(/\(2\)/)).toBeInTheDocument();
    expect(within(card("q-1")).getByText(/\(1\)/)).toBeInTheDocument();
    expect(within(card("q-1")).queryByText("First")).toBeNull();
  });

  // P12-03, P14-01, P11-04
  it("Complete and Edit sit 8px apart, the hours bar animates a transform and the h1 has display leading", async () => {
    await seed({ quests: [makeQuest("q-0", "Launch")] });
    render(<QuestMatrixPanel />);
    const complete = await screen.findByRole("button", {
      name: "Complete quest Launch",
    });
    expect(complete.parentElement).toHaveClass("gap-2");
    expect(complete.parentElement).not.toHaveClass("gap-1.5");

    const fill = screen.getByTestId("quest-progress-fill");
    expect(fill).toHaveClass("w-full", "transition-transform", "duration-300");
    expect(fill.className).not.toMatch(/transition-all|duration-500/);
    expect(fill.style.width).toBe("");
    expect(fill.style.transform).toBe("translateX(-100%)");

    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");
  });
});

describe("Daily habits (HabitsView)", () => {
  // P05-03 / P19-04: the indexed habitId read returns exactly the habit tasks.
  it("reads habit tasks through the habitId index and ignores regular tasks", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    const habit = makeHabit("hab-1", "Stretch");
    await seed({
      habits: [habit],
      tasks: [
        makeTask(habitTaskId("hab-1", yesterdayKey), "Stretch", null, 1000, {
          habitId: "hab-1",
          scheduledDate: yesterdayKey,
          status: "completed",
          completedAt: T0,
        }),
        makeTask(habitTaskId("hab-1", todayKey), "Stretch", null, 1000, {
          habitId: "hab-1",
          scheduledDate: todayKey,
          status: "completed",
          completedAt: T0,
        }),
        // Same day, completed, but not a habit task: must not count.
        makeTask("t-regular", "Regular", null, 1000, {
          scheduledDate: todayKey,
          status: "completed",
          completedAt: T0,
        }),
      ],
    });
    const where = vi.spyOn(db.tasks, "where");
    const filter = vi.spyOn(db.tasks, "filter");
    render(<HabitsView />);
    expect(await screen.findByText("2d streak")).toBeInTheDocument();
    expect(screen.getByText("1 / 1")).toBeInTheDocument();
    expect(where).toHaveBeenCalledWith("habitId");
    expect(filter).not.toHaveBeenCalled();
  });

  // P09-03: the habit editor's dirty guard.
  it("asks before discarding an edited habit; declining keeps the edits, accepting closes", async () => {
    await seed({ habits: [makeHabit("hab-1", "Stretch")] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<HabitsView />);
    const toggle = await screen.findByRole("button", { name: "Edit habit Stretch" });

    // A pristine drawer closes without a prompt.
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Habit Title")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("Habit Title"), {
      target: { value: "Stretch 10m" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
    expect(screen.getByLabelText("Habit Title")).toHaveValue("Stretch 10m");

    fireEvent.keyDown(screen.getByLabelText("Habit Title"), { key: "Escape" });
    fireEvent.click(toggle);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("Habit Title")).toHaveValue("Stretch 10m");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Habit Title")).toBeNull();
    expect(toggle).toHaveFocus();
    expect((await db.habits.get("hab-1"))?.title).toBe("Stretch");
  });

  // P13-01, P12-03, P11-04
  it("the resting ring meets 3:1, the delete trigger has extra clearance and the h1 has display leading", async () => {
    await seed({ habits: [makeHabit("hab-1", "Stretch")] });
    render(<HabitsView />);
    const ring = await screen.findByRole("button", {
      name: "Complete today's habit: Stretch",
    });
    expect(ring).toHaveClass("border-white/40");

    const del = screen.getByRole("button", { name: "Delete habit Stretch" });
    expect(del).toHaveClass("ml-1");
    expect(del.parentElement).toHaveClass("gap-2");

    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");
  });
});

// P10-04 (desktop)
describe("Focus (FocusHudView)", () => {
  it("the session notes field shows the cyan focus border", async () => {
    await seed({
      tasks: [makeTask("tsk-a", "Alpha", null, 1000, { notes: "Context" })],
    });
    useCommandStore.setState({ activeTaskId: "tsk-a" });
    render(<FocusHudView />);
    const notes = await screen.findByLabelText("Session notes");
    expect(notes).toHaveClass("focus:border-hud-cyan");
    expect(notes).not.toHaveClass("focus:border-white/20");
  });
});
