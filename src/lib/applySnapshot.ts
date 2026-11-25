import { db } from "./db";
import type {
  ActiveFocusState,
  Habit,
  List,
  Quest,
  Task,
  TimeLog,
} from "./domainTypes";
import {
  TOMBSTONE_KINDS,
  buildTombstones,
  getLocalTombstones,
  saveLocalTombstones,
} from "./syncTombstones";
import {
  mergeSyncPayloads,
  pickLogWinner,
  pickRowWinner,
  questOrHabitRowStamp,
  taskRowStamp,
  validateSyncPayload,
  type SyncPayload,
} from "./syncTypes";

/*
 * The local IndexedDB side of a sync: reading this device's snapshot out of
 * Dexie, diff-applying a merged snapshot back into it, and merging an
 * imported snapshot file (offline sync).
 */

/**
 * Builds a complete SyncPayload from the local device's IndexedDB + focus state.
 * All five tables are read in ONE readonly transaction (consistent snapshot).
 */
export async function buildLocalSyncPayload(
  activeFocus: ActiveFocusState
): Promise<SyncPayload> {
  const [quests, tasks, timeLogs, habits, lists] = await db.transaction(
    "r",
    [db.quests, db.tasks, db.timeLogs, db.habits, db.lists],
    () =>
      Promise.all([
        db.quests.toArray(),
        db.tasks.toArray(),
        db.timeLogs.toArray(),
        db.habits.toArray(),
        db.lists.toArray(),
      ])
  );
  return {
    quests,
    tasks,
    timeLogs,
    habits,
    lists,
    ...getLocalTombstones(),
    activeFocus,
    lastSyncedAt: Date.now(),
  };
}

/** Field-wise equality; a missing field equals an `undefined` one. */
function sameRow(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const eq = (x: unknown, y: unknown) =>
    x === y ||
    (typeof x === "object" &&
      x !== null &&
      typeof y === "object" &&
      y !== null &&
      JSON.stringify(x) === JSON.stringify(y));
  for (const k in ra) if (!eq(ra[k], rb[k])) return false;
  for (const k in rb) if (!(k in ra) && rb[k] !== undefined) return false;
  return true;
}

/** Appends ids of `extra` missing from `base`; returns `base` itself if nothing is new. */
function unionIds(base: string[], extra: unknown): string[] {
  if (!Array.isArray(extra) || extra.length === 0) return base;
  const seen = new Set(base);
  let out: string[] | null = null;
  for (const id of extra) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    (out ??= base.slice()).push(id);
  }
  return out ?? base;
}

function hasStringId<T extends { id: unknown }>(row: T | null | undefined): row is T {
  return !!row && typeof row === "object" && typeof row.id === "string";
}

/**
 * Applies a merged SyncPayload (e.g. the server's response) into local IndexedDB.
 *
 * The payload reflects a snapshot taken BEFORE the request went out, so it is
 * diff-merged against the CURRENT local rows inside one rw transaction:
 * - quests/tasks/habits/lists: the newer row wins by the server's per-kind stamp
 *   (questOrHabitRowStamp / taskRowStamp); EQUAL timestamps are resolved by the
 *   shared rule R1 (pickRowWinner: smaller canonical content wins, identical
 *   keeps the local row), compared after nulling a `questId` that points at a
 *   tombstoned quest (that nulling is also applied to the result);
 *   `accumulatedSeconds` takes the max of both
 * - logs: two versions of one id are resolved by the shared rule R2
 *   (pickLogWinner: the earlier endTime wins)
 * - tombstones are UNIONED with the local list (never replaced), so a deletion
 *   recorded after the snapshot survives
 * - only rows that exist are deleted, only rows that differ are written
 *
 * Returns true when anything changed. An idle sync performs zero writes and so
 * triggers zero useLiveQuery re-runs.
 */
