import React from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import {
  db,
  dateFromKey,
  dateKeyFromOffset,
  toLocalDateKey,
  type Quest,
  type QuestAccent,
  type Task,
  type TimeLog,
} from "@/lib/db";
import { compareRank } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { CommandCenterView } from "@/components/CommandCenterView";

const TOMBSTONE_KEY = "hunt-sync-tombstones-v1";
/** Fixed creation/update stamp, so a rewrite of a row is visible in updatedAt. */
const T0 = 1_700_000_000_000;

// Real store actions, restored after tests that replace them with spies.
const realActions = (() => {
  const s = useCommandStore.getState();
  return {
    syncNow: s.syncNow,
    requestSync: s.requestSync,
    createTask: s.createTask,
    deleteTask: s.deleteTask,
    completeTaskById: s.completeTaskById,
    reorderTaskQueue: s.reorderTaskQueue,
    initializeFocus: s.initializeFocus,
  };
})();

function makeQuest(
  id: string,
  title: string,
  slotIndex: 0 | 1 | 2,
  targetWeeklyHours = 10
): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
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

function makeLog(
  id: string,
  dateKey: string,
  questId: string | null,
  durationSeconds: number
): TimeLog {
  const startTime = dateFromKey(dateKey).getTime();
  return {
    id,
    taskId: "tsk-logged",
    taskTitleSnapshot: `Session ${id}`,
    questId,
    questCodeSnapshot: questId ? "QUEST" : "OTHER",
    accentColorSnapshot: questId ? "cyan" : "slate",
    startTime,
    endTime: startTime + durationSeconds * 1000,
    durationSeconds,
    dateKey,
  };
}

async function seed({
  quests = [],
  tasks = [],
  logs = [],
}: {
  quests?: Quest[];
  tasks?: Task[];
  logs?: TimeLog[];
}) {
  await db.quests.bulkAdd(quests);
  await db.tasks.bulkAdd(tasks);
  await db.timeLogs.bulkAdd(logs);
}

const rows = () => screen.getAllByTestId("task-row");
const row = (taskId: string): HTMLElement => {
  const found = rows().find((r) => r.dataset.taskId === taskId);
  if (!found) throw new Error(`No task row for ${taskId}`);
  return found;
};
/** Visible order of the quest queue (its rows are the draggable ones). */
const queueOrder = () =>
  rows()
    .filter((r) => r.hasAttribute("draggable"))
    .map((r) => r.dataset.taskId);
/** Global queue order in IndexedDB (rank, ties by id). */
const dbOrder = async () =>
  (await db.tasks.toArray())
    .filter((t) => t.status === "queued" || t.status === "active")
    .sort(compareRank)
    .map((t) => t.id);
const updatedAtById = async () =>
  new Map((await db.tasks.toArray()).map((t) => [t.id, t.updatedAt]));
const playButton = (title: string) =>
  screen.getByRole("button", { name: `Start focus: ${title}` });

