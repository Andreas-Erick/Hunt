// @vitest-environment node
// Pending Ticks (ADR-0006): a Task ticked done on the Day Widget is queued by the shell and applied
// by HuntCore the next time Hunt starts, through the shared complete-a-Task rule.
import { describe, expect, it } from "vitest";
import { applyPendingTicks, buildHabitTaskRow, completeTaskRow, habitTaskId } from "@/mobile/huntCore";
import type { Habit, Task } from "@/lib/domainTypes";
import { mergeSyncPayloads, type SyncPayload } from "@/lib/syncTypes";

const DAY = "2026-11-22";
const TICKED_AT = new Date(2026, 10, 22, 7, 15).getTime();

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1",
    title: "Write report",
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

function state(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    quests: [],
    tasks: [],
    timeLogs: [],
    habits: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...overrides,
  };
}

const habit: Habit = { id: "hab-1", title: "Stretch", notes: "", questId: null, rank: 500, createdAt: 100 };

describe("applyPendingTicks", () => {
  it("completes the Task at the time it was ticked, through the shared rule", () => {
    const before = task();
    const { state: after, skipped } = applyPendingTicks(state({ tasks: [before] }), [
      { taskId: "tsk-1", dateKey: DAY, tickedAt: TICKED_AT },
    ]);
    expect(skipped).toEqual([]);
    expect(after.tasks).toEqual([completeTaskRow(before, TICKED_AT)]);
    expect(after.tasks[0].completedAt).toBe(TICKED_AT);
  });

  it("creates today's Habit row Hunt has not created yet, then completes it", () => {
    const other = task({ id: "tsk-9", rank: 2000 });
    const id = habitTaskId(habit.id, DAY);
    const { state: after, skipped } = applyPendingTicks(state({ habits: [habit], tasks: [other] }), [
      { taskId: id, dateKey: DAY, tickedAt: TICKED_AT },
    ]);
    expect(skipped).toEqual([]);
    expect(after.tasks.map((t) => t.id)).toEqual([id, "tsk-9"]); // rank order, as the app keeps it
    expect(after.tasks[0]).toMatchObject({
      habitId: "hab-1",
      title: "Stretch",
      scheduledDate: DAY,
      status: "completed",
      completedAt: TICKED_AT,
      updatedAt: TICKED_AT,
    });
  });

  const focusOn = (taskId: string) => ({ activeTaskId: taskId, isRunning: true, sessionStartedAt: 1000, updatedAt: 1000 });
  it.each([
    ["missing", "a Task deleted elsewhere", state({ tasks: [task({ id: "tsk-other" })] }), "tsk-1"],
    ["missing", "a Habit row deleted elsewhere", state({ habits: [habit], deletedTaskIds: [habitTaskId("hab-1", DAY)] }), habitTaskId("hab-1", DAY)],
    ["missing", "a Habit deleted elsewhere", state({ habits: [] }), habitTaskId("hab-1", DAY)],
    ["already-done", "a Task completed elsewhere", state({ tasks: [task({ status: "completed", completedAt: 99 })] }), "tsk-1"],
    ["archived", "an archived Task", state({ tasks: [task({ status: "archived" })] }), "tsk-1"],
    ["in-focus", "a Task that has since started Focus", state({ tasks: [task()], activeFocus: focusOn("tsk-1") }), "tsk-1"],
  ] as const)("skips the tick as %s for %s and leaves the state as it was", (reason, _label, before, taskId) => {
    const tick = { taskId, dateKey: DAY, tickedAt: TICKED_AT };
    const { state: after, skipped } = applyPendingTicks(before, [tick]);
    expect(skipped).toEqual([{ tick, reason }]);
    expect(after).toEqual(before);
  });

  it("gives the same result when the same ticks are applied twice", () => {
    const before = state({ habits: [habit], tasks: [task(), task({ id: "tsk-2", rank: 2000 })] });
    const ticks = [
      { taskId: "tsk-1", dateKey: DAY, tickedAt: TICKED_AT },
      { taskId: habitTaskId("hab-1", DAY), dateKey: DAY, tickedAt: TICKED_AT + 5_000 },
    ];
    const once = applyPendingTicks(before, ticks).state;
    const twice = applyPendingTicks(once, ticks);
    expect(twice.state).toEqual(once);
    expect(twice.skipped.map((s) => s.reason)).toEqual(["already-done", "already-done"]);
  });

  describe("a +1 tick on a Count Habit row", () => {
    const jog: Habit = { ...habit, id: "hab-jog", title: "Jog", kind: "count", target: 3, unit: "miles" };
    const jogId = habitTaskId(jog.id, DAY);
    const plus = (tickedAt: number, taskId = jogId) => ({ taskId, dateKey: DAY, tickedAt, kind: "+1" as const });

    it("creates the day's row Hunt has not created yet with a total of 1", () => {
      const { state: after, skipped } = applyPendingTicks(state({ habits: [jog] }), [plus(TICKED_AT)]);
      expect(skipped).toEqual([]);
      expect(after.tasks[0]).toMatchObject({ id: jogId, amount: 1, status: "queued", countTickedAt: TICKED_AT });
    });

    it("adds one per tick through the shared rule, completing the day at its target", () => {
      const before = state({ habits: [jog], tasks: [{ ...buildHabitTaskRow(jog, DAY), amount: 1 }] });
      const { state: after } = applyPendingTicks(before, [plus(TICKED_AT), plus(TICKED_AT + 1000)]);
      expect(after.tasks[0]).toMatchObject({ amount: 3, status: "completed", completedAt: TICKED_AT + 1000 });
    });

    it("is applied once: the same ticks read again are skipped and change nothing", () => {
      const ticks = [plus(TICKED_AT), plus(TICKED_AT + 1000)];
      const once = applyPendingTicks(state({ habits: [jog] }), ticks).state;
      const twice = applyPendingTicks(once, ticks);
      expect(twice.state).toEqual(once);
      expect(twice.skipped.map((s) => s.reason)).toEqual(["already-counted", "already-counted"]);
      expect(once.tasks[0].amount).toBe(2);
    });

    it("still counts on a day already Met, so going over the target is recorded", () => {
      const met = { ...buildHabitTaskRow(jog, DAY), amount: 3, status: "completed" as const, completedAt: 5 };
      const { state: after, skipped } = applyPendingTicks(state({ habits: [jog], tasks: [met] }), [plus(TICKED_AT)]);
      expect(skipped).toEqual([]);
      expect(after.tasks[0]).toMatchObject({ amount: 4, completedAt: 5 });
    });

    it("never mixes up the two kinds: +1 on a Check row, or a done tick on a Count row, is skipped", () => {
      const check = state({ habits: [habit, jog], tasks: [task()] });
      const wrong = [plus(TICKED_AT, "tsk-1"), { taskId: jogId, dateKey: DAY, tickedAt: TICKED_AT }];
      const { state: after, skipped } = applyPendingTicks(check, wrong);
      expect(skipped.map((s) => s.reason)).toEqual(["wrong-kind", "wrong-kind"]);
      expect(after).toEqual(check);
    });
  });

  it("skips a malformed tick as missing", () => {
    const before = state({ tasks: [task()] });
    const bad = { taskId: "tsk-1", dateKey: DAY, tickedAt: Number.NaN };
    const { state: after, skipped } = applyPendingTicks(before, [bad]);
    expect(skipped).toEqual([{ tick: bad, reason: "missing" }]);
    expect(after).toEqual(before);
  });
});

