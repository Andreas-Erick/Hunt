import type {
  ActiveFocusState,
  Habit,
  Quest,
  QuestAccent,
  Task,
  TaskStatus,
  TimeLog,
} from "./domainTypes";

export type { ActiveFocusState } from "./domainTypes";

export interface SyncPayload {
  quests: Quest[];
  tasks: Task[];
  timeLogs: TimeLog[];
  habits?: Habit[];
  deletedQuestIds?: string[];
  deletedTaskIds: string[];
  deletedLogIds: string[];
  deletedHabitIds?: string[];
  activeFocus: ActiveFocusState;
  lastSyncedAt: number;
}

/** Max ids kept per tombstone list (newest win). */
export const MAX_TOMBSTONES_PER_KIND = 5000;

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
 * SHARED RULE R1 stamp of a quest or habit row: `updatedAt ?? createdAt ?? 0`.
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
      len(payload.deletedQuestIds) +
      len(payload.deletedTaskIds) +
      len(payload.deletedLogIds) +
      len(payload.deletedHabitIds) >
    0
  );
}

export function createEmptySyncPayload(): SyncPayload {
  return {
    quests: [],
    tasks: [],
    timeLogs: [],
    habits: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    deletedHabitIds: [],
    activeFocus: {
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    },
    lastSyncedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Boundary validation: POST bodies AND the server's own stored files
// ---------------------------------------------------------------------------

/** Longest quest title kept; longer titles are cut. */
export const MAX_QUEST_TITLE_LENGTH = 300;
/** Longest habit title kept; longer titles are cut. */
export const MAX_HABIT_TITLE_LENGTH = 300;
/** Longest task title (and log title snapshot) kept; longer ones are cut. */
export const MAX_TASK_TITLE_LENGTH = 1000;
/** Longest quest/task id, quest/task tombstone, questId or log taskId accepted. */
export const MAX_ENTITY_ID_LENGTH = 128;
/** Longest time-log id or log tombstone accepted (`log-<sessionStartedAt>-<taskId>`). */
export const MAX_LOG_ID_LENGTH = 160;
/** Characters of every generated id (`tsk-<ms>-<4>`, `quest-<ms>-<4>`, `log-<ms>-<taskId>`, seeds). */
export const SAFE_ID_CHARS_RE = /^[A-Za-z0-9_.:-]+$/;
/** A safe quest/task id: same as `isSafeSyncId(value, MAX_ENTITY_ID_LENGTH)`. */
export const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** True for a non-empty id of SAFE_ID_CHARS_RE characters, at most `maxLength` long. */
export function isSafeSyncId(
  value: unknown,
  maxLength: number = MAX_ENTITY_ID_LENGTH
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_ID_CHARS_RE.test(value)
  );
}

const MAX_SYNC_QUESTS = 100;
const MAX_SYNC_HABITS = 200;
// Tasks are never pruned and habits add one row per habit per day, so a 5000 cap
// would be reached by normal use. Same count as logs: the server's 16 MB byte
// cap (MAX_PAYLOAD_BYTES in the sync route) is the limit that binds.
const MAX_SYNC_TASKS = 20000;
const MAX_SYNC_LOGS = 20000;
const MAX_LONG_TEXT_LENGTH = 20_000; // task notes, quest description
const MAX_EXTRA_TEXT_LENGTH = 10_000; // string values of fields not listed below
const MAX_COUNTER_SECONDS = 1e9;
const MAX_WEEKLY_HOURS = 168;
const DEFAULT_WEEKLY_HOURS = 10;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 9999-12-31T00:00Z: the local date stays 4-digit-year in every time zone up to here. */
const MAX_DATE_KEY_MS = 253_402_214_400_000;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const QUEST_ACCENTS: Record<QuestAccent, true> = {
  cyan: true,
  emerald: true,
  amber: true,
  purple: true,
  rose: true,
  sky: true,
  orange: true,
  lime: true,
};
const LOG_ACCENTS: Record<QuestAccent | "slate", true> = { ...QUEST_ACCENTS, slate: true };
const TASK_STATUSES: Record<TaskStatus, true> = {
  queued: true,
  active: true,
  completed: true,
  archived: true,
};

const QUEST_FIELDS: ReadonlySet<string> = new Set([
  "id", "slotIndex", "title", "description", "accentColor", "targetWeeklyHours",
  "archived", "createdAt", "updatedAt", "completedAt",
]);
const TASK_FIELDS: ReadonlySet<string> = new Set([
  "id", "title", "notes", "questId", "habitId", "status", "rank", "accumulatedSeconds",
  "scheduledDate", "createdAt", "updatedAt", "completedAt",
]);
const HABIT_FIELDS: ReadonlySet<string> = new Set([
  "id", "title", "notes", "questId", "rank", "createdAt", "updatedAt",
]);
const LOG_FIELDS: ReadonlySet<string> = new Set([
  "id", "taskId", "taskTitleSnapshot", "questId", "accentColorSnapshot", "startTime",
  "endTime", "durationSeconds", "dateKey",
]);

/*
 * Row shapes the sanitizers build. db.ts marks some fields required (or
 * non-null) that synced rows may lack: an invalid value is left out rather
 * than invented, and every reader tolerates that (a missing rank sorts as 0,
 * a missing stamp falls through to the next one, a missing endTime counts as
 * +Infinity in R2). Every field that is present has been checked; a quest's
 * code/archived and a log's questCodeSnapshot come from copyScalarExtras.
 */
type QuestRow = Omit<Quest, "description" | "createdAt" | "code" | "archived" | "completedAt"> & {
  description?: string;
  archived?: boolean;
  createdAt?: number;
  completedAt?: number | null;
};
type HabitRow = Omit<Habit, "notes" | "rank" | "createdAt"> & {
  notes?: string;
  rank?: number;
  createdAt?: number;
};
type TaskRow = Omit<Task, "notes" | "rank" | "createdAt" | "completedAt" | "scheduledDate"> & {
  notes?: string;
  rank?: number;
  createdAt?: number;
  completedAt?: number | null;
  scheduledDate?: string | null;
};
type LogRow = Omit<TimeLog, "taskTitleSnapshot" | "endTime" | "questCodeSnapshot"> & {
  taskTitleSnapshot?: string;
  endTime?: number;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-key lookup, so "constructor" or "__proto__" never match a table entry. */
function isTableKey<K extends string>(table: Record<K, true>, value: unknown): value is K {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

/** A millisecond timestamp: a finite number in [0, MAX_SAFE_INTEGER]. */
function isStamp(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY_RE.test(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function entityIdOrNull(value: unknown): string | null {
  return isSafeSyncId(value) ? value : null;
}

/** Local YYYY-MM-DD of a timestamp (same format as db.ts toLocalDateKey). */
function localDateKeyOf(timestamp: number): string {
  const d = new Date(Math.min(timestamp, MAX_DATE_KEY_MS));
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Copies the fields `known` does not list (e.g. a log's questCodeSnapshot, a
 * quest's code/archived) when the value is a scalar: a string (cut to 10,000),
 * a finite number, a boolean or null. Objects and arrays are dropped, which
 * also bounds nesting for canonicalString; __proto__/constructor/prototype are
 * never copied.
 */
function copyScalarExtras(target: object, raw: UnknownRecord, known: ReadonlySet<string>): void {
  const extras: UnknownRecord = {};
  for (const key of Object.keys(raw)) {
    if (known.has(key) || FORBIDDEN_KEYS.has(key)) continue;
    const value = raw[key];
    if (typeof value === "string") {
      extras[key] = clampText(value, MAX_EXTRA_TEXT_LENGTH);
    } else if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      extras[key] = value;
    }
  }
  Object.assign(target, extras);
}

/**
 * A new, sanitized quest row, or null when the row cannot be legitimate (not
 * an object, unsafe id, title not a string). Other fields are coerced.
 */
export function sanitizeQuest(raw: unknown): Quest | null {
  if (!isRecord(raw)) return null;
  const { id, title, slotIndex, accentColor } = raw;
  if (!isSafeSyncId(id) || typeof title !== "string") return null;
  const quest: QuestRow = {
    id,
    slotIndex: slotIndex === 1 || slotIndex === 2 ? slotIndex : 0,
    title: clampText(title, MAX_QUEST_TITLE_LENGTH),
    accentColor: isTableKey(QUEST_ACCENTS, accentColor) ? accentColor : "cyan",
    targetWeeklyHours: clamp(
      finiteOr(raw.targetWeeklyHours, DEFAULT_WEEKLY_HOURS),
      0,
      MAX_WEEKLY_HOURS
    ),
  };
  if (typeof raw.description === "string") {
    quest.description = clampText(raw.description, MAX_LONG_TEXT_LENGTH);
  }
  if (typeof raw.archived === "boolean") quest.archived = raw.archived;
  if (isStamp(raw.createdAt)) quest.createdAt = raw.createdAt;
  if (isStamp(raw.updatedAt)) quest.updatedAt = raw.updatedAt;
  if (raw.completedAt === null || isStamp(raw.completedAt)) {
    quest.completedAt = raw.completedAt;
  }
  copyScalarExtras(quest, raw, QUEST_FIELDS);
  return quest as Quest;
}

/**
 * A new, sanitized task row, or null when the row cannot be legitimate (not
 * an object, unsafe id, title not a string). Other fields are coerced.
 */
export function sanitizeTask(raw: unknown): Task | null {
  if (!isRecord(raw)) return null;
  const { id, title, status, rank, scheduledDate, completedAt } = raw;
  if (!isSafeSyncId(id) || typeof title !== "string") return null;
  const task: TaskRow = {
    id,
    title: clampText(title, MAX_TASK_TITLE_LENGTH),
    questId: entityIdOrNull(raw.questId),
    status: isTableKey(TASK_STATUSES, status) ? status : "queued",
    accumulatedSeconds: clamp(finiteOr(raw.accumulatedSeconds, 0), 0, MAX_COUNTER_SECONDS),
  };
  if (typeof raw.notes === "string") task.notes = clampText(raw.notes, MAX_LONG_TEXT_LENGTH);
  if (typeof rank === "number" && Number.isFinite(rank)) task.rank = rank;
  if (scheduledDate === null || isDateKey(scheduledDate)) task.scheduledDate = scheduledDate;
  if (isSafeSyncId(raw.habitId)) task.habitId = raw.habitId;
  if (isStamp(raw.createdAt)) task.createdAt = raw.createdAt;
  if (isStamp(raw.updatedAt)) task.updatedAt = raw.updatedAt;
  if (completedAt === null || isStamp(completedAt)) task.completedAt = completedAt;
  copyScalarExtras(task, raw, TASK_FIELDS);
  return task as Task;
}

/**
 * A new, sanitized daily habit row, or null when the row cannot be legitimate
 * (not an object, unsafe id, title not a string). Other fields are coerced.
 */
export function sanitizeHabit(raw: unknown): Habit | null {
  if (!isRecord(raw)) return null;
  const { id, title, rank } = raw;
  if (!isSafeSyncId(id) || typeof title !== "string") return null;
  const habit: HabitRow = {
    id,
    title: clampText(title, MAX_HABIT_TITLE_LENGTH),
    questId: entityIdOrNull(raw.questId),
  };
  if (typeof raw.notes === "string") habit.notes = clampText(raw.notes, MAX_LONG_TEXT_LENGTH);
  if (typeof rank === "number" && Number.isFinite(rank)) habit.rank = rank;
  if (isStamp(raw.createdAt)) habit.createdAt = raw.createdAt;
  if (isStamp(raw.updatedAt)) habit.updatedAt = raw.updatedAt;
  copyScalarExtras(habit, raw, HABIT_FIELDS);
  return habit as Habit;
}

/**
 * A new, sanitized time log, or null when the log cannot be legitimate (not
 * an object, unsafe id or taskId, durationSeconds not a finite number >= 0,
 * startTime not a timestamp). Other fields are coerced; an invalid dateKey is
 * recomputed from endTime (as both clients derive it), else from startTime.
 */
export function sanitizeLog(raw: unknown): TimeLog | null {
  if (!isRecord(raw)) return null;
  const { id, taskId, durationSeconds, startTime, accentColorSnapshot } = raw;
  if (!isSafeSyncId(id, MAX_LOG_ID_LENGTH) || !isSafeSyncId(taskId)) return null;
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return null;
  if (durationSeconds < 0 || !isStamp(startTime)) return null;
  const endTime = isStamp(raw.endTime) ? raw.endTime : undefined;
  const log: LogRow = {
    id,
    taskId,
    questId: entityIdOrNull(raw.questId),
    accentColorSnapshot: isTableKey(LOG_ACCENTS, accentColorSnapshot)
      ? accentColorSnapshot
      : "slate",
    startTime,
    durationSeconds: Math.min(durationSeconds, MAX_COUNTER_SECONDS),
    dateKey: isDateKey(raw.dateKey) ? raw.dateKey : localDateKeyOf(endTime ?? startTime),
  };
  if (endTime !== undefined) log.endTime = endTime;
  if (typeof raw.taskTitleSnapshot === "string") {
    log.taskTitleSnapshot = clampText(raw.taskTitleSnapshot, MAX_TASK_TITLE_LENGTH);
  }
  copyScalarExtras(log, raw, LOG_FIELDS);
  return log as TimeLog;
}

/** Safe ids only; the NEWEST (last) MAX_TOMBSTONES_PER_KIND are kept, so recent deletions never resurrect. */
function sanitizeTombstones(raw: unknown, maxIdLength: number): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  const values: readonly unknown[] = raw;
  for (const value of values) {
    if (isSafeSyncId(value, maxIdLength)) ids.push(value);
  }
  return ids.slice(-MAX_TOMBSTONES_PER_KIND);
}

function sanitizeFocus(raw: unknown): ActiveFocusState {
  const src: UnknownRecord = isRecord(raw) ? raw : {};
  const activeTaskId = entityIdOrNull(src.activeTaskId);
  const sessionStartedAt = isStamp(src.sessionStartedAt) ? src.sessionStartedAt : null;
  return {
    activeTaskId,
    isRunning: Boolean(src.isRunning) && activeTaskId !== null && sessionStartedAt !== null,
    sessionStartedAt,
    updatedAt: isStamp(src.updatedAt) ? src.updatedAt : 0,
  };
}

/**
 * Zero-trust check of a sync payload (a POST body, or a file the server stored).
 *
 * Only STRUCTURAL problems reject the whole payload: not a JSON object, quests
 * / tasks / timeLogs not arrays, or more than 100 / 20000 / 20000 of them. Rows
 * are rebuilt field by field by sanitizeQuest / sanitizeTask / sanitizeLog: a
 * row that cannot be legitimate is dropped (counted in `dropped`), every other
 * field is coerced, so a stored file always stays readable.
 *
 * When `valid`, `payload` is a NEW sanitized copy: use it, never the input.
 */
export type SyncPayloadValidation =
  | { valid: true; payload: SyncPayload; dropped: number; error?: undefined }
  | { valid: false; error: string; payload?: undefined; dropped?: undefined };

export function validateSyncPayload(input: unknown): SyncPayloadValidation {
  if (!isRecord(input)) {
    return { valid: false, error: "Payload must be a JSON object" };
  }
  const { quests, tasks, timeLogs, habits } = input;
  if (!Array.isArray(quests) || quests.length > MAX_SYNC_QUESTS) {
    return { valid: false, error: "Invalid or oversized quests array" };
  }
  if (!Array.isArray(tasks) || tasks.length > MAX_SYNC_TASKS) {
    return { valid: false, error: "Invalid or oversized tasks array" };
  }
  if (!Array.isArray(timeLogs) || timeLogs.length > MAX_SYNC_LOGS) {
    return { valid: false, error: "Invalid or oversized timeLogs array" };
  }
  if (habits !== undefined && (!Array.isArray(habits) || habits.length > MAX_SYNC_HABITS)) {
    return { valid: false, error: "Invalid or oversized habits array" };
  }

  let dropped = 0;
  const keep = <T>(rows: readonly unknown[], sanitize: (raw: unknown) => T | null): T[] => {
    const out: T[] = [];
    for (const raw of rows) {
      const row = sanitize(raw);
      if (row) out.push(row);
      else dropped++;
    }
    return out;
  };

  const payload: SyncPayload = {
    quests: keep(quests, sanitizeQuest),
    tasks: keep(tasks, sanitizeTask),
    timeLogs: keep(timeLogs, sanitizeLog),
    habits: Array.isArray(habits) ? keep(habits, sanitizeHabit) : [],
    deletedQuestIds: sanitizeTombstones(input.deletedQuestIds, MAX_ENTITY_ID_LENGTH),
    deletedTaskIds: sanitizeTombstones(input.deletedTaskIds, MAX_ENTITY_ID_LENGTH),
    deletedLogIds: sanitizeTombstones(input.deletedLogIds, MAX_LOG_ID_LENGTH),
    deletedHabitIds: sanitizeTombstones(input.deletedHabitIds, MAX_ENTITY_ID_LENGTH),
    activeFocus: sanitizeFocus(input.activeFocus),
    lastSyncedAt: Date.now(),
  };
  return { valid: true, payload, dropped };
}

/**
 * Deterministic 2-way CRDT-style merge between two SyncPayloads (e.g. Server & Client).
 */
export function mergeSyncPayloads(
  base: SyncPayload,
  incoming: SyncPayload
): SyncPayload {
  const now = Date.now();

  // 1. Union of tombstones
  const deletedQuestSet = new Set<string>([
    ...(base.deletedQuestIds ?? []),
    ...(incoming.deletedQuestIds ?? []),
  ]);
  const deletedTaskSet = new Set<string>([
    ...(base.deletedTaskIds ?? []),
    ...(incoming.deletedTaskIds ?? []),
  ]);
  const deletedLogSet = new Set<string>([
    ...(base.deletedLogIds ?? []),
    ...(incoming.deletedLogIds ?? []),
  ]);
  const deletedHabitSet = new Set<string>([
    ...(base.deletedHabitIds ?? []),
    ...(incoming.deletedHabitIds ?? []),
  ]);

  // 2. Merge Quests by ID (excluding deletedQuestSet)
  const questMap = new Map<string, Quest>();
  for (const q of base.quests ?? []) {
    if (!deletedQuestSet.has(q.id)) {
      questMap.set(q.id, q);
    }
  }
  for (const incQ of incoming.quests ?? []) {
    if (deletedQuestSet.has(incQ.id)) continue;
    const existing = questMap.get(incQ.id);
    if (!existing) {
      questMap.set(incQ.id, incQ);
    } else {
      const existingTs = questOrHabitRowStamp(existing);
      const incomingTs = questOrHabitRowStamp(incQ);
      // R1: newer wins; equal stamps → deterministic content tie-break.
      questMap.set(
        incQ.id,
        pickRowWinner(existing, existingTs, incQ, incomingTs)
      );
    }
  }
  const mergedQuests = Array.from(questMap.values()).sort(
    (a, b) => (Number(a.slotIndex) || 0) - (Number(b.slotIndex) || 0)
  );

  // 2b. Merge Daily Habits by ID (excluding deletedHabitSet, unlinking deleted quests)
  const habitMap = new Map<string, Habit>();
  for (const h of base.habits ?? []) {
    if (!deletedHabitSet.has(h.id)) {
      habitMap.set(h.id, {
        ...h,
        questId: h.questId && deletedQuestSet.has(h.questId) ? null : h.questId,
      });
    }
  }
  for (const incH of incoming.habits ?? []) {
    if (deletedHabitSet.has(incH.id)) continue;
    const existing = habitMap.get(incH.id);
    const sanitizedInc: Habit = {
      ...incH,
      questId:
        incH.questId && deletedQuestSet.has(incH.questId) ? null : incH.questId,
    };
    if (!existing) {
      habitMap.set(incH.id, sanitizedInc);
    } else {
      const existingTs = questOrHabitRowStamp(existing);
      const incomingTs = questOrHabitRowStamp(sanitizedInc);
      habitMap.set(
        incH.id,
        pickRowWinner(existing, existingTs, sanitizedInc, incomingTs)
      );
    }
  }
  const mergedHabits = Array.from(habitMap.values()).sort(compareRank);

  // 3. Merge Tasks by ID (excluding deletedTaskSet)
  const taskMap = new Map<string, Task>();
  for (const t of base.tasks ?? []) {
    if (!deletedTaskSet.has(t.id)) {
      taskMap.set(t.id, {
        ...t,
        questId: t.questId && deletedQuestSet.has(t.questId) ? null : t.questId,
      });
    }
  }
  for (const incT of incoming.tasks ?? []) {
    if (deletedTaskSet.has(incT.id)) continue;
    const existing = taskMap.get(incT.id);
    const sanitizedInc: Task = {
      ...incT,
      questId:
        incT.questId && deletedQuestSet.has(incT.questId) ? null : incT.questId,
    };

    if (!existing) {
      taskMap.set(incT.id, sanitizedInc);
    } else {
      const existingTs = taskRowStamp(existing);
      const incomingTs = taskRowStamp(sanitizedInc);

      // R1 (both rows are questId-sanitised at this point).
      const winner = pickRowWinner(existing, existingTs, sanitizedInc, incomingTs);
      taskMap.set(incT.id, {
        ...winner,
        accumulatedSeconds: Math.max(
          existing.accumulatedSeconds || 0,
          sanitizedInc.accumulatedSeconds || 0
        ),
      });
    }
  }

  // 4. Merge TimeLogs by ID (excluding deletedLogSet)
  const logMap = new Map<string, TimeLog>();
  for (const l of base.timeLogs ?? []) {
    if (!deletedLogSet.has(l.id)) {
      logMap.set(l.id, l);
    }
  }
  for (const incL of incoming.timeLogs ?? []) {
    if (deletedLogSet.has(incL.id)) continue;
    const existing = logMap.get(incL.id);
    // R2: two versions of one log id → the earlier end wins (deterministic).
    logMap.set(incL.id, existing ? pickLogWinner(existing, incL) : incL);
  }
  const mergedLogs = Array.from(logMap.values()).sort(
    (a, b) => b.startTime - a.startTime
  );

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
  const mergedTasks = Array.from(taskMap.values()).sort(compareRank);

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
    deletedQuestIds: Array.from(deletedQuestSet),
    deletedTaskIds: Array.from(deletedTaskSet),
    deletedLogIds: Array.from(deletedLogSet),
    deletedHabitIds: Array.from(deletedHabitSet),
    activeFocus: mergedFocus,
    lastSyncedAt: now,
  };
}