/** Small seeded PRNG (mulberry32) for reproducible random action sequences. */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("CommandCenterView (Home)", () => {
  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    window.localStorage.removeItem(TOMBSTONE_KEY);
    useCommandStore.setState({
      activeView: "command",
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      lastCompletedFeedback: null,
      syncNow: vi.fn(async () => true),
      requestSync: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup(); // unmount before restoring the store (no updates outside act)
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
    window.localStorage.removeItem(TOMBSTONE_KEY);
  });

  describe("corrupted or partial data", () => {
    it("renders an unknown quest accent, a task whose quest was deleted and a log without an accent snapshot", async () => {
      const now = Date.now();
      const todayKey = toLocalDateKey(now);
      const violet: Quest = {
        ...makeQuest("quest-violet", "Violet quest", 0),
        accentColor: "violet" as unknown as QuestAccent,
      };
      const bareLog = makeLog("log-bare", todayKey, "quest-violet", 1200);
      delete (bareLog as Partial<TimeLog>).accentColorSnapshot;
      await seed({
        quests: [violet],
        tasks: [
          makeTask("tsk-violet", "Task on violet", "quest-violet", 1000),
          makeTask("tsk-orphan", "Task of a deleted quest", "quest-gone", 2000),
          makeTask("tsk-done", "Done on violet", "quest-violet", 3000, {
            status: "completed",
            completedAt: now - 1000,
            accumulatedSeconds: 90,
          }),
        ],
        logs: [bareLog],
      });
      // Running on the violet task: the live timeline block reads its accent too.
      useCommandStore.setState({
        activeTaskId: "tsk-violet",
        isRunning: true,
        sessionStartedAt: now - 60_000,
        initializeFocus: vi.fn(async () => undefined),
      });

      render(<CommandCenterView />);

      expect(
        await screen.findByRole("button", { name: "Task on violet" })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Task of a deleted quest" })
      ).toBeInTheDocument();
      expect(screen.getByText("Done on violet")).toBeInTheDocument();
      expect(await screen.findByText("Session log-bare")).toBeInTheDocument();

      // The drawer's quest pills read the accent as well.
      fireEvent.click(
        within(row("tsk-violet")).getByTitle("Task notes & options")
      );
      expect(
        await screen.findByPlaceholderText("Add session notes...")
      ).toBeInTheDocument();

      // Unknown accents fall back to the neutral slate style.
      const filterPill = within(
        screen.getByRole("group", { name: "Filter by quest" })
      ).getByRole("button", { name: "Violet quest" });
      expect(filterPill.querySelector("span")).toHaveClass("bg-slate-500");
    });
  });

  describe("guarded delete", () => {
    it("the drawer's Delete only arms on the first click and deletes on the second", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-a", "Alpha", "quest-0", 1000),
          makeTask("tsk-b", "Bravo", "quest-0", 2000),
        ],
      });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });

      fireEvent.click(within(row("tsk-a")).getByTitle("Task notes & options"));
      const del = within(row("tsk-a")).getByRole("button", {
        name: "Delete task",
      });

      fireEvent.click(del);
      expect(del).toHaveAccessibleName("Confirm delete?");
      expect(del).toHaveAttribute("data-state", "armed");
      // The tombstone is written synchronously by deleteTask, so its absence
      // right after the click proves no delete started.
      expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
      expect(await db.tasks.get("tsk-a")).toBeDefined();

      // The second click of a double-click is not a confirmation.
      fireEvent.click(del, { detail: 2 });
      expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();

      fireEvent.click(del);
      await waitFor(async () =>
        expect(await db.tasks.get("tsk-a")).toBeUndefined()
      );
      const tombstones = JSON.parse(
        window.localStorage.getItem(TOMBSTONE_KEY) ?? "{}"
      ) as { deletedTaskIds?: string[] };
      expect(tombstones.deletedTaskIds).toEqual(["tsk-a"]);
      expect(await db.tasks.get("tsk-b")).toBeDefined();
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull()
      );
    });

    it("the hover-revealed Other-work trash stays visible while armed and deletes on the second click", async () => {
      await seed({ tasks: [makeTask("tsk-o", "Other chore", null, 1000)] });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Other chore" });

      const trash = within(row("tsk-o")).getByRole("button", {
        name: "Delete task",
      });
      expect(trash).toHaveClass(
        "opacity-0",
        "group-hover:opacity-100",
        "focus-visible:opacity-100",
        "data-[state=armed]:opacity-100"
      );

      fireEvent.click(trash);
      expect(trash).toHaveAttribute("data-state", "armed");
      expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
      expect(await db.tasks.get("tsk-o")).toBeDefined();

      fireEvent.click(trash);
      await waitFor(async () =>
        expect(await db.tasks.get("tsk-o")).toBeUndefined()
      );
    });
  });

  describe("double-submit guard on create", () => {
    beforeEach(async () => {
      await seed({ quests: [makeQuest("quest-0", "Launch", 0)] });
    });

    const loaded = () =>
      screen.findByRole("button", { name: "Launch", pressed: true });

    const countTitled = (title: string) =>
      db.tasks.filter((t) => t.title === title).count();

    it("10 clicks on Top in one tick create exactly one (trimmed) task", async () => {
      const createTask = vi.fn(realActions.createTask);
      useCommandStore.setState({ createTask });
      render(<CommandCenterView />);
      await loaded();

      const input = screen.getByPlaceholderText("Add quest work...");
      fireEvent.change(input, { target: { value: "  Ship it  " } });
      const top = screen.getByText("Top").closest("button");
      if (!top) throw new Error("Top button missing");

      // All ten clicks reach the handler before React re-renders.
      act(() => {
        for (let i = 0; i < 10; i++) top.click();
      });

      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask).toHaveBeenCalledWith({
        title: "Ship it",
        questId: "quest-0",
        promoteToTop: true,
      });
      expect(input).toHaveValue("");
      expect(top).toBeDisabled();
      await act(async () => {
        await createTask.mock.results[0].value;
      });

      expect(
        await screen.findByRole("button", { name: "Ship it" })
      ).toBeInTheDocument();
      // Ten more ordinary clicks with the cleared input do nothing.
      for (let i = 0; i < 10; i++) fireEvent.click(top);
      expect(createTask).toHaveBeenCalledTimes(1);
      expect(await countTitled("Ship it")).toBe(1);
    });

    it("10 Enter keydowns in one tick create exactly one task", async () => {
      const createTask = vi.fn(realActions.createTask);
      useCommandStore.setState({ createTask });
      render(<CommandCenterView />);
      await loaded();

      const input = screen.getByPlaceholderText("Add quest work...");
      fireEvent.change(input, { target: { value: "Write the brief" } });
      act(() => {
        for (let i = 0; i < 10; i++) {
          input.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              bubbles: true,
              cancelable: true,
            })
          );
        }
      });

      expect(createTask).toHaveBeenCalledTimes(1);
      await act(async () => {
        await createTask.mock.results[0].value;
      });
      expect(await countTitled("Write the brief")).toBe(1);
    });

    it("ignores empty and whitespace-only titles", async () => {
      const createTask = vi.fn(realActions.createTask);
      useCommandStore.setState({ createTask });
      render(<CommandCenterView />);
      await loaded();

      const input = screen.getByPlaceholderText("Add quest work...");
      for (const value of ["", "   "]) {
        fireEvent.change(input, { target: { value } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(screen.getByText("Top").closest("button")).toBeDisabled();
        expect(screen.getByText("Bottom").closest("button")).toBeDisabled();
      }
      expect(createTask).not.toHaveBeenCalled();
    });

    it("gives the typed title back and re-enables adding when the local write fails", async () => {
      // The real store action: a failed write resolves to false (it never
      // rejects), so the view must read the result, not wait for a throw.
      const errors = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const add = vi
        .spyOn(db.tasks, "add")
        .mockRejectedValueOnce(new Error("IDB closed"));
      const createTask = vi.fn(realActions.createTask);
      useCommandStore.setState({ createTask });
      render(<CommandCenterView />);
      await loaded();

      const input = screen.getByPlaceholderText("Add quest work...");
      fireEvent.change(input, { target: { value: "Fragile" } });
      fireEvent.click(screen.getByText("Top"));
      expect(input).toHaveValue("");

      await act(async () => {
        expect(await createTask.mock.results[0].value).toBe(false);
      });
      expect(input).toHaveValue("Fragile");
      expect(errors).toHaveBeenCalledWith(
        "[hunt] action_failed",
        "createTask",
        expect.any(Error)
      );
      expect(await countTitled("Fragile")).toBe(0);

      // The guard is released: the next add goes through and is written.
      fireEvent.click(screen.getByText("Bottom"));
      expect(createTask).toHaveBeenCalledTimes(2);
      await act(async () => {
        expect(await createTask.mock.results[1].value).toBe(true);
      });
      expect(add).toHaveBeenCalledTimes(2);
      expect(await countTitled("Fragile")).toBe(1);
      expect(input).toHaveValue("");
    });

    it("does not overwrite text typed while a failing create was in flight", async () => {
      let finish: (created: boolean) => void = () => undefined;
      const createTask = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          })
      );
      useCommandStore.setState({ createTask });
      render(<CommandCenterView />);
      await loaded();

      const input = screen.getByPlaceholderText("Add quest work...");
      fireEvent.change(input, { target: { value: "First" } });
      fireEvent.click(screen.getByText("Top"));
      expect(input).toHaveValue("");
      fireEvent.change(input, { target: { value: "Second" } });

      await act(async () => {
        finish(false);
        await createTask.mock.results[0].value;
      });
      expect(input).toHaveValue("Second");
    });
  });

  describe("complete buttons", () => {
    it("ignore the second click of a double-click; single clicks and keyboard activation complete", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-a", "Alpha", "quest-0", 1000),
          makeTask("tsk-b", "Bravo", "quest-0", 2000),
          makeTask("tsk-o", "Other chore", null, 3000),
        ],
      });
      const completeTaskById = vi.fn(realActions.completeTaskById);
      useCommandStore.setState({ completeTaskById });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });

      const completeIn = (taskId: string) =>
        within(row(taskId)).getByRole("button", { name: "Mark complete" });

      fireEvent.click(completeIn("tsk-a"), { detail: 2 });
      fireEvent.click(completeIn("tsk-o"), { detail: 2 });
      expect(completeTaskById).not.toHaveBeenCalled();

      fireEvent.click(completeIn("tsk-a"), { detail: 1 });
      fireEvent.click(completeIn("tsk-o"), { detail: 0 }); // keyboard activation
      expect(completeTaskById.mock.calls).toEqual([["tsk-a"], ["tsk-o"]]);

      await waitFor(async () => {
        expect((await db.tasks.get("tsk-a"))?.status).toBe("completed");
        expect((await db.tasks.get("tsk-o"))?.status).toBe("completed");
      });
      expect((await db.tasks.get("tsk-b"))?.status).toBe("queued");
    });
  });

  describe("keyboard reorder (Alt+ArrowUp / Alt+ArrowDown)", () => {
    let reorder: ReturnType<typeof vi.fn<typeof realActions.reorderTaskQueue>>;

    beforeEach(async () => {
      // Quest tasks with an Other task between them in the shared rank space.
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-a", "Alpha", "quest-0", 1000),
          makeTask("tsk-o", "Other chore", null, 1500),
          makeTask("tsk-b", "Bravo", "quest-0", 2000),
          makeTask("tsk-c", "Charlie", "quest-0", 3000),
        ],
      });
      reorder = vi.fn(realActions.reorderTaskQueue);
      useCommandStore.setState({ reorderTaskQueue: reorder });
    });

    /** Waits (inside act) for the last reorder write the view started. */
    const settled = () =>
      act(async () => {
        const last = reorder.mock.results.at(-1);
        if (last) await last.value;
      });

    it("Alt+ArrowDown swaps with the next row and rewrites only the moved row", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      expect(queueOrder()).toEqual(["tsk-a", "tsk-b", "tsk-c"]);
      expect(screen.getByText("Alt+↑/↓ to reorder")).toHaveClass(
        "text-hud-muted"
      );
      const before = await updatedAtById();

      const play = playButton("Alpha");
      play.focus();
      const notPrevented = fireEvent.keyDown(play, {
        key: "ArrowDown",
        altKey: true,
      });
      expect(notPrevented).toBe(false);
      expect(reorder).toHaveBeenCalledTimes(1);
      await settled();

      await waitFor(() =>
        expect(queueOrder()).toEqual(["tsk-b", "tsk-a", "tsk-c"])
      );
      // Globally Alpha lands right after Bravo; the Other task keeps its place.
      expect(await dbOrder()).toEqual(["tsk-o", "tsk-b", "tsk-a", "tsk-c"]);
      const after = await updatedAtById();
      const rewritten = Array.from(after.keys()).filter(
        (id) => after.get(id) !== before.get(id)
      );
      expect(rewritten).toEqual(["tsk-a"]);
      // Focus stays on the moved row's control, ready for the next press.
      await waitFor(() => expect(playButton("Alpha")).toHaveFocus());
    });

    it("Alt+ArrowUp moves up; nothing happens at either end of the list", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });

      fireEvent.keyDown(playButton("Alpha"), { key: "ArrowUp", altKey: true });
      fireEvent.keyDown(playButton("Charlie"), {
        key: "ArrowDown",
        altKey: true,
      });
      expect(reorder).not.toHaveBeenCalled();

      fireEvent.keyDown(playButton("Charlie"), { key: "ArrowUp", altKey: true });
      expect(reorder).toHaveBeenCalledTimes(1);
      await settled();
      await waitFor(() =>
        expect(queueOrder()).toEqual(["tsk-a", "tsk-c", "tsk-b"])
      );
    });

    it("ignores held keys, other modifiers, plain arrows and text fields", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      const play = playButton("Alpha");

      for (let i = 0; i < 10; i++) {
        fireEvent.keyDown(play, { key: "ArrowDown", altKey: true, repeat: true });
      }
      expect(fireEvent.keyDown(play, { key: "ArrowDown" })).toBe(true);
      fireEvent.keyDown(play, { key: "ArrowDown", altKey: true, shiftKey: true });
      fireEvent.keyDown(play, { key: "ArrowDown", altKey: true, ctrlKey: true });

      fireEvent.click(within(row("tsk-a")).getByTitle("Task notes & options"));
      const notes = await screen.findByPlaceholderText("Add session notes...");
      expect(
        fireEvent.keyDown(notes, { key: "ArrowDown", altKey: true })
      ).toBe(true);

      expect(reorder).not.toHaveBeenCalled();
      expect(queueOrder()).toEqual(["tsk-a", "tsk-b", "tsk-c"]);
    });

    it("a burst of 10 separate presses in one tick makes one move and leaves a consistent order", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      const play = playButton("Alpha");

      // Not marked as repeats: only the one-move-at-a-time guard drops 2-10.
      act(() => {
        for (let i = 0; i < 10; i++) {
          play.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowDown",
              altKey: true,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      });
      expect(reorder).toHaveBeenCalledTimes(1);
      await settled();
      await waitFor(() =>
        expect(queueOrder()).toEqual(["tsk-b", "tsk-a", "tsk-c"])
      );
      expect(await dbOrder()).toEqual(["tsk-o", "tsk-b", "tsk-a", "tsk-c"]);
    });

    it("a seeded random sequence of moves keeps the UI, IndexedDB and a model in the same order", async () => {
      await db.tasks.bulkAdd([
        makeTask("tsk-d", "Delta", "quest-0", 4000),
        makeTask("tsk-e", "Echo", "quest-0", 5000),
      ]);
      const titles: Record<string, string> = {
        "tsk-a": "Alpha",
        "tsk-b": "Bravo",
        "tsk-c": "Charlie",
        "tsk-d": "Delta",
        "tsk-e": "Echo",
      };
      const seedValue = 0x5eed2026;
      const rand = mulberry32(seedValue);
      const model = ["tsk-a", "tsk-b", "tsk-c", "tsk-d", "tsk-e"];

      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });

      for (let step = 0; step < 20; step++) {
        const index = Math.floor(rand() * model.length);
        const dir = rand() < 0.5 ? -1 : 1;
        const id = model[index];
        const calls = reorder.mock.calls.length;
        const play = playButton(titles[id]);
        play.focus();
        fireEvent.keyDown(play, {
          key: dir < 0 ? "ArrowUp" : "ArrowDown",
          altKey: true,
        });
        const target = index + dir;
        if (target >= 0 && target < model.length) {
          [model[index], model[target]] = [model[target], model[index]];
          expect(reorder.mock.calls.length, `seed ${seedValue} step ${step}`).toBe(
            calls + 1
          );
          await settled();
        } else {
          expect(reorder.mock.calls.length, `seed ${seedValue} step ${step}`).toBe(
            calls
          );
        }
        await waitFor(() =>
          expect(queueOrder(), `seed ${seedValue} step ${step}`).toEqual(model)
        );
      }

      const stored = await db.tasks.toArray();
      const questIdsInRankOrder = (await dbOrder()).filter((id) => id !== "tsk-o");
      expect(questIdsInRankOrder, `seed ${seedValue}`).toEqual(model);
      expect(stored).toHaveLength(6);
      const ranks = stored.map((t) => t.rank);
      expect(ranks.every(Number.isFinite), `seed ${seedValue}`).toBe(true);
      expect(new Set(ranks).size, `seed ${seedValue}`).toBe(ranks.length);
      expect((await db.tasks.get("tsk-o"))?.rank).toBe(1500);
    });

    it("drag and drop still moves exactly one row through the shared move logic", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      const before = await updatedAtById();

      fireEvent.dragStart(row("tsk-c"));
      fireEvent.dragOver(row("tsk-a"));
      fireEvent.drop(row("tsk-a"));
      expect(reorder).toHaveBeenCalledTimes(1);
      await settled();

      await waitFor(() =>
        expect(queueOrder()).toEqual(["tsk-c", "tsk-a", "tsk-b"])
      );
      const after = await updatedAtById();
      expect(
        Array.from(after.keys()).filter((id) => after.get(id) !== before.get(id))
      ).toEqual(["tsk-c"]);
    });
  });

  describe("semantics and accessible state", () => {
    beforeEach(async () => {
      await seed({
        quests: [
          makeQuest("quest-0", "Launch my idea", 0),
          makeQuest("quest-1", "Write every week", 1),
        ],
        tasks: [
          makeTask("tsk-a", "Alpha", "quest-0", 1000),
          makeTask("tsk-o", "Other chore", null, 2000),
          makeTask("tsk-done", "Finished thing", "quest-1", 3000, {
            status: "completed",
            completedAt: T0,
            accumulatedSeconds: 120,
          }),
        ],
      });
    });

    it("every button has an accessible name (drawer and banner included)", async () => {
      useCommandStore.setState({
        lastCompletedFeedback: {
          taskTitle: "Finished thing",
          questCode: "WRITE",
          accent: "amber",
          loggedSeconds: 120,
          nextTaskTitle: null,
          timestamp: T0,
        },
      });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      fireEvent.click(within(row("tsk-a")).getByTitle("Task notes & options"));
      await screen.findByPlaceholderText("Add session notes...");

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(15);
      for (const button of buttons) expect(button).toHaveAccessibleName();

      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
      expect(playButton("Other chore")).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Completed Finished thing"
      );
    });

    it("task titles are native buttons that start focus", async () => {
      const initializeFocus = vi.fn(async () => undefined);
      useCommandStore.setState({ initializeFocus });
      render(<CommandCenterView />);

      const title = await screen.findByRole("button", { name: "Alpha" });
      expect(title.tagName).toBe("BUTTON");
      expect(title).toHaveAttribute("type", "button");
      title.focus();
      expect(title).toHaveFocus();
      // A focused native button activates on Enter/Space with a click event.
      fireEvent.click(title);
      expect(initializeFocus).toHaveBeenLastCalledWith("tsk-a");

      fireEvent.click(screen.getByRole("button", { name: "Other chore" }));
      expect(initializeFocus).toHaveBeenLastCalledWith("tsk-o");
      fireEvent.click(playButton("Alpha"));
      expect(initializeFocus).toHaveBeenCalledTimes(3);
    });

    it("quest pills expose aria-pressed and follow the selection", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      const group = screen.getByRole("group", { name: "Quest for new task" });
      const launch = within(group).getByRole("button", { name: "Launch my idea" });
      const write = within(group).getByRole("button", { name: "Write every week" });
      const other = within(group).getByRole("button", { name: "Other work" });

      await waitFor(() => expect(launch).toHaveAttribute("aria-pressed", "true"));
      expect(write).toHaveAttribute("aria-pressed", "false");
      expect(other).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(write);
      expect(launch).toHaveAttribute("aria-pressed", "false");
      expect(write).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(other);
      expect(write).toHaveAttribute("aria-pressed", "false");
      expect(other).toHaveAttribute("aria-pressed", "true");
    });

    it("filter pills are labelled, toggle aria-pressed and filter the queue", async () => {
      await db.tasks.add(makeTask("tsk-w", "Wordsmith", "quest-1", 1500));
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Wordsmith" });
      const filters = screen.getByRole("group", { name: "Filter by quest" });
      const all = within(filters).getByRole("button", { name: "All" });
      const write = within(filters).getByRole("button", {
        name: "Write every week",
      });

      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(write).toHaveAttribute("aria-pressed", "false");

      fireEvent.click(write);
      expect(write).toHaveAttribute("aria-pressed", "true");
      expect(all).toHaveAttribute("aria-pressed", "false");
      expect(queueOrder()).toEqual(["tsk-w"]);

      fireEvent.click(write);
      expect(write).toHaveAttribute("aria-pressed", "false");
      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(queueOrder()).toEqual(["tsk-a", "tsk-w"]);
    });

    it("the notes toggle reports aria-expanded false, true, false and is revealed on focus", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      const toggle = within(row("tsk-a")).getByTitle("Task notes & options");
      expect(toggle).toHaveClass("opacity-0", "focus-visible:opacity-100");

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    it("rows carry stable selectors; completed cards are not queue rows", async () => {
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      expect(rows().map((r) => r.dataset.taskId)).toEqual(["tsk-a", "tsk-o"]);
    });

    it("uses the AA muted token instead of neutral-500/600 text and dims only the accents of completed cards", async () => {
      const { container } = render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });
      fireEvent.click(within(row("tsk-a")).getByTitle("Task notes & options"));
      await screen.findByPlaceholderText("Add session notes...");

      for (const el of Array.from(container.querySelectorAll("[class]"))) {
        const cls = el.getAttribute("class") ?? "";
        expect(cls, cls).not.toMatch(
          /(^|\s)(placeholder:)?text-neutral-(500|600)(\s|$)/
        );
        if (el.tagName === "BUTTON" && /(^|\s)opacity-0(\s|$)/.test(cls)) {
          expect(cls).toContain("focus-visible:opacity-100");
        }
      }
      expect(
        screen.getByPlaceholderText("Add quest work...").closest(".border-dashed")
      ).toHaveClass("focus-within:border-white/40");

      const doneTitle = screen.getByText("Finished thing");
      expect(doneTitle).toHaveClass("text-hud-muted", "line-through");
      let el: HTMLElement | null = doneTitle;
      while (el && el !== container) {
        expect(el.className).not.toMatch(/(^|\s)opacity-\d+/);
        el = el.parentElement;
      }
      const card = doneTitle.parentElement as HTMLElement;
      expect(
        within(card).getByRole("button", { name: "Reopen task" })
      ).toHaveClass("opacity-65");
    });
  });

  describe("long unbroken text", () => {
    const longTask = `T${"a".repeat(199)}`;
    const longQuest = `Q${"b".repeat(199)}`;
    const longDone = `D${"c".repeat(199)}`;

    it("wraps titles, truncates single-line pills with the full text as a tooltip, and keeps the controls from shrinking", async () => {
      await seed({
        quests: [makeQuest("quest-long", longQuest, 0)],
        tasks: [
          makeTask("tsk-long", longTask, "quest-long", 1000),
          makeTask("tsk-done", longDone, "quest-long", 2000, {
            status: "completed",
            completedAt: T0,
          }),
        ],
      });
      useCommandStore.setState({
        lastCompletedFeedback: {
          taskTitle: longDone,
          questCode: "LONG",
          accent: "cyan",
          loggedSeconds: 60,
          nextTaskTitle: null,
          timestamp: T0,
        },
      });
      render(<CommandCenterView />);

      const title = await screen.findByRole("button", { name: longTask });
      expect(title).toHaveClass("block", "w-full", "text-left", "break-words");

      const taskRow = row("tsk-long");
      const pill = within(taskRow).getByTitle(longQuest);
      expect(pill).toHaveClass("truncate");
      expect(pill).toHaveTextContent(longQuest);
      expect(pill.parentElement).toHaveClass("min-w-0", "max-w-full");
      const toggle = within(taskRow).getByTitle("Task notes & options");
      expect(toggle.parentElement).toHaveClass("shrink-0");
      const play = playButton(longTask);
      expect(play.parentElement).toHaveClass("min-w-0");

      const selector = within(
        screen.getByRole("group", { name: "Quest for new task" })
      ).getByTitle(longQuest);
      expect(selector).toHaveClass("truncate");
      expect(selector.parentElement).toHaveClass("min-w-0", "max-w-full");

      fireEvent.click(toggle);
      await screen.findByPlaceholderText("Add session notes...");
      const drawerPill = within(taskRow)
        .getAllByTitle(longQuest)
        .find((el) => el.closest("button[aria-pressed]"));
      expect(drawerPill).toHaveClass("truncate");

      const doneTitle = screen
        .getAllByText(longDone)
        .find((el) => el.classList.contains("line-through"));
      expect(doneTitle).toHaveClass("break-words");
      const doneCard = doneTitle?.parentElement as HTMLElement;
      expect(within(doneCard).getByTitle(longQuest)).toHaveClass("truncate");

      const status = screen.getByRole("status");
      const message = within(status).getByText(longDone).parentElement;
      expect(message).toHaveClass("min-w-0", "break-words");
      expect(within(status).getByRole("button", { name: "Dismiss" })).toHaveClass(
        "shrink-0"
      );
    });
  });

  describe("loading vs empty", () => {
    it("never shows the empty-queue copy (or 0.0h) while seeded tasks are loading", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [makeTask("tsk-a", "Alpha", "quest-0", 1000)],
      });
      render(<CommandCenterView />);
      expect(screen.queryByText(/No quest tasks queued/)).toBeNull();
      expect(screen.getByText("–")).toBeInTheDocument();
      expect(screen.getByText("– this week")).toBeInTheDocument();
      expect(screen.queryByText("0.0h")).toBeNull();

      await screen.findByRole("button", { name: "Alpha" });
      expect(screen.queryByText(/No quest tasks queued/)).toBeNull();
      expect(await screen.findByText("0.0h")).toBeInTheDocument();
    });

    it("shows the empty-queue copy once an empty database has loaded", async () => {
      render(<CommandCenterView />);
      expect(
        await screen.findByText(/No quest tasks queued/)
      ).toBeInTheDocument();
      expect(await screen.findByText("0.0h / 0h this week")).toBeInTheDocument();
    });
  });

  describe("week totals (indexed 7-day query)", () => {
    // Pinned so the DST case runs on every machine, not only on EU clocks.
    const previousTz = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Europe/Berlin";
    });
    afterAll(() => {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    });

    // Monday 2026-03-30, noon: the window 03-24 … 03-30 spans the EU DST
    // change on Sunday 2026-03-29.
    const nowAt = () => new Date(2026, 2, 30, 12, 0, 0);

    it("the pinned zone really changes to summer time inside the window", () => {
      expect(new Date(2026, 2, 30, 12).getTimezoneOffset()).toBe(-120);
      expect(new Date(2026, 2, 24, 12).getTimezoneOffset()).toBe(-60);
    });

    it("counts quest logs from today back to 6 days ago, not 7 or 8, and ignores 2000 old logs", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(nowAt());
      const oldLogs = Array.from({ length: 2000 }, (_, i) =>
        makeLog(
          `log-old-${i}`,
          dateKeyFromOffset("2026-03-30", -(30 + (i % 400))),
          "quest-0",
          3600
        )
      );
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0, 10)],
        logs: [
          makeLog("log-today", "2026-03-30", "quest-0", 3600),
          makeLog("log-today-other", "2026-03-30", null, 600),
          makeLog("log-6d", "2026-03-24", "quest-0", 1800),
          makeLog("log-7d", "2026-03-23", "quest-0", 7200),
          makeLog("log-8d", "2026-03-22", "quest-0", 7200),
          ...oldLogs,
        ],
      });
      const wholeTableRead = vi.spyOn(db.timeLogs, "toArray");

      render(<CommandCenterView />);

      expect(await screen.findByText("1.5h / 10h this week")).toBeInTheDocument();
      expect(screen.getByText("1.0h")).toBeInTheDocument();
      expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
      expect(wholeTableRead).not.toHaveBeenCalled();
      // Positive control: the spy does see direct whole-table reads.
      await db.timeLogs.toArray();
      expect(wholeTableRead).toHaveBeenCalledTimes(1);
    });

    it("moves the window at midnight", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 2, 30, 23, 59, 0));
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0, 10)],
        logs: [
          makeLog("log-today", "2026-03-30", "quest-0", 3600),
          makeLog("log-6d", "2026-03-24", "quest-0", 1800),
        ],
      });
      render(<CommandCenterView />);
      expect(await screen.findByText("1.5h / 10h this week")).toBeInTheDocument();
      expect(screen.getByText("1.0h")).toBeInTheDocument();

      vi.setSystemTime(new Date(2026, 2, 31, 0, 0, 30));
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // 03-24 is now 7 days back; yesterday's hour still counts for the week.
      expect(await screen.findByText("1.0h / 10h this week")).toBeInTheDocument();
      expect(screen.getByText("0.0h")).toBeInTheDocument();

      // The query itself moved: a session logged on the new day is read.
      await act(async () => {
        await db.timeLogs.add(
          makeLog("log-new-day", "2026-03-31", "quest-0", 1800)
        );
      });
      expect(await screen.findByText("1.5h / 10h this week")).toBeInTheDocument();
      expect(screen.getByText("0.5h")).toBeInTheDocument();
    });
  });

  describe("scheduled day filtering and drawer Escape ergonomics", () => {
    it("hides tasks moved to a future day from today's Home queue and shows them again when moved back", async () => {
      const todayKey = toLocalDateKey();
      const tomorrowKey = dateKeyFromOffset(todayKey, 1);
      const yesterdayKey = dateKeyFromOffset(todayKey, -1);
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-today", "Due today", "quest-0", 1000, {
            scheduledDate: todayKey,
          }),
          makeTask("tsk-overdue", "Overdue from yesterday", "quest-0", 2000, {
            scheduledDate: yesterdayKey,
          }),
          makeTask("tsk-tomorrow", "Moved to tomorrow", "quest-0", 3000, {
            scheduledDate: tomorrowKey,
          }),
          makeTask("tsk-other-tomorrow", "Other tomorrow", null, 4000, {
            scheduledDate: tomorrowKey,
          }),
        ],
      });

      render(<CommandCenterView />);
      expect(await screen.findByRole("button", { name: "Due today" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Overdue from yesterday" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Moved to tomorrow" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Other tomorrow" })).toBeNull();

      // Moving a today task to tomorrow removes it immediately from Home
      await act(async () => {
        await useCommandStore.getState().updateTask("tsk-today", {
          scheduledDate: tomorrowKey,
        });
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Due today" })).toBeNull()
      );

      // Moving tomorrow's task back to today restores it on Home
      await act(async () => {
        await useCommandStore.getState().updateTask("tsk-tomorrow", {
          scheduledDate: todayKey,
        });
      });
      expect(
        await screen.findByRole("button", { name: "Moved to tomorrow" })
      ).toBeInTheDocument();
    });

    it("closes an expanded task notes drawer on Escape", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [makeTask("tsk-a", "Alpha", "quest-0", 1000)],
      });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Alpha" });

      const toggle = within(row("tsk-a")).getByTitle("Task notes & options");
      fireEvent.click(toggle);
      const notes = await screen.findByPlaceholderText("Add session notes...");
      fireEvent.keyDown(notes, { key: "Escape" });
      expect(screen.queryByPlaceholderText("Add session notes...")).toBeNull();
    });

    it("animates newly completed tasks into Completed with arrival highlight and clears timer cleanly", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [makeTask("tsk-anim", "Ship smooth animation", "quest-0", 1000)],
      });

      const { unmount } = render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Ship smooth animation" });

      // Keep setImmediate real for fake-indexeddb and rAF real for Framer Motion
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        await act(async () => {
          fireEvent.click(
            within(row("tsk-anim")).getByRole("button", { name: "Mark complete" })
          );
          for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        });

        const completedSection = screen.getByTestId("completed-tasks-section");
        expect(within(completedSection).getByText("Completed")).toBeInTheDocument();
        const completedRow = screen.getByTestId("completed-task-row");
        expect(completedRow).toHaveTextContent("Ship smooth animation");
        // Arrival highlight ring + solid in-flight surface + animated SVG stroke-draw checkmark are active
        expect(completedRow.className).toContain("border-[#00ff9d]/35");
        expect(completedRow.className).toContain("z-20");
        const reopenBtn = within(completedRow).getByRole("button", {
          name: "Reopen task",
        });
        expect(reopenBtn.querySelector('path[stroke-dasharray="24"]')).not.toBeNull();

        // After 650ms, arrival highlight clears deterministically
        act(() => {
          vi.advanceTimersByTime(700);
        });
        expect(completedRow.className).not.toContain("border-[#00ff9d]/35");

        // Reopen and complete again, then unmount mid-highlight to verify deterministic timer cleanup
        await act(async () => {
          fireEvent.click(reopenBtn);
          for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        });
        const clearSpy = vi.spyOn(window, "clearTimeout");
        await act(async () => {
          fireEvent.click(
            within(row("tsk-anim")).getByRole("button", { name: "Mark complete" })
          );
          for (let i = 0; i < 6; i++) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        });
        clearSpy.mockClear();
        unmount();
        expect(clearSpy).toHaveBeenCalled();
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("excludes completed quests from filter/new-task pills and target hours while keeping historical badges", async () => {
      await seed({
        quests: [
          makeQuest("quest-active", "Active Quest", 0, 8),
          {
            ...makeQuest("quest-retired", "Retired Quest", 1, 12),
            archived: true,
            completedAt: T0,
          },
        ],
        tasks: [
          makeTask("tsk-1", "Active work", "quest-active", 1000),
          makeTask("tsk-old", "Historical win", "quest-retired", 2000, {
            status: "completed",
            completedAt: Date.now(),
          }),
        ],
      });

      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Active work" });

      // Filter pills and new-task quest pills only list active quests
      const filters = screen.getByRole("group", { name: "Filter by quest" });
      expect(within(filters).getByRole("button", { name: "Active Quest" })).toBeInTheDocument();
      expect(within(filters).queryByRole("button", { name: "Retired Quest" })).toBeNull();

      const newTaskQuests = screen.getByRole("group", { name: "Quest for new task" });
      expect(
        within(newTaskQuests).getByRole("button", { name: "Active Quest" })
      ).toBeInTheDocument();
      expect(
        within(newTaskQuests).queryByRole("button", { name: "Retired Quest" })
      ).toBeNull();

      // Weekly target denominator sums active quests only (8h, not 20h)
      expect(screen.getByText(/\/ 8h this week/)).toBeInTheDocument();

      // Completed task still displays its retired quest badge
      const completedRow = screen.getByTestId("completed-task-row");
      expect(within(completedRow).getByText("Retired Quest")).toBeInTheDocument();
    });

    it("flushes and blurs task notes immediately on Ctrl+Enter", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [makeTask("tsk-n", "Notes shortcut", "quest-0", 1000)],
      });
      render(<CommandCenterView />);
      await screen.findByRole("button", { name: "Notes shortcut" });

      fireEvent.click(within(row("tsk-n")).getByTitle("Task notes & options"));
      const notes = await screen.findByPlaceholderText("Add session notes...");
      notes.focus();
      fireEvent.change(notes, { target: { value: "Saved with shortcut" } });
      fireEvent.keyDown(notes, { key: "Enter", ctrlKey: true });

      await waitFor(async () =>
        expect((await db.tasks.get("tsk-n"))?.notes).toBe("Saved with shortcut")
      );
    });
  });
});
