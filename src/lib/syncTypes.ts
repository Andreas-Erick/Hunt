import type { ActiveFocusState, TimeLog } from "./domainTypes";
import type { SyncPayload } from "./syncPayload";

export type { ActiveFocusState } from "./domainTypes";
export { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT_LENGTH } from "./checklist";
export { isSafeSyncId, MAX_ENTITY_ID_LENGTH, MAX_LOG_ID_LENGTH, SAFE_ID_CHARS_RE, SAFE_ID_RE } from "./syncIds";

export { MAX_TOMBSTONES_PER_KIND, type SyncPayload } from "./syncPayload";
// Validation lives in syncValidate.ts; re-exported so callers keep one import.
export {
  MAX_HABIT_TITLE_LENGTH,
  MAX_LONG_TEXT_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_SYNC_HABITS,
  MAX_TASK_TITLE_LENGTH,
  sanitizeHabit,
  sanitizeLog,
  sanitizeQuest,
  sanitizeTask,
  validateSyncPayload,
  type SyncPayloadValidation,
} from "./syncValidate";

/**
 * JSON with object keys sorted at every level, so key order from different
 * clients does not matter; `undefined` fields are dropped exactly like JSON.
 *
 * SHARED RULE: the phone (hunt-mobile.html), this server merge and the desktop
 * use this exact function for the deterministic tie-breaks below.
 */
export function canonicalString(value: unknown): string {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const src = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = src[key];
      return out;
    }
    return val;
  }) as string;
}

/**
 * Canonical content key of a payload for change detection: see
 * canonicalString; `lastSyncedAt` is ignored (it is a transport stamp, not
 * content).
 */
export function syncContentKey(payload: SyncPayload): string {
  return canonicalString({ ...payload, lastSyncedAt: 0 });
}

/**
 * SHARED RULE R5: task order by rank, ties broken by id, so every device shows
 * equal-rank tasks (e.g. added to the bottom on two devices while apart) in the
 * same order. Use it for every sort of tasks by rank.
 */
