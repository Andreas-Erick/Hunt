// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Habit, Quest, QuestAccent, Task, TaskStatus, TimeLog } from "@/lib/domainTypes";
import {
  canonicalString,
  mergeSyncPayloads,
  syncContentKey,
  validateSyncPayload,
  type ActiveFocusState,
  type SyncPayload,
} from "@/lib/syncTypes";

// Seeded property tests of the shared merge (R1–R6). Every failure
// message carries its seed; rerun one case by setting BASE_SEED to it with
// ITERATIONS = 1.
//
// Known exceptions, deliberately NOT asserted:
// - activeFocus with EQUAL focus stamps (the `>=` tie keeps `incoming`;
//   deferred), and activeFocus associativity in general (a focus reset in an
//   intermediate merge mints a new stamp that depends on the grouping).
// - accumulatedSeconds associativity: the counter is max()ed and raised to the
//   logged total of each intermediate result, so a log that a later merge
//   tombstones (or replaces by an earlier-ended version) can stay counted in
//   one grouping and not in another. Only its invariants are asserted.
// - Equal-stamp task versions that differ in questId, combined with a quest
//   tombstone, are not associative: R1 compares the questId-sanitised rows,
//   and which quest ids are sanitised depends on the grouping. The generator
//   keeps equal-stamp versions on the same questId (see taskQuestId).

const BASE_SEED = 0xa5c05;
const ITERATIONS = 400;
// Two devices merge the same states at different wall-clock times.
const CLOCK_A = Date.UTC(2026, 10, 18, 9);
const CLOCK_B = Date.UTC(2026, 10, 19, 21);

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const QUEST_IDS = ["quest-1763400000000-a1b2", "quest-1763400000001-c3d4", "quest-slot-0"];
const QUEST_OR_NULL: ReadonlyArray<string | null> = [...QUEST_IDS, null];
const TASK_IDS = [
  "tsk-1763400000000-aaaa",
  "tsk-1763400000001-bbbb",
  "tsk-1763400000002-cccc",
  "tsk-1763400000003-dddd",
  "tsk-01",
];
const HABIT_IDS = ["hab-1763400000000-jog1", "hab-1763400000001-read"];
const STAMPS = [1000, 2000, 3000]; // few values, so equal stamps are frequent
const LOG_STARTS = [10_000, 20_000];
const LOG_IDS = TASK_IDS.flatMap((taskId) => LOG_STARTS.map((start) => `log-${start}-${taskId}`));
const DURATIONS = [60, 600, 1800];
const STATUSES: readonly TaskStatus[] = ["queued", "active", "completed", "archived"];
const ACCENTS: readonly QuestAccent[] = ["cyan", "emerald", "amber"];

/** Equal-stamp versions of one task share their questId (third known exception above). */
function taskQuestId(taskIndex: number, updatedAt: number): string | null {
  return QUEST_OR_NULL[(taskIndex + updatedAt / 1000) % QUEST_OR_NULL.length];
}