// Seeded property test: the phone applies widget ticks while the desktop edits the same data; the
// two then sync in either direction. Every failure message carries its seed.
describe("applyPendingTicks with a concurrent desktop snapshot", () => {
  const BASE_SEED = 0x7e1c8;
  const ITERATIONS = 300;
  const IDS = ["tsk-a", "tsk-b", "tsk-c", "tsk-d"];
  const STATUSES = ["queued", "active", "completed", "archived"] as const;
  const STAMPS = [1_000, 2_000, TICKED_AT - 1, TICKED_AT, TICKED_AT + 1];

  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function randomCase(seed: number) {
    const rand = lcg(seed);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const base = IDS.filter(() => rand() < 0.8).map((id, i) =>
      task({ id, rank: (i + 1) * 1000, status: pick(["queued", "active"] as const), updatedAt: 1_000 })
    );
    const withHabit = rand() < 0.5;
    const phone = state({ tasks: base, habits: withHabit ? [habit] : [] });
    // The desktop edits, completes, archives or deletes some of the same Tasks meanwhile.
    const deleted = base.filter(() => rand() < 0.15).map((t) => t.id);
    const desktop = state({
      habits: withHabit ? [habit] : [],
      deletedTaskIds: deleted,
      tasks: base
        .filter((t) => !deleted.includes(t.id))
        .map((t) => (rand() < 0.5 ? { ...t, status: pick(STATUSES), title: pick(["A", "B"]), updatedAt: pick(STAMPS) } : t)),
    });
    const ticks = [...IDS, habitTaskId(habit.id, DAY)]
      .filter(() => rand() < 0.6)
      .map((taskId) => ({ taskId, dateKey: DAY, tickedAt: TICKED_AT + Math.floor(rand() * 3) * 1000 }));
    return { phone, desktop, ticks };
  }

  const rowsKey = (p: SyncPayload) =>
    JSON.stringify({
      tasks: p.tasks.map((t) => JSON.stringify(t, Object.keys(t).sort())).sort(),
      deletedTaskIds: [...p.deletedTaskIds].sort(),
    });

  it("converges to the same Tasks whichever side merges first", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const { phone, desktop, ticks } = randomCase(seed);
      const ticked = applyPendingTicks(phone, ticks).state;
      const phoneSide = mergeSyncPayloads(ticked, desktop);
      const desktopSide = mergeSyncPayloads(desktop, ticked);
      expect(rowsKey(phoneSide), `seed=${seed}`).toBe(rowsKey(desktopSide));
      // A tick on a Task the desktop left alone always survives the merge.
      for (const tick of ticks) {
        const untouched = desktop.tasks.find((t) => t.id === tick.taskId)?.updatedAt === 1_000;
        const applied = ticked.tasks.find((t) => t.id === tick.taskId)?.completedAt === tick.tickedAt;
        if (!untouched || !applied) continue;
        const merged = phoneSide.tasks.find((t) => t.id === tick.taskId);
        expect(merged?.status, `seed=${seed} ${tick.taskId}`).toBe("completed");
      }
    }
  });
});