export function compareRank(
  a: { rank?: unknown; id: string },
  b: { rank?: unknown; id: string }
): number {
  return (
    (Number(a.rank) || 0) - (Number(b.rank) || 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Cheap exact-content check used before the canonical tie-breaks: an idle sync
 * compares thousands of identical rows, and canonicalString on each of them is
 * ~10x slower than this. `true` only when both rows have the same defined keys
 * with equal values (nested values compared by plain JSON), which implies equal
 * canonicalString; `false` just falls through to the exact canonical compare.
 * Same helper as `sameContent` in hunt-mobile.html.
 */
export function sameContent(a: object, b: object, skipKey?: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  let n = 0;
  for (const k in ra) {
    if (k === skipKey) continue;
    const va = ra[k];
    if (va === undefined) continue;
    const vb = rb[k];
    if (
      va !== vb &&
      !(
        va &&
        vb &&
        typeof va === "object" &&
        typeof vb === "object" &&
        JSON.stringify(va) === JSON.stringify(vb)
      )
    ) {
      return false;
    }
    n++;
  }
  for (const k in rb) {
    if (k !== skipKey && rb[k] !== undefined) n--;
  }
  return n === 0;
}

/** Content key of a quest/task row for R1 (accumulatedSeconds is max()'d separately). */
function rowConflictKey(row: object): string {
  const { accumulatedSeconds: _ignored, ...rest } = row as Record<string, unknown>;
  void _ignored;
  return canonicalString(rest);
}

/**
 * SHARED RULE R1: winner of two versions of the same quest/task row, both
 * already questId-sanitised. The larger timestamp wins; on EQUAL timestamps the
 * row whose canonicalString (without accumulatedSeconds) is lexicographically
 * smaller wins, and identical content keeps `existing`. This is a total order,
 * so all devices converge on the same version instead of flapping between two
 * equal-stamp versions ("incoming wins on ties" never settles).
 *
 * Returns `existing` itself when it is kept.
 */
export function pickRowWinner<T extends object>(
  existing: T,
  existingTs: number,
  incoming: T,
  incomingTs: number
): T {
  if (incomingTs > existingTs) return incoming;
  if (incomingTs < existingTs) return existing;
  // Equal (or incomparable, e.g. NaN) stamps: deterministic content tie-break.
  if (sameContent(existing, incoming, "accumulatedSeconds")) return existing;
  const ka = rowConflictKey(existing);
  const kb = rowConflictKey(incoming);
  if (ka === kb) return existing;
  return kb < ka ? incoming : existing;
}

/** Timestamp fields R1 reads (all optional: synced rows may lack any of them). */
type StampedRow = { updatedAt?: number; completedAt?: number | null; createdAt?: number };

/**
 * SHARED RULE R1 stamp of a quest, habit or List row: `updatedAt ?? createdAt ?? 0`.
 * A quest's completedAt is NOT part of it (the phone uses the same rule).
 */
export function questOrHabitRowStamp(row: StampedRow): number {
  return row.updatedAt ?? row.createdAt ?? 0;
}

/** SHARED RULE R1 stamp of a task row: `updatedAt ?? completedAt ?? createdAt ?? 0`. */
export function taskRowStamp(row: StampedRow): number {
  return row.updatedAt ?? row.completedAt ?? row.createdAt ?? 0;
}

function logEndKey(log: TimeLog): number {
  const end = Number(log.endTime);
  return Number.isFinite(end) ? end : Infinity;
}

/**
 * SHARED RULE R2: winner of two versions of the SAME log id (the same session
 * ended on two devices). The one with the smaller endTime wins (the first end
 * is when the user really stopped; non-finite/missing counts as +Infinity);
 * equal endTime → the smaller canonicalString wins; identical → `existing`.
 *
 * Returns `existing` itself when it is kept.
 */
export function pickLogWinner(existing: TimeLog, incoming: TimeLog): TimeLog {
  const ea = logEndKey(existing);
  const eb = logEndKey(incoming);
  if (ea !== eb) return eb < ea ? incoming : existing;
  if (sameContent(existing, incoming)) return existing;
  const ka = canonicalString(existing);
  const kb = canonicalString(incoming);
  if (ka === kb) return existing;
  return kb < ka ? incoming : existing;
}

/**
 * SHARED RULE R4: end time for a LOSING running session (task `taskId`, start
 * `sessionStartedAt`) that this device learns, late, was replaced on the other
 * device. The session ends at the earliest of: now, the start of the winning
 * focus when that is a different, later running session, or the start of any
 * later log of a different session. Never before start + 1 s.
 *
 * (The winning focus's updatedAt is deliberately NOT used: a pause/clear of an
 * unrelated older session would under-count.)
 */
export function losingSessionEndAt(
  taskId: string,
  sessionStartedAt: number,
  winner: ActiveFocusState | null | undefined,
  logs: readonly TimeLog[] | null | undefined,
  now: number
): number {
  const S = sessionStartedAt;
  const cands: number[] = [now];
  if (
    winner &&
    winner.isRunning &&
    winner.sessionStartedAt &&
    !(winner.activeTaskId === taskId && winner.sessionStartedAt === S) &&
    winner.sessionStartedAt > S
  ) {
    cands.push(winner.sessionStartedAt);
  }
  for (const l of logs ?? []) {
    if (!l) continue;
    if (Number(l.startTime) > S && !(l.taskId === taskId && l.startTime === S)) {
      cands.push(Number(l.startTime));
    }
  }
  return Math.max(S + 1000, Math.min(...cands));
}

/** True when the payload holds any rows or tombstones at all. */
export function syncPayloadHasContent(payload: Partial<SyncPayload> | null | undefined): boolean {
  if (!payload) return false;
  const len = (arr: unknown) => (Array.isArray(arr) ? arr.length : 0);
  return (
    len(payload.quests) +
      len(payload.tasks) +
      len(payload.timeLogs) +
      len(payload.habits) +
      len(payload.lists) +
      len(payload.deletedQuestIds) +
      len(payload.deletedTaskIds) +
      len(payload.deletedLogIds) +
      len(payload.deletedHabitIds) +
      len(payload.deletedListIds) >
    0
  );
}

export function createEmptySyncPayload(): SyncPayload {
  return {
    quests: [],
    tasks: [],
    timeLogs: [],
    habits: [],
    lists: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    deletedHabitIds: [],
    deletedListIds: [],
    activeFocus: {
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    },
    lastSyncedAt: 0,
  };
}


/** The synced row collections. Each has its own tombstone list. */
export type SyncedEntityKey = "quests" | "tasks" | "timeLogs" | "habits" | "lists";
type SyncedRow<K extends SyncedEntityKey> = NonNullable<SyncPayload[K]>[number];

/** Payload key of each collection's tombstone list. */
export const TOMBSTONE_KEY = {
  quests: "deletedQuestIds",
  tasks: "deletedTaskIds",
  timeLogs: "deletedLogIds",
  habits: "deletedHabitIds",
  lists: "deletedListIds",
} as const satisfies Record<SyncedEntityKey, keyof SyncPayload>;

export const SYNCED_ENTITY_KEYS = Object.keys(TOMBSTONE_KEY) as SyncedEntityKey[];

/** How one collection merges. Rows whose id is tombstoned on either side are dropped first. */
interface EntityMergeSpec<Row extends { id: string }> {
  /** Applied to every surviving row from both sides (e.g. unlink a deleted quest). */
  normalize?: (row: Row) => Row;
  /** Picks the stored version when both sides hold the same id. */
  resolve: (existing: Row, incoming: Row) => Row;
  /** Output order. */
  order: (a: Row, b: Row) => number;
}

type EntityMergeSpecs = { [K in SyncedEntityKey]: EntityMergeSpec<SyncedRow<K>> };

/** Base rows first, then incoming rows resolved against them; tombstoned ids never enter. */
function mergeRowsById<Row extends { id: string }>(
  baseRows: readonly Row[] | undefined,
  incomingRows: readonly Row[] | undefined,
  deleted: ReadonlySet<string>,
  spec: EntityMergeSpec<Row>
): Map<string, Row> {
  const normalize = spec.normalize ?? ((row: Row) => row);
  const rows = new Map<string, Row>();
  for (const row of baseRows ?? []) {
    if (!deleted.has(row.id)) rows.set(row.id, normalize(row));
  }
  for (const raw of incomingRows ?? []) {
    if (deleted.has(raw.id)) continue;
    const incoming = normalize(raw);
    const existing = rows.get(raw.id);
    rows.set(raw.id, existing ? spec.resolve(existing, incoming) : incoming);
  }
  return rows;
}

/**
 * Deterministic 2-way merge of two SyncPayloads (server file + posting client).
 * Commutative, associative and idempotent (syncProperties.test.ts); rules R1–R6
 * are documented on the helpers above. Adding a synced collection means adding
 * it to SyncPayload, TOMBSTONE_KEY and the `specs` table below: tsc rejects a
 * table that misses one.
 */
export function mergeSyncPayloads(
  base: SyncPayload,
  incoming: SyncPayload
): SyncPayload {
  const now = Date.now();

  // 1. Union of tombstones, per collection.
  const deleted = {} as Record<SyncedEntityKey, Set<string>>;
  for (const key of SYNCED_ENTITY_KEYS) {
    const tombstoneKey = TOMBSTONE_KEY[key];
    deleted[key] = new Set<string>([...(base[tombstoneKey] ?? []), ...(incoming[tombstoneKey] ?? [])]);
  }

  // Rows pointing at a deleted quest move to "no quest" (a copy, never the input row).
  const unlinkDeletedQuest = <Row extends { questId?: string | null }>(row: Row): Row => ({
    ...row,
    questId: row.questId && deleted.quests.has(row.questId) ? null : row.questId,
  });

  // 2. Per-collection rules.
  const specs: EntityMergeSpecs = {
    // R1: newer wins; equal stamps → deterministic content tie-break.
    quests: {
      resolve: (a, b) => pickRowWinner(a, questOrHabitRowStamp(a), b, questOrHabitRowStamp(b)),
      order: (a, b) => (Number(a.slotIndex) || 0) - (Number(b.slotIndex) || 0),
    },
    habits: {
      normalize: unlinkDeletedQuest,
      resolve: (a, b) => pickRowWinner(a, questOrHabitRowStamp(a), b, questOrHabitRowStamp(b)),
      order: compareRank,
    },
    // R1, the whole List row (its items merge with it).
    lists: {
      resolve: (a, b) => pickRowWinner(a, questOrHabitRowStamp(a), b, questOrHabitRowStamp(b)),
      order: compareRank,
    },
    // R1 on the questId-sanitised rows; the focus counter only grows (max).
    tasks: {
      normalize: unlinkDeletedQuest,
      resolve: (a, b) => ({
        ...pickRowWinner(a, taskRowStamp(a), b, taskRowStamp(b)),
        accumulatedSeconds: Math.max(a.accumulatedSeconds || 0, b.accumulatedSeconds || 0),
      }),
      order: compareRank,
    },
    // R2: two versions of one log id → the earlier end wins (deterministic).
    timeLogs: {
      resolve: pickLogWinner,
      order: (a, b) => b.startTime - a.startTime,
    },
  };

  const questMap = mergeRowsById(base.quests, incoming.quests, deleted.quests, specs.quests);
  const habitMap = mergeRowsById(base.habits, incoming.habits, deleted.habits, specs.habits);
  const listMap = mergeRowsById(base.lists, incoming.lists, deleted.lists, specs.lists);
  const taskMap = mergeRowsById(base.tasks, incoming.tasks, deleted.tasks, specs.tasks);
  const logMap = mergeRowsById(base.timeLogs, incoming.timeLogs, deleted.timeLogs, specs.timeLogs);

  const mergedQuests = Array.from(questMap.values()).sort(specs.quests.order);
  const mergedHabits = Array.from(habitMap.values()).sort(specs.habits.order);
  const mergedLogs = Array.from(logMap.values()).sort(specs.timeLogs.order);

  // 4b. A task's counter must never be lower than the time actually logged for
  // it. Concurrent offline bursts on two devices collapse under max() above,
  // while their logs are unioned; raise (never lower) to the logged total.
  const loggedByTask = new Map<string, number>();
  for (const l of mergedLogs) {
    if (!l.taskId) continue;
    loggedByTask.set(
      l.taskId,
      (loggedByTask.get(l.taskId) ?? 0) + (Number(l.durationSeconds) || 0)
    );
  }
  loggedByTask.forEach((logged, taskId) => {
    const t = taskMap.get(taskId);
    if (t && logged > (t.accumulatedSeconds || 0)) {
      taskMap.set(taskId, { ...t, accumulatedSeconds: logged });
    }
  });
  const mergedTasks = Array.from(taskMap.values()).sort(specs.tasks.order);

  // 5. Merge Active Focus State
  const baseFocus = base.activeFocus ?? {
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    updatedAt: 0,
  };
  const incFocus = incoming.activeFocus ?? {
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    updatedAt: 0,
  };

  let mergedFocus =
    (incFocus.updatedAt ?? 0) >= (baseFocus.updatedAt ?? 0)
      ? incFocus
      : baseFocus;

  // NOTE: no focus-burst flushing here. This merge runs on the server, where
  // `base` holds another device's last-posted session that may still be
  // running offline on that device; only the owning device may flush it.
  if (mergedFocus.activeTaskId) {
    const activeTask = taskMap.get(mergedFocus.activeTaskId);
    if (!activeTask || activeTask.status === "completed") {
      // Deterministic reset stamp (not `now`): strictly newer than the focus it
      // clears and the completion that caused it, but older than any focus a
      // user starts while this sync is in flight, so it cannot cancel that.
      mergedFocus = {
        activeTaskId: null,
        isRunning: false,
        sessionStartedAt: null,
        updatedAt:
          Math.max(
            mergedFocus.updatedAt || 0,
            activeTask ? activeTask.completedAt || activeTask.updatedAt || 0 : 0
          ) + 1,
      };
    }
  }

  return {
    quests: mergedQuests,
    tasks: mergedTasks,
    timeLogs: mergedLogs,
    habits: mergedHabits,
    lists: Array.from(listMap.values()).sort(specs.lists.order),
    deletedQuestIds: Array.from(deleted.quests),
    deletedTaskIds: Array.from(deleted.tasks),
    deletedLogIds: Array.from(deleted.timeLogs),
    deletedHabitIds: Array.from(deleted.habits),
    deletedListIds: Array.from(deleted.lists),
    activeFocus: mergedFocus,
    lastSyncedAt: now,
  };
}
