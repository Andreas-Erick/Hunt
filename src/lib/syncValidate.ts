/**
 * Boundary validation of sync payloads: every POST body and the server's own
 * stored files pass through validateSyncPayload, which drops malformed rows and
 * clamps text so a bad row never reaches the merge (syncTypes.ts).
 */
import type { ActiveFocusState, Habit, Quest, QuestAccent, Task, TaskStatus, TimeLog } from "./domainTypes";
import { toLocalDateKey } from "./dateKeys";
import { sanitizeCountDayFields, sanitizeHabitKindFields, sanitizeSlipFields } from "./habitKind";
import { sanitizeChecklist } from "./checklist";
import { isReminderTime, sanitizeHabitReminderTimes } from "./reminderTime";
import { entityIdOrNull, isSafeSyncId, MAX_ENTITY_ID_LENGTH, MAX_LOG_ID_LENGTH } from "./syncIds";
import { sanitizeHabitEnd } from "./habitEnd";
import { copyScalarExtras } from "./syncRowExtras";
import { MAX_SYNC_LISTS, sanitizeList } from "./lists";
import { sanitizeHabitFrequencyHistory } from "./habitFrequency";
import {
  clamp,
  clampText,
  finiteOr,
  isDateKey,
  isRecord,
  isStamp,
  isTableKey,
  type UnknownRecord,
} from "./syncValues";

import { MAX_TOMBSTONES_PER_KIND, type SyncPayload } from "./syncPayload";

// ---------------------------------------------------------------------------
// Boundary validation: POST bodies AND the server's own stored files
// ---------------------------------------------------------------------------

/** Longest quest title kept; longer titles are cut. */
export const MAX_QUEST_TITLE_LENGTH = 300;
/** Longest habit title kept; longer titles are cut. */
export const MAX_HABIT_TITLE_LENGTH = 300;
/** Longest task title (and log title snapshot) kept; longer ones are cut. */
export const MAX_TASK_TITLE_LENGTH = 1000;

// History is never pruned, so a count cap normal use can reach would one day
// reject every sync. These sit above what the server's 16 MB byte cap
// (MAX_PAYLOAD_BYTES in the sync route) admits, so that byte cap binds.
const MAX_SYNC_QUESTS = 5000;
/**
 * More Habits than this and the validator rejects the whole payload, so both devices refuse
 * to create one past it (ADR-0001) rather than let sync stop for good.
 */
export const MAX_SYNC_HABITS = 200;
const MAX_SYNC_TASKS = 100_000;
const MAX_SYNC_LOGS = 100_000;
export const MAX_LONG_TEXT_LENGTH = 20_000; // notes, description; localStore cuts to it too
const MAX_COUNTER_SECONDS = 1e9;
const MAX_WEEKLY_HOURS = 168;
const DEFAULT_WEEKLY_HOURS = 10;
/** 9999-12-31T00:00Z: the local date stays 4-digit-year in every time zone up to here. */
const MAX_DATE_KEY_MS = 253_402_214_400_000;

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
  "scheduledDate", "skipped", "checklist", "reminderTime", "createdAt", "updatedAt", "completedAt",
  "amount", "countTickedAt", "slips",
]);
const HABIT_FIELDS: ReadonlySet<string> = new Set([
  "id", "title", "notes", "questId", "rank", "createdAt", "updatedAt", "frequencyHistory",
  "kind", "target", "unit", "endDate", "endedSpans", "reminderTimes",
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
  // A Skipped habit day carries `skipped: true`; not Skipped is no flag at all.
  if (raw.skipped === true) task.skipped = true;
  // A habit day Task never holds a Checklist (its Outcome comes from its Habit Kind).
  if (task.habitId === undefined && Array.isArray(raw.checklist)) {
    task.checklist = sanitizeChecklist(raw.checklist);
  }
  if (isReminderTime(raw.reminderTime)) task.reminderTime = raw.reminderTime;
  if (isStamp(raw.createdAt)) task.createdAt = raw.createdAt;
  if (isStamp(raw.updatedAt)) task.updatedAt = raw.updatedAt;
  if (completedAt === null || isStamp(completedAt)) task.completedAt = completedAt;
  copyScalarExtras(Object.assign(task, sanitizeCountDayFields(raw), sanitizeSlipFields(raw)), raw, TASK_FIELDS);
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
  const frequencyHistory = sanitizeHabitFrequencyHistory(raw.frequencyHistory, raw);
  if (frequencyHistory) habit.frequencyHistory = frequencyHistory;
  const reminderTimes = sanitizeHabitReminderTimes(raw.reminderTimes);
  if (reminderTimes) habit.reminderTimes = reminderTimes;
  copyScalarExtras(Object.assign(habit, sanitizeHabitKindFields(raw), sanitizeHabitEnd(raw)), raw, HABIT_FIELDS);
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
    dateKey: isDateKey(raw.dateKey) ? raw.dateKey : toLocalDateKey(Math.min(endTime ?? startTime, MAX_DATE_KEY_MS)),
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
 * / tasks / timeLogs not arrays, or more than MAX_SYNC_QUESTS / _TASKS / _LOGS. Rows
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
  const { quests, tasks, timeLogs, habits, lists } = input;
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
  if (lists !== undefined && (!Array.isArray(lists) || lists.length > MAX_SYNC_LISTS)) {
    return { valid: false, error: "Invalid or oversized lists array" };
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
    lists: Array.isArray(lists) ? keep(lists, sanitizeList) : [],
    deletedQuestIds: sanitizeTombstones(input.deletedQuestIds, MAX_ENTITY_ID_LENGTH),
    deletedTaskIds: sanitizeTombstones(input.deletedTaskIds, MAX_ENTITY_ID_LENGTH),
    deletedLogIds: sanitizeTombstones(input.deletedLogIds, MAX_LOG_ID_LENGTH),
    deletedHabitIds: sanitizeTombstones(input.deletedHabitIds, MAX_ENTITY_ID_LENGTH),
    deletedListIds: sanitizeTombstones(input.deletedListIds, MAX_ENTITY_ID_LENGTH),
    activeFocus: sanitizeFocus(input.activeFocus),
    lastSyncedAt: Date.now(),
  };
  return { valid: true, payload, dropped };
}