function generatePayload(rand: () => number, seed: number): SyncPayload {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number) => rand() < p;

  const quests: Quest[] = QUEST_IDS.filter(() => chance(0.6)).map((id) => ({
    id,
    slotIndex: pick([0, 1, 2] as const),
    code: pick(["CORE", "RUN"]),
    title: pick(["Alpha", "Beta", "Gamma"]),
    description: pick(["", "notes"]),
    accentColor: pick(ACCENTS),
    targetWeeklyHours: pick([5, 10]),
    archived: chance(0.2),
    createdAt: 500,
    updatedAt: pick(STAMPS),
  }));

  const tasks: Task[] = [];
  TASK_IDS.forEach((id, index) => {
    if (!chance(0.7)) return;
    const updatedAt = pick(STAMPS);
    const task: Task = {
      id,
      title: pick(["Write", "Run", "Read"]),
      notes: pick(["", "n"]),
      questId: taskQuestId(index, updatedAt),
      status: pick(STATUSES),
      rank: pick([1000, 2000, 3000]),
      accumulatedSeconds: pick([0, 60, 600, 5000]),
      createdAt: 500,
      updatedAt,
    };
    if (chance(0.3)) task.completedAt = updatedAt;
    if (chance(0.5)) task.scheduledDate = pick(["2026-11-18", "2026-11-19"]);
    // A Count Habit day's total and +1 tick time ride on the row (merged whole, ADR-0001).
    if (chance(0.3)) task.amount = pick([0, 1, 2.5, 7]);
    if (chance(0.2)) task.countTickedAt = pick(STAMPS);
    tasks.push(task);
  });

  // Habits of every Kind; old rows without one read as Check. questId stays null so the
  // equal-stamp questId exception above cannot arise.
  const habits: Habit[] = HABIT_IDS.filter(() => chance(0.7)).map((id) => {
    const habit: Habit = {
      id,
      title: pick(["Jog", "Read"]),
      notes: pick(["", "n"]),
      questId: null,
      rank: pick([1000, 2000]),
      createdAt: 500,
      updatedAt: pick(STAMPS),
    };
    const kind = pick([undefined, "check", "count"] as const);
    if (kind) habit.kind = kind;
    if (kind === "count") {
      habit.target = pick([1, 3, 2.5]);
      habit.unit = pick(["", "miles"]);
    }
    return habit;
  });

  const timeLogs: TimeLog[] = [];
  for (const taskId of TASK_IDS) {
    for (const startTime of LOG_STARTS) {
      if (!chance(0.35)) continue;
      const durationSeconds = pick(DURATIONS);
      timeLogs.push({
        id: `log-${startTime}-${taskId}`,
        taskId,
        taskTitleSnapshot: pick(["Write", "Run"]),
        questId: pick(QUEST_OR_NULL),
        questCodeSnapshot: pick(["Alpha", "Other"]),
        accentColorSnapshot: pick([...ACCENTS, "slate" as const]),
        startTime,
        endTime: startTime + durationSeconds * 1000,
        durationSeconds,
        dateKey: "2026-11-18",
      });
    }
  }

  const runningTask = pick(TASK_IDS);
  const focusRoll = rand();
  const activeFocus: ActiveFocusState =
    focusRoll < 0.4
      ? { activeTaskId: runningTask, isRunning: true, sessionStartedAt: pick(LOG_STARTS), updatedAt: pick([1000, 2000, 3000, 4000]) }
      : focusRoll < 0.6
        ? { activeTaskId: runningTask, isRunning: false, sessionStartedAt: null, updatedAt: pick([1000, 2000, 3000, 4000]) }
        : { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: pick([0, 1000, 2000, 3000, 4000]) };

  const raw: SyncPayload = {
    quests,
    tasks,
    timeLogs,
    habits,
    deletedHabitIds: HABIT_IDS.filter(() => chance(0.1)),
    deletedQuestIds: QUEST_IDS.filter(() => chance(0.15)),
    deletedTaskIds: TASK_IDS.filter(() => chance(0.15)),
    deletedLogIds: LOG_IDS.filter(() => chance(0.1)),
    activeFocus,
    lastSyncedAt: 0,
  };
  const check = validateSyncPayload(raw);
  if (!check.valid || !check.payload) throw new Error(`seed=${seed}: generated payload rejected: ${check.error}`);
  if (check.dropped) throw new Error(`seed=${seed}: generator produced ${check.dropped} invalid rows`);
  return check.payload;
}

/** Rows and tombstone SETS, independent of array order (optionally without the counters). */
function rowsKey(p: SyncPayload, options: { withCounters: boolean }): string {
  const rows = (list: readonly object[]) =>
    list
      .map((row) => {
        if (options.withCounters) return canonicalString(row);
        const { accumulatedSeconds: _counter, ...rest } = row as Partial<Task>;
        void _counter;
        return canonicalString(rest);
      })
      .sort();
  const ids = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  return canonicalString({
    quests: rows(p.quests),
    tasks: rows(p.tasks),
    timeLogs: rows(p.timeLogs),
    deletedQuestIds: ids(p.deletedQuestIds),
    deletedTaskIds: ids(p.deletedTaskIds),
    deletedLogIds: ids(p.deletedLogIds),
  });
}

/** No tombstoned row survives, and no task keeps a tombstoned quest. */
function expectTombstonesWin(p: SyncPayload, msg: string): void {
  const deleted = new Set([...(p.deletedQuestIds ?? []), ...p.deletedTaskIds, ...p.deletedLogIds]);
  for (const row of [...p.quests, ...p.tasks, ...p.timeLogs]) {
    expect(deleted.has(row.id), `${msg} ${row.id} survived its tombstone`).toBe(false);
  }
  for (const task of p.tasks) {
    expect(task.questId !== null && deleted.has(task.questId), `${msg} ${task.id} kept a deleted quest`).toBe(false);
  }
}

/** R6: a merged focus never points at a missing or completed task. */
function expectFocusOnLiveTask(p: SyncPayload, msg: string): void {
  const { activeTaskId } = p.activeFocus;
  if (activeTaskId === null) return;
  const task = p.tasks.find((t) => t.id === activeTaskId);
  expect(task !== undefined && task.status !== "completed", `${msg} focus on ${activeTaskId}`).toBe(true);
}

/** R2: a log id present on both sides keeps the version that ended first. */
function expectEarlierEndWins(a: SyncPayload, b: SyncPayload, merged: SyncPayload, msg: string): void {
  for (const log of merged.timeLogs) {
    const ends = [a, b]
      .map((side) => side.timeLogs.find((l) => l.id === log.id)?.endTime)
      .filter((end): end is number => end !== undefined);
    expect(log.endTime, `${msg} ${log.id}`).toBe(Math.min(...ends));
  }
}