export async function applyMergedPayloadToLocalDB(
  merged: SyncPayload
): Promise<boolean> {
  const local = getLocalTombstones();
  const tomb = buildTombstones((kind) => unionIds(local[kind], merged[kind]));
  if (TOMBSTONE_KINDS.some((kind) => tomb[kind] !== local[kind])) {
    // Best effort: the server already holds these tombstones and sends them again.
    saveLocalTombstones(tomb);
  }

  const deletedQuests = new Set(tomb.deletedQuestIds);
  const deletedTasks = new Set(tomb.deletedTaskIds);
  const deletedLogs = new Set(tomb.deletedLogIds);
  const deletedHabits = new Set(tomb.deletedHabitIds);
  const deletedLists = new Set(tomb.deletedListIds);

  const remoteQuests = (merged.quests ?? []).filter(
    (q): q is Quest => hasStringId(q) && !deletedQuests.has(q.id)
  );
  const remoteTasks = (merged.tasks ?? []).filter(
    (t): t is Task => hasStringId(t) && !deletedTasks.has(t.id)
  );
  const remoteLogs = (merged.timeLogs ?? []).filter(
    (l): l is TimeLog => hasStringId(l) && !deletedLogs.has(l.id)
  );
  const remoteHabits = (merged.habits ?? []).filter(
    (h): h is Habit => hasStringId(h) && !deletedHabits.has(h.id)
  );

  const remoteLists = (merged.lists ?? []).filter(
    (l): l is List => hasStringId(l) && !deletedLists.has(l.id)
  );

  const unlinkDeletedQuest = <T extends { questId: string | null }>(row: T): T =>
    row.questId && deletedQuests.has(row.questId) ? { ...row, questId: null } : row;

  const tables = [db.quests, db.tasks, db.timeLogs, db.habits, db.lists];
  return db.transaction("rw", tables, async () => {
    const [
      localQuests,
      localTasks,
      localLogs,
      localHabits,
      questDeletes,
      taskDeletes,
      logDeletes,
      habitDeletes,
      localLists,
      listDeletes,
    ] = await Promise.all([
      db.quests.bulkGet(remoteQuests.map((q) => q.id)),
      db.tasks.bulkGet(remoteTasks.map((t) => t.id)),
      db.timeLogs.bulkGet(remoteLogs.map((l) => l.id)),
      db.habits.bulkGet(remoteHabits.map((h) => h.id)),
      // Primary keys of tombstoned rows that actually exist locally.
      deletedQuests.size
        ? db.quests.where("id").anyOf(Array.from(deletedQuests)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedTasks.size
        ? db.tasks.where("id").anyOf(Array.from(deletedTasks)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedLogs.size
        ? db.timeLogs.where("id").anyOf(Array.from(deletedLogs)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedHabits.size
        ? db.habits.where("id").anyOf(Array.from(deletedHabits)).primaryKeys()
        : Promise.resolve([] as string[]),
      db.lists.bulkGet(remoteLists.map((l) => l.id)),
      deletedLists.size
        ? db.lists.where("id").anyOf(Array.from(deletedLists)).primaryKeys()
        : Promise.resolve([] as string[]),
    ]);

    const questPuts: Quest[] = [];
    remoteQuests.forEach((remote, i) => {
      const current = localQuests[i];
      if (!current) {
        questPuts.push(remote);
        return;
      }
      // R1: newer wins; equal stamps → deterministic content tie-break.
      const winner = pickRowWinner(
        current,
        questOrHabitRowStamp(current),
        remote,
        questOrHabitRowStamp(remote)
      );
      if (winner !== current && !sameRow(winner, current)) questPuts.push(winner);
    });

    const taskPuts: Task[] = [];
    remoteTasks.forEach((remote, i) => {
      const current = localTasks[i];
      if (!current) {
        taskPuts.push(unlinkDeletedQuest(remote));
        return;
      }
      // R1 compares the rows AFTER questId sanitising (as the server does).
      const localRow = unlinkDeletedQuest(current);
      const remoteRow = unlinkDeletedQuest(remote);
      const winner = pickRowWinner(
        localRow,
        taskRowStamp(localRow),
        remoteRow,
        taskRowStamp(remoteRow)
      );
      const seconds = Math.max(
        current.accumulatedSeconds || 0,
        remote.accumulatedSeconds || 0
      );
      const next: Task =
        (winner.accumulatedSeconds || 0) === seconds
          ? winner
          : { ...winner, accumulatedSeconds: seconds };
      if (!sameRow(next, current)) taskPuts.push(next);
    });

    const logPuts: TimeLog[] = [];
    remoteLogs.forEach((remote, i) => {
      const current = localLogs[i];
      if (!current) {
        logPuts.push(remote);
        return;
      }
      // R2: the remote version replaces ours only if it differs AND wins.
      if (!sameRow(remote, current) && pickLogWinner(current, remote) === remote) {
        logPuts.push(remote);
      }
    });

    const habitPuts: Habit[] = [];
    remoteHabits.forEach((remote, i) => {
      const current = localHabits[i];
      if (!current) {
        habitPuts.push(unlinkDeletedQuest(remote));
        return;
      }
      const localRow = unlinkDeletedQuest(current);
      const remoteRow = unlinkDeletedQuest(remote);
      const winner = pickRowWinner(
        localRow,
        questOrHabitRowStamp(localRow),
        remoteRow,
        questOrHabitRowStamp(remoteRow)
      );
      if (winner !== current && !sameRow(winner, current)) habitPuts.push(winner);
    });

    // R1 on the whole List row (its items merge with it).
    const listPuts: List[] = [];
    remoteLists.forEach((remote, i) => {
      const current = localLists[i];
      if (!current) {
        listPuts.push(remote);
        return;
      }
      const winner = pickRowWinner(current, questOrHabitRowStamp(current), remote, questOrHabitRowStamp(remote));
      if (winner !== current && !sameRow(winner, current)) listPuts.push(winner);
    });

    if (questDeletes.length) await db.quests.bulkDelete(questDeletes);
    if (taskDeletes.length) await db.tasks.bulkDelete(taskDeletes);
    if (logDeletes.length) await db.timeLogs.bulkDelete(logDeletes);
    if (habitDeletes.length) await db.habits.bulkDelete(habitDeletes);
    if (questPuts.length) await db.quests.bulkPut(questPuts);
    if (taskPuts.length) await db.tasks.bulkPut(taskPuts);
    if (logPuts.length) await db.timeLogs.bulkPut(logPuts);
    if (habitPuts.length) await db.habits.bulkPut(habitPuts);
    if (listDeletes.length) await db.lists.bulkDelete(listDeletes);
    if (listPuts.length) await db.lists.bulkPut(listPuts);

    return (
      questDeletes.length +
        taskDeletes.length +
        logDeletes.length +
        habitDeletes.length +
        questPuts.length +
        taskPuts.length +
        logPuts.length +
        habitPuts.length +
        listDeletes.length +
        listPuts.length >
      0
    );
  });
}

/** An imported snapshot is not JSON or not a sync payload; nothing was written. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

/**
 * Merges an imported JSON snapshot string directly into local IndexedDB (for offline sync).
 * Throws SnapshotFormatError for unparseable or invalid input (before touching
 * IndexedDB); storage errors propagate unchanged.
 */
export async function importAndMergeSnapshotJson(
  jsonText: string,
  currentFocus: ActiveFocusState
): Promise<SyncPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new SnapshotFormatError("Not valid JSON");
  }
  const check = validateSyncPayload(parsed);
  if (!check.valid) {
    throw new SnapshotFormatError(check.error);
  }
  const local = await buildLocalSyncPayload(currentFocus);
  const merged = mergeSyncPayloads(local, check.payload);
  await applyMergedPayloadToLocalDB(merged);
  return merged;
}
