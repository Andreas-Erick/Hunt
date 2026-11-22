import { TOMBSTONE_STORAGE_KEY } from "./domainTypes";
import { asRecord } from "./jsonRecord";
import { MAX_TOMBSTONES_PER_KIND, type SyncPayload } from "./syncTypes";

/**
 * This device's deletion tombstones, kept in localStorage (bounded per kind)
 * and sent with every sync so a deleted row cannot come back from the server.
 */

/** The tombstone lists of a SyncPayload, one per deletable kind. */
export const TOMBSTONE_KINDS = [
  "deletedQuestIds",
  "deletedTaskIds",
  "deletedLogIds",
  "deletedHabitIds",
] as const satisfies readonly (keyof SyncPayload)[];

export type TombstoneKind = (typeof TOMBSTONE_KINDS)[number];
export type TombstoneStore = Record<TombstoneKind, string[]>;

/** Builds a store from one list per kind (the compiler requires every kind here). */
export function buildTombstones(listFor: (kind: TombstoneKind) => string[]): TombstoneStore {
  return {
    deletedQuestIds: listFor("deletedQuestIds"),
    deletedTaskIds: listFor("deletedTaskIds"),
    deletedLogIds: listFor("deletedLogIds"),
    deletedHabitIds: listFor("deletedHabitIds"),
  };
}

function emptyTombstones(): TombstoneStore {
  return buildTombstones(() => []);
}

export function getLocalTombstones(): TombstoneStore {
  if (typeof window === "undefined") return emptyTombstones();
  try {
    const raw = window.localStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) return emptyTombstones();
    const parsed = asRecord(JSON.parse(raw));
    return buildTombstones((kind) => {
      const list: unknown = parsed[kind];
      return Array.isArray(list)
        ? list.filter((x): x is string => typeof x === "string").slice(-MAX_TOMBSTONES_PER_KIND)
        : [];
    });
  } catch {
    return emptyTombstones();
  }
}

/** Persists the (bounded) store; false when localStorage refused it (quota, blocked). */
export function saveLocalTombstones(store: TombstoneStore): boolean {
  if (typeof window === "undefined") return false;
  const bounded = buildTombstones((kind) => store[kind].slice(-MAX_TOMBSTONES_PER_KIND));
  try {
    window.localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a local deletion. Throws when the tombstone cannot be saved: the
 * caller must then NOT delete the row, or the next sync would bring it back
 * from the server (no row and no tombstone are sent).
 */
function recordTombstone(kind: TombstoneKind, id: string): void {
  const current = getLocalTombstones();
  if (current[kind].includes(id)) return;
  current[kind].push(id);
  if (!saveLocalTombstones(current)) {
    throw new Error("Could not record the deletion in this browser's storage");
  }
}

export function recordDeletedQuestTombstone(questId: string): void {
  recordTombstone("deletedQuestIds", questId);
}

export function recordDeletedTaskTombstone(taskId: string): void {
  recordTombstone("deletedTaskIds", taskId);
}

export function recordDeletedLogTombstone(logId: string): void {
  recordTombstone("deletedLogIds", logId);
}

export function recordDeletedHabitTombstone(habitId: string): void {
  recordTombstone("deletedHabitIds", habitId);
}

/** True when this device has recorded a deletion tombstone for the task id. */
export function hasLocalTaskTombstone(taskId: string): boolean {
  return getLocalTombstones().deletedTaskIds.includes(taskId);
}

/** True when this device has recorded a deletion tombstone for the log id. */
export function hasLocalLogTombstone(logId: string): boolean {
  return getLocalTombstones().deletedLogIds.includes(logId);
}
