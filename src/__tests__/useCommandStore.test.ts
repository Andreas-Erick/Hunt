import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, toLocalDateKey, type Task } from "@/lib/db";
import { compareRank } from "@/lib/syncTypes";
import {
  orderAfterDrop,
  planRankMoves,
  useCommandStore,
} from "@/store/useCommandStore";

describe("Command Store & Focus State Machine (useCommandStore.ts)", () => {
  beforeEach(async () => {
    // Hermetic: the debounced syncs mutations request never reach a real
    // network, and never outlive their test (cleared in afterEach). Date and
    // setImmediate stay real (elapsed-time tests; fake-indexeddb needs it).
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();

    // Seed 2 baseline quests for testing
    await db.quests.bulkPut([
      {
        id: "quest-slot-0",
        slotIndex: 0,
        code: "LAUNCH",
        title: "Launch my idea",
        description: "Core product work",
        accentColor: "cyan",
        targetWeeklyHours: 12,
        archived: false,
        createdAt: Date.now(),
      },
      {
        id: "quest-slot-1",
        slotIndex: 1,
        code: "WRITE",
        title: "Write every week",
        description: "Weekly essay",
        accentColor: "amber",
        targetWeeklyHours: 5,
        archived: false,
        createdAt: Date.now(),
      },
    ]);

    useCommandStore.setState({
      activeView: "command",
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      focusUpdatedAt: 0,
      lastCompletedFeedback: null,
      actionError: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Task Creation & Queue Ordering", () => {
    it("creates tasks at the top or bottom of the priority queue", async () => {
      const store = useCommandStore.getState();

      await store.createTask({
        title: "First task",
        questId: "quest-slot-0",
        promoteToTop: false,
      });

      await store.createTask({
        title: "Second task (Bottom)",
        questId: "quest-slot-0",
        promoteToTop: false,
      });

      await store.createTask({
        title: "Urgent task (Top)",
        questId: "quest-slot-1",
        promoteToTop: true,
      });

      const tasks = await db.tasks.orderBy("rank").toArray();
      expect(tasks).toHaveLength(3);
      expect(tasks[0].title).toBe("Urgent task (Top)");
      expect(tasks[1].title).toBe("First task");
      expect(tasks[2].title).toBe("Second task (Bottom)");
    });

    it("ignores blank or whitespace-only task titles", async () => {
      await useCommandStore.getState().createTask({
        title: "   ",
        questId: "quest-slot-0",
      });
      const count = await db.tasks.count();
      expect(count).toBe(0);
    });

    /** Rows sorted the way every view shows them (rank, ties by id). */
    const queueOrder = async () => (await db.tasks.toArray()).sort(compareRank);
    const changedRows = (before: Task[], after: Task[]) =>
      after.filter((t) => {
        const old = before.find((b) => b.id === t.id);
        return !old || old.rank !== t.rank || old.updatedAt !== t.updatedAt;
      });

    it("reorders tasks deterministically with reorderTaskQueue(), rewriting only the moved row", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "A", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "B", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "C", questId: "quest-slot-0", promoteToTop: false });

      const initial = await queueOrder();
      const [a, b, c] = initial;

      await store.reorderTaskQueue([c.id, a.id, b.id]);

      const reordered = await queueOrder();
      expect(reordered.map((t) => t.title)).toEqual(["C", "A", "B"]);
      // Only C moved (to the top: next - 1000); A and B are untouched.
      expect(changedRows(initial, reordered).map((t) => t.title)).toEqual(["C"]);
      expect(reordered.map((t) => t.rank)).toEqual([0, 1000, 2000]);
      const movedC = reordered[0];
      expect(movedC.updatedAt).toBeGreaterThan(c.updatedAt ?? 0);
    });

    it("reorderTaskQueue() writes only the dragged row, and nothing when the order is unchanged", async () => {
      const store = useCommandStore.getState();
      for (const title of ["A", "B", "C", "D"]) {
        await store.createTask({ title, questId: "quest-slot-0", promoteToTop: false });
      }
      const before = await queueOrder();
      const [a, b, c, d] = before;

      // C dragged above B: C gets a rank between A and B; A, B and D keep theirs.
      const bulkPut = vi.spyOn(db.tasks, "bulkPut");
      await store.reorderTaskQueue([a.id, c.id, b.id, d.id], c.id);
      expect(bulkPut).toHaveBeenCalledTimes(1);
      expect((bulkPut.mock.calls[0][0] as Task[]).map((t) => t.id)).toEqual([c.id]);

      const after = await queueOrder();
      expect(after.map((t) => t.title)).toEqual(["A", "C", "B", "D"]);
      expect(changedRows(before, after).map((t) => t.title)).toEqual(["C"]);
      expect(after.find((t) => t.id === c.id)?.rank).toBe(1500);

      // Re-applying the same order writes nothing.
      bulkPut.mockClear();
      await store.reorderTaskQueue([a.id, c.id, b.id, d.id], c.id);
      expect(bulkPut).not.toHaveBeenCalled();
      bulkPut.mockRestore();
    });

    it("after an Add-to-top, a drag in the queue (CommandCenterView drop logic) rewrites exactly one row", async () => {
      const store = useCommandStore.getState();
      // Quest and Other tasks interleaved in one rank space, plus an Other task
      // added to the top: the drop logic must not push it (or anything else) around.
      await store.createTask({ title: "Q1", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "O1", questId: null, promoteToTop: false });
      await store.createTask({ title: "Q2", questId: "quest-slot-1", promoteToTop: false });
      await store.createTask({ title: "O2", questId: null, promoteToTop: false });
      await store.createTask({ title: "Q3", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "Urgent", questId: null, promoteToTop: true });
      await store.createTask({ title: "Q-top", questId: "quest-slot-0", promoteToTop: true });

      const drag = async (dragged: string, target: string) => {
        const pending = await queueOrder();
        const byTitle = (x: string) => pending.find((t) => t.title === x)!.id;
        const questIds = pending.filter((t) => t.questId !== null).map((t) => t.id);
        const order = orderAfterDrop(
          pending.map((t) => t.id),
          questIds,
          byTitle(dragged),
          byTitle(target)
        );
        expect(order).not.toBeNull();
        await useCommandStore.getState().reorderTaskQueue(order!, byTitle(dragged));
        return pending;
      };
      const questTitles = async () =>
        (await queueOrder()).filter((t) => t.questId !== null).map((t) => t.title);

      expect(await questTitles()).toEqual(["Q-top", "Q1", "Q2", "Q3"]);

      // Drag Q3 (last) onto Q1 (moving up): lands right before Q1.
      let before = await drag("Q3", "Q1");
      let after = await queueOrder();
      expect(await questTitles()).toEqual(["Q-top", "Q3", "Q1", "Q2"]);
      expect(changedRows(before, after).map((t) => t.title)).toEqual(["Q3"]);

      // Drag Q-top (first) onto Q2 (moving down): lands right after Q2.
      before = await drag("Q-top", "Q2");
      after = await queueOrder();
      expect(await questTitles()).toEqual(["Q3", "Q1", "Q2", "Q-top"]);
      expect(changedRows(before, after).map((t) => t.title)).toEqual(["Q-top"]);

      // The Other sector never moved.
      expect(after.filter((t) => t.questId === null).map((t) => t.title)).toEqual([
        "Urgent",
        "O1",
        "O2",
      ]);
    });

    it("planRankMoves(): equal-rank neighbours and exhausted gaps never renumber the queue", () => {
      // Equal ranks (added on two devices while apart) are ordered by id.
      const rows = [
        { id: "a", rank: 5000 },
        { id: "c", rank: 6000 },
        { id: "b", rank: 5000 },
      ];
      // c dragged between a and b (equal ranks): no room between them, so the
      // plan moves one row elsewhere instead of renumbering everything.
      const plan = planRankMoves(rows, "c");
      expect(plan.size).toBe(1);
      const ranks = rows.map((r) => ({ ...r, rank: plan.get(r.id) ?? r.rank }));
      expect(ranks.slice().sort(compareRank).map((r) => r.id)).toEqual(["a", "c", "b"]);

      // Gap below 1e-6: still a one-row move, never a full renumber.
      const tight = [
        { id: "x", rank: 1000 },
        { id: "z", rank: 2000 },
        { id: "y", rank: 1000 + 1e-7 },
      ];
      const tightPlan = planRankMoves(tight, "z");
      expect(tightPlan.size).toBe(1);
      const tightRanks = tight.map((r) => ({ ...r, rank: tightPlan.get(r.id) ?? r.rank }));
      expect(tightRanks.slice().sort(compareRank).map((r) => r.id)).toEqual(["x", "z", "y"]);

      // Already in order: nothing to write.
      expect(planRankMoves([{ id: "p", rank: 1 }, { id: "q", rank: 2 }]).size).toBe(0);
    });

    it("a local write never carries an older updatedAt than the row it replaces (R6)", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "A", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "B", questId: "quest-slot-0", promoteToTop: false });
      const [a, b] = await queueOrder();
      // B was last written by a device whose clock runs 1 h ahead.
      const future = Date.now() + 3_600_000;
      await db.tasks.update(b.id, { updatedAt: future });

      await store.reorderTaskQueue([b.id, a.id], b.id);
      const movedB = await db.tasks.get(b.id);
      expect(movedB?.rank).toBe(0);
      expect(movedB?.updatedAt).toBe(future + 1);
    });

    it("adds to the top with rank top-1000 without touching any other task", async () => {
      const store = useCommandStore.getState();
      for (let i = 0; i < 12; i++) {
        await store.createTask({ title: `Bottom ${i}`, questId: null, promoteToTop: false });
      }
      const before = await db.tasks.toArray();

      for (let i = 0; i < 12; i++) {
        await store.createTask({ title: `Top ${i}`, questId: null, promoteToTop: true });
      }

      const all = await db.tasks.orderBy("rank").toArray();
      // Newest "Top" task first, strictly increasing ranks (no collapse/ties).
      expect(all[0].title).toBe("Top 11");
      const ranks = all.map((t) => t.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
      for (const row of before) {
        const now = all.find((t) => t.id === row.id);
        expect(now?.rank).toBe(row.rank);
        expect(now?.updatedAt).toBe(row.updatedAt);
      }
    });
  });

  describe("Single-Task Focus & Time Measurement (Principles 1, 2 & 3)", () => {
    it("initializes focus on the #1 prioritized Quest task when no ID is passed", async () => {
      const store = useCommandStore.getState();
      // Add an 'Other' maintenance task with lower rank number first
      await store.createTask({ title: "Admin task", questId: null, promoteToTop: true });
      // Add a Quest task
      await store.createTask({ title: "Core Quest Task", questId: "quest-slot-0", promoteToTop: false });

      await useCommandStore.getState().initializeFocus();

      const state = useCommandStore.getState();
      expect(state.activeView).toBe("focus");
      expect(state.isRunning).toBe(true);
      expect(state.sessionStartedAt).not.toBeNull();

      const activeTask = await db.tasks.get(state.activeTaskId!);
      expect(activeTask?.title).toBe("Core Quest Task");
      expect(activeTask?.status).toBe("active");
    });

    it("flushes elapsed time into TimeLogs and increments accumulatedSeconds on suspendTimer()", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Deep Work Session", questId: "quest-slot-0" });
      const [task] = await db.tasks.toArray();

      await store.initializeFocus(task.id);

      // Simulate 45 seconds of focus work by backdating sessionStartedAt
      const fortyFiveSecAgo = Date.now() - 45_000;
      useCommandStore.setState({ sessionStartedAt: fortyFiveSecAgo });

      await useCommandStore.getState().suspendTimer();

      const afterState = useCommandStore.getState();
      expect(afterState.isRunning).toBe(false);
      expect(afterState.sessionStartedAt).toBeNull();

      const updatedTask = await db.tasks.get(task.id);
      expect(updatedTask?.accumulatedSeconds).toBeGreaterThanOrEqual(44);
      expect(updatedTask?.accumulatedSeconds).toBeLessThanOrEqual(46);

      const logs = await db.timeLogs.toArray();
      expect(logs).toHaveLength(1);
      expect(logs[0].taskId).toBe(task.id);
      expect(logs[0].questId).toBe("quest-slot-0");
      expect(logs[0].questCodeSnapshot).toBe("Launch my idea");
      expect(logs[0].accentColorSnapshot).toBe("cyan");
      expect(logs[0].dateKey).toBe(toLocalDateKey());
    });

    it("flushes the previous task's burst and returns it to queued when switching focus to another task", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Task 1", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "Task 2", questId: "quest-slot-1", promoteToTop: false });
      const [t1, t2] = await db.tasks.orderBy("rank").toArray();

      await store.initializeFocus(t1.id);
      useCommandStore.setState({ sessionStartedAt: Date.now() - 30_000 });

      // Switch directly to Task 2
      await useCommandStore.getState().initializeFocus(t2.id);

      const updatedT1 = await db.tasks.get(t1.id);
      const updatedT2 = await db.tasks.get(t2.id);

      expect(updatedT1?.status).toBe("queued");
      expect(updatedT1?.accumulatedSeconds).toBeGreaterThanOrEqual(29);
      expect(updatedT2?.status).toBe("active");
      expect(useCommandStore.getState().activeTaskId).toBe(t2.id);
    });

    it("completes the active task, logs time, and offers the next queued task without auto-starting it", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Step 1", questId: "quest-slot-0", promoteToTop: false });
      await store.createTask({ title: "Step 2", questId: "quest-slot-1", promoteToTop: false });
      const [step1, step2] = await db.tasks.orderBy("rank").toArray();

      await store.initializeFocus(step1.id);
      useCommandStore.setState({ sessionStartedAt: Date.now() - 120_000 }); // 2m

      await useCommandStore.getState().completeActiveTask();

      const completedStep1 = await db.tasks.get(step1.id);
      const queuedStep2 = await db.tasks.get(step2.id);
      expect(completedStep1?.status).toBe("completed");
      expect(completedStep1?.completedAt).toBeDefined();
      expect(queuedStep2?.status).toBe("queued");

      // Should stay in Focus mode offering Step 2, without starting it automatically
      const nextState = useCommandStore.getState();
      expect(nextState.activeView).toBe("focus");
      expect(nextState.activeTaskId).toBeNull();
      expect(nextState.isRunning).toBe(false);
      expect(nextState.sessionStartedAt).toBeNull();
      expect(nextState.lastCompletedFeedback?.taskTitle).toBe("Step 1");
      expect(nextState.lastCompletedFeedback?.nextTaskTitle).toBe("Step 2");

      // Explicitly start Step 2, then complete it (last task in queue) -> should return to 'command' view
      await useCommandStore.getState().initializeFocus(step2.id);
      await useCommandStore.getState().completeActiveTask();
      const finalState = useCommandStore.getState();
      expect(finalState.activeView).toBe("command");
      expect(finalState.activeTaskId).toBeNull();
      expect(finalState.isRunning).toBe(false);
    });

    it("supports direct check/uncheck via completeTaskById() and reopenTaskById()", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Quick check task", questId: "quest-slot-0" });
      const [task] = await db.tasks.toArray();

      await store.completeTaskById(task.id);
      const afterComplete = await db.tasks.get(task.id);
      expect(afterComplete?.status).toBe("completed");

      await store.reopenTaskById(task.id);
      const afterReopen = await db.tasks.get(task.id);
      expect(afterReopen?.status).toBe("queued");
      expect(afterReopen?.completedAt).toBeUndefined();
    });

    it("re-focusing the task that is already running keeps its session (no lost time)", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Running task", questId: "quest-slot-0" });
      const [task] = await db.tasks.toArray();

      await store.initializeFocus(task.id);
      const startedAt = Date.now() - 90_000;
      useCommandStore.setState({ sessionStartedAt: startedAt, activeView: "command" });

      await useCommandStore.getState().initializeFocus(task.id);

      const state = useCommandStore.getState();
      expect(state.activeView).toBe("focus");
      expect(state.isRunning).toBe(true);
      expect(state.sessionStartedAt).toBe(startedAt);

      await useCommandStore.getState().suspendTimer();
      expect((await db.tasks.get(task.id))?.accumulatedSeconds).toBeGreaterThanOrEqual(89);
    });

    it("flushes a session at most once (deterministic, idempotent session log)", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Once", questId: "quest-slot-0" });
      const [task] = await db.tasks.toArray();
      await store.initializeFocus(task.id);
      const startedAt = Date.now() - 30_000;
      useCommandStore.setState({ sessionStartedAt: startedAt });

      // e.g. the phone already logged this session (startTime = sessionStartedAt)
      await db.timeLogs.add({
        id: "log-from-phone",
        taskId: task.id,
        taskTitleSnapshot: task.title,
        questId: task.questId,
        questCodeSnapshot: "Launch my idea",
        accentColorSnapshot: "cyan",
        startTime: startedAt,
        endTime: Date.now(),
        durationSeconds: 30,
        dateKey: toLocalDateKey(),
      });

      await useCommandStore.getState().suspendTimer();

      const logs = await db.timeLogs.toArray();
      expect(logs.map((l) => l.id)).toEqual(["log-from-phone"]);
      expect((await db.tasks.get(task.id))?.accumulatedSeconds).toBe(0);
      expect(useCommandStore.getState().isRunning).toBe(false);
    });

    it("cleans up active state safely if the currently focused task is deleted", async () => {
      const store = useCommandStore.getState();
      await store.createTask({ title: "Temporary task", questId: "quest-slot-0" });
      const [task] = await db.tasks.toArray();

      await store.initializeFocus(task.id);
      expect(useCommandStore.getState().activeTaskId).toBe(task.id);

      await useCommandStore.getState().deleteTask(task.id);
      expect(useCommandStore.getState().activeTaskId).toBeNull();
      expect(useCommandStore.getState().isRunning).toBe(false);
    });
  });

  describe("Quest Completion & Reopening", () => {
    it("retires a quest, moves open tasks and habits to Other work, preserves completed tasks & logs, and reopens cleanly", async () => {
      const store = useCommandStore.getState();
      const futureStamp = Date.now() + 50_000;
      await db.quests.update("quest-slot-0", { updatedAt: futureStamp });

      await store.createTask({ title: "Open step", questId: "quest-slot-0" });
      await store.createTask({ title: "Done step", questId: "quest-slot-0" });
      const tasks = await db.tasks.toArray();
      const openTask = tasks.find((t) => t.title === "Open step")!;
      const doneTask = tasks.find((t) => t.title === "Done step")!;
      await store.completeTaskById(doneTask.id);

      await db.habits.add({
        id: "hab-quest-0",
        title: "Daily practice",
        notes: "",
        questId: "quest-slot-0",
        rank: 1000,
        createdAt: Date.now(),
        updatedAt: futureStamp,
      });

      await db.timeLogs.add({
        id: "log-quest-0",
        taskId: doneTask.id,
        taskTitleSnapshot: doneTask.title,
        questId: "quest-slot-0",
        questCodeSnapshot: "LAUNCH MY ",
        accentColorSnapshot: "cyan",
        startTime: Date.now() - 1800_000,
        endTime: Date.now(),
        durationSeconds: 1800,
        dateKey: toLocalDateKey(),
      });

      await useCommandStore.getState().completeQuest("quest-slot-0");

      const completedQuest = await db.quests.get("quest-slot-0");
      expect(completedQuest?.archived).toBe(true);
      expect(typeof completedQuest?.completedAt).toBe("number");
      // R6 monotonic stamp even when prior updatedAt was ahead of local clock
      expect(completedQuest?.updatedAt).toBe(futureStamp + 1);

      const afterOpen = await db.tasks.get(openTask.id);
      const afterDone = await db.tasks.get(doneTask.id);
      const afterHabit = await db.habits.get("hab-quest-0");
      const afterLog = await db.timeLogs.get("log-quest-0");

      expect(afterOpen?.questId).toBeNull();
      expect(afterDone?.questId).toBe("quest-slot-0");
      expect(afterHabit?.questId).toBeNull();
      expect(afterHabit?.updatedAt).toBe(futureStamp + 1);
      expect(afterLog?.questId).toBe("quest-slot-0");

      // Completing a quest must NOT record a quest deletion tombstone
      const tombstones = JSON.parse(
        window.localStorage.getItem("hunt-sync-tombstones-v1") ?? '{"deletedQuestIds":[]}'
      ) as { deletedQuestIds?: string[] };
      expect(tombstones.deletedQuestIds ?? []).not.toContain("quest-slot-0");

      // Reopen restores archived=false, clears completedAt, and advances updatedAt
      await useCommandStore.getState().reopenQuest("quest-slot-0");
      const reopened = await db.quests.get("quest-slot-0");
      expect(reopened?.archived).toBe(false);
      expect(reopened?.completedAt).toBeUndefined();
      expect(reopened?.updatedAt).toBeGreaterThan(completedQuest!.updatedAt!);

      // Unknown quest IDs are safe no-ops
      await useCommandStore.getState().completeQuest("quest-missing");
      await useCommandStore.getState().reopenQuest("quest-missing");
    });
  });
});