/** accumulatedSeconds is a finite number and at least the time logged for the task. */
function expectCountersCoverLogs(p: SyncPayload, msg: string): void {
  for (const task of p.tasks) {
    const logged = p.timeLogs
      .filter((log) => log.taskId === task.id)
      .reduce((sum, log) => sum + log.durationSeconds, 0);
    expect(Number.isFinite(task.accumulatedSeconds), `${msg} ${task.id} NaN counter`).toBe(true);
    expect(task.accumulatedSeconds, `${msg} ${task.id}`).toBeGreaterThanOrEqual(logged);
  }
}

describe(`mergeSyncPayloads properties (${ITERATIONS} seeds from ${BASE_SEED})`, () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is clock-independent, commutative, idempotent and associative on rows and tombstone sets; counters cover logs", () => {
    let sharedIdCases = 0;
    let equalStampCases = 0;
    let tombstoneCases = 0;

    for (let i = 0; i < ITERATIONS; i++) {
      const seed = BASE_SEED + i;
      const msg = `seed=${seed}`;
      const rand = lcg(seed);
      const a = generatePayload(rand, seed);
      const b = generatePayload(rand, seed);
      const c = generatePayload(rand, seed);

      vi.setSystemTime(CLOCK_A);
      const ab = mergeSyncPayloads(a, b);
      vi.setSystemTime(CLOCK_B);
      // The content depends on the inputs alone, never on the clock (R6's
      // reset stamp is deterministic), so every device merging the same
      // states gets the same result.
      expect(syncContentKey(mergeSyncPayloads(a, b)), `${msg} clock`).toBe(syncContentKey(ab));
      const ba = mergeSyncPayloads(b, a);

      // The merged state is what the server stores: it must validate unchanged.
      const check = validateSyncPayload(ab);
      expect(check.valid, msg).toBe(true);
      expect(check.dropped, msg).toBe(0);
      expect(check.payload && syncContentKey(check.payload), msg).toBe(syncContentKey(ab));

      // Commutativity (rows, counters, tombstone sets); focus only when the stamps differ.
      expect(rowsKey(ba, { withCounters: true }), msg).toBe(rowsKey(ab, { withCounters: true }));
      if (a.activeFocus.updatedAt !== b.activeFocus.updatedAt) {
        expect(canonicalString(ba.activeFocus), msg).toBe(canonicalString(ab.activeFocus));
        // The newer focus wins, unless its task is gone or completed: then a
        // cleared focus with a still newer stamp.
        const newer = a.activeFocus.updatedAt > b.activeFocus.updatedAt ? a.activeFocus : b.activeFocus;
        const kept = canonicalString(ab.activeFocus) === canonicalString(newer);
        const cleared =
          ab.activeFocus.activeTaskId === null &&
          !ab.activeFocus.isRunning &&
          ab.activeFocus.updatedAt > newer.updatedAt;
        expect(kept || cleared, `${msg} focus`).toBe(true);
      }

      // Idempotency of a merged state, and absorption of either input.
      expect(syncContentKey(mergeSyncPayloads(ab, ab)), msg).toBe(syncContentKey(ab));
      expect(rowsKey(mergeSyncPayloads(ab, a), { withCounters: true }), msg).toBe(
        rowsKey(ab, { withCounters: true })
      );
      expect(rowsKey(mergeSyncPayloads(b, ab), { withCounters: true }), msg).toBe(
        rowsKey(ab, { withCounters: true })
      );

      // Associativity (rows without counters, tombstone sets).
      const left = mergeSyncPayloads(ab, c);
      const right = mergeSyncPayloads(a, mergeSyncPayloads(b, c));
      expect(rowsKey(right, { withCounters: false }), msg).toBe(rowsKey(left, { withCounters: false }));
      expect(validateSyncPayload(left).valid, msg).toBe(true);
      expect(validateSyncPayload(right).valid, msg).toBe(true);

      for (const merged of [ab, ba, left, right]) {
        expectCountersCoverLogs(merged, msg);
        expectTombstonesWin(merged, msg);
        expectFocusOnLiveTask(merged, msg);
      }
      expectEarlierEndWins(a, b, ab, msg);
      expectEarlierEndWins(a, b, ba, msg);

      const sharedTaskIds = a.tasks.filter((t) => b.tasks.some((u) => u.id === t.id));
      if (sharedTaskIds.length > 0) sharedIdCases++;
      if (sharedTaskIds.some((t) => b.tasks.some((u) => u.id === t.id && u.updatedAt === t.updatedAt))) {
        equalStampCases++;
      }
      if (a.deletedTaskIds.length + (a.deletedQuestIds ?? []).length + a.deletedLogIds.length > 0) {
        tombstoneCases++;
      }
    }

    // The generator really exercises shared ids, equal stamps and tombstones.
    expect(sharedIdCases).toBeGreaterThan(ITERATIONS / 2);
    expect(equalStampCases).toBeGreaterThan(ITERATIONS / 5);
    expect(tombstoneCases).toBeGreaterThan(ITERATIONS / 4);
  });
});
