import { db, loadSortedQuests } from "./db";
import { applyChecklistEdit, type ChecklistEdit } from "./checklist";
import { habitTaskId, isOpenTask, toLocalDateKey } from "./dateUtils";
import type { FocusEffect } from "./focusSession";
import type { Habit, Quest, QuestAccent, Task } from "./domainTypes";
import {
  hasLocalLogTombstone,
  hasLocalTaskTombstone,
  recordDeletedHabitTombstone,
  recordDeletedLogTombstone,
  recordDeletedQuestTombstone,
  recordDeletedTaskTombstone,
} from "./syncTombstones";
import {
  compareRank,
  MAX_HABIT_TITLE_LENGTH,
  MAX_LONG_TEXT_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
} from "./syncTypes";
import {
  buildBurstLog,
  buildHabitTaskRow,
  completeTaskRow,
  nextStamp,
  planRankMoves,
  RANK_STEP,
  rankValue,
  sessionLogId,
} from "./taskQueue";

export { nextStamp };

/**
 * The Local Store: every write this device makes to its own IndexedDB data.
 *
 * Each operation applies the write invariants itself, so callers never repeat
 * them:
 * - R6 stamps: a write to an existing row is never older than the row it
 *   replaces, so the edit cannot silently lose last-write-wins on the next sync;
 * - deletions record their sync tombstone INSIDE the same Dexie transaction,
 *   before the delete: if the tombstone cannot be saved the transaction rolls
 *   back, so a deleted row can never come back through a sync;
 * - an operation that wrote anything emits ONE local-change signal (see
 *   onLocalChange), which the sync scheduler turns into a debounced sync.
 *
 * Operations reject on a storage failure; the command store reports it.
 * Rows written by the sync engine (remote payloads) do not go through here.
 */

/** Options for operations that the sync path also runs. */
export interface LocalWriteOptions {
  /**
   * Emit the local-change signal (default true). The sync path passes false:
   * its own rerun pushes what it wrote, so a debounced extra sync is not needed.
   */
  notify?: boolean;
}

type LocalChangeListener = () => void;
const listeners = new Set<LocalChangeListener>();

/** Subscribes to local writes; returns the unsubscribe function. */
export function onLocalChange(listener: LocalChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitChange(options?: LocalWriteOptions): void {
  if (options?.notify === false) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A listener must not turn a successful write into a failed action.
    }
  }
}

/** Emits the signal when `wrote` is truthy; returns `wrote`. */
function changed<T>(wrote: T, options?: LocalWriteOptions): T {
  if (wrote) emitChange(options);
  return wrote;
}

/**
 * Trimmed `title` cut to at most `max` UTF-16 units without splitting a
 * surrogate pair (the same cut the sync validator applies), so the server
 * never has to change a title saved here.
 */
export function clampTitle(title: string, max: number): string {
  return clampLength(title.trim(), max);
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair (not trimmed). */
export function clampLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function newId(prefix: string, now: number): string {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Writes `changes` (or `changes(row)`; null writes nothing) to an existing task with an R6 stamp,
 * reading the row in the same rw transaction (so a flush or sync that just wrote it is seen).
 * Returns false when the task does not exist or nothing was written.
 */
async function writeTask(
  taskId: string,
  changes: Partial<Omit<Task, "id" | "updatedAt">> | ((row: Task) => Partial<Task> | null)
): Promise<boolean> {
  return db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(taskId);
    const patch = row && (typeof changes === "function" ? changes(row) : changes);
    if (!row || !patch) return false;
    await db.tasks.update(taskId, { ...patch, updatedAt: nextStamp(row) });
    return true;
  });
}

/**
 * Moves every task (only OPEN ones with `openOnly`) and every daily habit of a
 * quest to Other work. Must run inside a rw transaction over tasks + habits.
 */
async function detachFromQuest(
  questId: string,
  { openOnly, todayKey }: { openOnly: boolean; todayKey: string }
): Promise<void> {
  const linkedTasks = await db.tasks.where("questId").equals(questId).toArray();
  for (const t of linkedTasks) {
    if (openOnly && !isOpenTask(t, todayKey)) continue;
    await db.tasks.update(t.id, { questId: null, updatedAt: nextStamp(t) });
  }
  const linkedHabits = await db.habits.where("questId").equals(questId).toArray();
  for (const h of linkedHabits) {
    await db.habits.update(h.id, { questId: null, updatedAt: nextStamp(h) });
  }
}

// ── Tasks ────────────────────────────────────────────────────────────────

/** Adds a queued task at the top (or bottom) of the open queue. False for an empty title. */
async function createTask(params: {
  title: string;
  notes?: string;
  questId: string | null;
  promoteToTop?: boolean;
  scheduledDate?: string;
}): Promise<boolean> {
  const { notes = "", questId, promoteToTop = true, scheduledDate } = params;
  const title = clampTitle(params.title, MAX_TASK_TITLE_LENGTH);
  if (!title) return false;
  const queued = (
    await db.tasks.where("status").anyOf(["queued", "active"]).toArray()
  ).sort(compareRank);
  let rank = RANK_STEP;
  if (queued.length > 0) {
    // Only the new row gets a rank; no other row is touched. Negative ranks are
    // fine (all sorts and the Dexie index are numeric). A synced row may lack a
    // rank (it sorts as 0), so rankValue keeps this finite.
    rank = promoteToTop
      ? rankValue(queued[0]) - RANK_STEP
      : rankValue(queued[queued.length - 1]) + RANK_STEP;
  }
  const now = Date.now();
  await db.tasks.add({
    id: newId("tsk", now),
    title,
    notes: clampTitle(notes, MAX_LONG_TEXT_LENGTH),
    questId,
    status: "queued",
    rank,
    accumulatedSeconds: 0,
    scheduledDate: scheduledDate ?? toLocalDateKey(now),
    createdAt: now,
    updatedAt: now,
  });
  return changed(true);
}

/**
 * Edits a task. The title is trimmed and cut to MAX_TASK_TITLE_LENGTH; an empty
 * one keeps the old title. False when the task does not exist.
 */
async function updateTask(
  taskId: string,
  updates: Partial<{ title: string; notes: string; questId: string | null; scheduledDate: string }>
): Promise<boolean> {
  const changes = { ...updates };
  if (typeof updates.title === "string") {
    const title = clampTitle(updates.title, MAX_TASK_TITLE_LENGTH);
    if (title) changes.title = title;
    else delete changes.title;
  }
  // Same cut the sync validator applies, so the server never shortens notes
  // saved here (an equal-stamp tie-break would then overwrite the local copy).
  if (typeof updates.notes === "string") changes.notes = clampLength(updates.notes, MAX_LONG_TEXT_LENGTH);
  return changed(await writeTask(taskId, changes));
}

/** One Checklist edit by the shared rule (the phone's too); false when refused, e.g. on a habit day Task. */
async function editChecklist(taskId: string, edit: ChecklistEdit): Promise<boolean> {
  return changed(await writeTask(taskId, (row) => {
    const checklist = applyChecklistEdit(row, edit);
    return checklist && { checklist };
  }));
}

/**
 * Completes a task with the shared rule (completeTaskRow, the phone's too),
 * reading the row in the same rw transaction. False when it does not exist.
 */
async function completeTask(taskId: string, completedAt: number = Date.now()): Promise<boolean> {
  const done = await db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(taskId);
    if (!row) return false;
    await db.tasks.update(taskId, { ...completeTaskRow(row, completedAt) });
    return true;
  });
  return changed(done);
}

async function reopenTask(taskId: string): Promise<boolean> {
  return changed(await writeTask(taskId, { status: "queued", completedAt: undefined }));
}

/** Deletes a task here and, through its tombstone, on every synced device. */
async function deleteTask(taskId: string): Promise<void> {
  await db.transaction("rw", db.tasks, async () => {
    recordDeletedTaskTombstone(taskId);
    await db.tasks.delete(taskId);
  });
  emitChange();
}

/**
 * Puts the given tasks in this order by rewriting as FEW rows as possible
 * (planRankMoves). Every rewritten row is a whole-row last-write-wins over the
 * phone's copy, so touching rows the user did not move would revert edits made
 * there while apart. Returns the number of rows written.
 */
async function reorderTasks(orderedTaskIds: string[], movedTaskId?: string): Promise<number> {
  const count = await db.transaction("rw", db.tasks, async () => {
    const ids = Array.from(new Set(orderedTaskIds));
    const rows = (await db.tasks.bulkGet(ids)).filter((row): row is Task => !!row);
    const plan = planRankMoves(rows, movedTaskId);
    const updates = rows.flatMap((row) => {
      const rank = plan.get(row.id);
      return rank === undefined ? [] : [{ ...row, rank, updatedAt: nextStamp(row) }];
    });
    if (updates.length > 0) await db.tasks.bulkPut(updates);
    return updates.length;
  });
  return changed(count);
}

// ── Focus effects ────────────────────────────────────────────────────────

/**
 * Logs a running burst into a TimeLog and adds it to the task's
 * accumulatedSeconds. Returns the seconds logged (0 when nothing was logged,
 * also for a missing or non-finite session start).
 *
 * `endAt` is the session's end (default: now); R4 passes an earlier end when
 * the session was replaced on another device before we found out.
 *
 * Atomic and idempotent (shared rule R3): nothing is logged or counted when the
 * session's log id exists or is tombstoned, or any log has the same task +
 * startTime (e.g. logged by the phone, or by a concurrent flush here).
 */
async function flushBurst(
  taskId: string,
  sessionStartedAt: number | null,
  endAt?: number,
  options?: LocalWriteOptions
): Promise<number> {
  if (!sessionStartedAt || !Number.isFinite(sessionStartedAt)) return 0;
  const logId = sessionLogId(taskId, sessionStartedAt);
  if (hasLocalLogTombstone(logId)) return 0;

  const seconds = await db.transaction("rw", db.tasks, db.quests, db.timeLogs, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return 0;
    if (await db.timeLogs.get(logId)) return 0;
    const alreadyLogged = await db.timeLogs
      .where("taskId")
      .equals(taskId)
      .filter((l) => l.startTime === sessionStartedAt)
      .count();
    if (alreadyLogged > 0) return 0;

    const end = typeof endAt === "number" && Number.isFinite(endAt) ? endAt : Date.now();
    const quest = task.questId ? await db.quests.get(task.questId) : undefined;
    const log = buildBurstLog(task, quest, sessionStartedAt, end);

    await db.tasks.update(taskId, {
      accumulatedSeconds: (task.accumulatedSeconds || 0) + log.durationSeconds,
      updatedAt: nextStamp(task),
    });
    await db.timeLogs.add(log);
    return log.durationSeconds;
  });
  return changed(seconds, options);
}

/** Sets an 'active' task back to 'queued'. Returns true if a row was written. */
async function requeueIfActive(taskId: string, options?: LocalWriteOptions): Promise<boolean> {
  const wrote = await db.transaction("rw", db.tasks, async () => {
    const task = await db.tasks.get(taskId);
    if (!task || task.status !== "active") return false;
    await db.tasks.update(taskId, { status: "queued", updatedAt: nextStamp(task) });
    return true;
  });
  return changed(wrote, options);
}

/**
 * Applies a focus transition's effects in order. Returns whether any row was
 * written (a flush that logged, a requeue or a status change).
 */
async function applyFocusEffects(
  effects: readonly FocusEffect[],
  options?: LocalWriteOptions
): Promise<boolean> {
  let wrote = false;
  for (const effect of effects) {
    switch (effect.kind) {
      case "flush":
        if ((await flushBurst(effect.taskId, effect.sessionStartedAt, effect.endAt, options)) > 0) {
          wrote = true;
        }
        break;
      case "requeueIfActive":
        if (await requeueIfActive(effect.taskId, options)) wrote = true;
        break;
      case "markQueued":
        if (changed(await writeTask(effect.taskId, { status: "queued" }), options)) wrote = true;
        break;
      case "markActive":
        if (changed(await writeTask(effect.taskId, { status: "active" }), options)) wrote = true;
        break;
    }
  }
  return wrote;
}

// ── Quests ───────────────────────────────────────────────────────────────

/** Quest fields the edit drawer can change. */
export type QuestChanges = Partial<
  Pick<Quest, "title" | "description" | "accentColor" | "targetWeeklyHours">
>;

async function createQuest(params: {
  title: string;
  description?: string;
  accentColor?: QuestAccent;
  targetWeeklyHours?: number;
}): Promise<boolean> {
  const { description = "", accentColor = "cyan", targetWeeklyHours = 10 } = params;
  const title = clampTitle(params.title, MAX_QUEST_TITLE_LENGTH);
  if (!title) return false;
  const now = Date.now();
  const existing = await loadSortedQuests();
  const activeCount = existing.filter((q) => !q.archived).length;
  await db.quests.add({
    id: newId("quest", now),
    slotIndex: (activeCount % 3) as 0 | 1 | 2,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: clampTitle(description, MAX_LONG_TEXT_LENGTH),
    accentColor,
    targetWeeklyHours: Math.max(1, Number(targetWeeklyHours) || 10),
    archived: false,
    createdAt: now,
    updatedAt: now,
  });
  return changed(true);
}

/**
 * The title is trimmed and cut to MAX_QUEST_TITLE_LENGTH (an empty one keeps
 * the old title); a finite targetWeeklyHours is floored at 1, a non-finite one
 * ignored. False when the quest does not exist.
 */
async function updateQuest(questId: string, changes: QuestChanges): Promise<boolean> {
  const patch: QuestChanges = {};
  if (typeof changes.title === "string") {
    const title = clampTitle(changes.title, MAX_QUEST_TITLE_LENGTH);
    if (title) patch.title = title;
  }
  if (typeof changes.description === "string") patch.description = clampTitle(changes.description, MAX_LONG_TEXT_LENGTH);
  if (changes.accentColor !== undefined) patch.accentColor = changes.accentColor;
  const hours = changes.targetWeeklyHours;
  if (typeof hours === "number" && Number.isFinite(hours)) patch.targetWeeklyHours = Math.max(1, hours);
  const wrote = await db.transaction("rw", db.quests, async () => {
    const row = await db.quests.get(questId);
    if (!row) return false;
    await db.quests.update(questId, { ...patch, updatedAt: nextStamp(row) });
    return true;
  });
  return changed(wrote);
}

/**
 * Retires a quest into Completed Quests (`archived`, `completedAt: now`). Open
 * tasks and daily habits move to Other work; completed tasks, missed daily
 * habit days and time logs keep their quest as history.
 */
async function completeQuest(questId: string): Promise<boolean> {
  const now = Date.now();
  const wrote = await db.transaction("rw", db.quests, db.tasks, db.habits, async () => {
    const quest = await db.quests.get(questId);
    if (!quest) return false;
    await db.quests.update(questId, { archived: true, completedAt: now, updatedAt: nextStamp(quest) });
    await detachFromQuest(questId, { openOnly: true, todayKey: toLocalDateKey(now) });
    return true;
  });
  return changed(wrote);
}

async function reopenQuest(questId: string): Promise<boolean> {
  const wrote = await db.transaction("rw", db.quests, async () => {
    const quest = await db.quests.get(questId);
    if (!quest) return false;
    await db.quests.update(questId, { archived: false, completedAt: undefined, updatedAt: nextStamp(quest) });
    return true;
  });
  return changed(wrote);
}

/** Deletes a quest (tombstoned); ALL its tasks and daily habits move to Other work. */
async function deleteQuest(questId: string): Promise<void> {
  await db.transaction("rw", db.quests, db.tasks, db.habits, async () => {
    recordDeletedQuestTombstone(questId);
    await detachFromQuest(questId, { openOnly: false, todayKey: toLocalDateKey() });
    await db.quests.delete(questId);
  });
  emitChange();
}

// ── Daily habits ─────────────────────────────────────────────────────────

/** Daily habit fields the edit form can change. */
export type HabitChanges = Partial<Pick<Habit, "title" | "notes" | "questId">>;

/** Adds a habit at the end and materializes today's instance (unless tombstoned). */
async function createHabit(params: { title: string; notes?: string; questId: string | null }): Promise<boolean> {
  const title = clampTitle(params.title, MAX_HABIT_TITLE_LENGTH);
  if (!title) return false;
  const now = Date.now();
  const todayKey = toLocalDateKey(now);
  await db.transaction("rw", db.habits, db.tasks, async () => {
    const existing = (await db.habits.toArray()).sort(compareRank);
    const habit: Habit = {
      id: newId("hab", now),
      title,
      notes: clampTitle(params.notes ?? "", MAX_LONG_TEXT_LENGTH),
      questId: params.questId,
      rank: existing.length > 0 ? rankValue(existing[existing.length - 1]) + RANK_STEP : RANK_STEP,
      createdAt: now,
      updatedAt: now,
    };
    await db.habits.add(habit);
    if (!hasLocalTaskTombstone(habitTaskId(habit.id, todayKey))) {
      await db.tasks.put(buildHabitTaskRow(habit, todayKey));
    }
  });
  return changed(true);
}

/**
 * Edits a habit and keeps today's OPEN instance aligned (title, quest, and the
 * notes when they were not edited on the instance). False when it does not exist.
 */
async function updateHabit(habitId: string, changes: HabitChanges): Promise<boolean> {
  const todayKey = toLocalDateKey();
  const wrote = await db.transaction("rw", db.habits, db.tasks, async () => {
    const row = await db.habits.get(habitId);
    if (!row) return false;
    const patch: Partial<Habit> = {};
    if (typeof changes.title === "string") {
      const title = clampTitle(changes.title, MAX_HABIT_TITLE_LENGTH);
      if (title) patch.title = title;
    }
    if (typeof changes.notes === "string") patch.notes = clampTitle(changes.notes, MAX_LONG_TEXT_LENGTH);
    if (changes.questId !== undefined) patch.questId = changes.questId;
    await db.habits.update(habitId, { ...patch, updatedAt: nextStamp(row) });

    const todayTaskId = habitTaskId(habitId, todayKey);
    const todayTask = await db.tasks.get(todayTaskId);
    if (todayTask && (todayTask.status === "queued" || todayTask.status === "active")) {
      const taskPatch: Partial<Task> = {};
      if (patch.title !== undefined) taskPatch.title = patch.title;
      if (patch.questId !== undefined) taskPatch.questId = patch.questId;
      if (patch.notes !== undefined && (todayTask.notes || "") === (row.notes || "")) {
        taskPatch.notes = patch.notes;
      }
      if (Object.keys(taskPatch).length > 0) {
        await db.tasks.update(todayTaskId, { ...taskPatch, updatedAt: nextStamp(todayTask) });
      }
    }
    return true;
  });
  return changed(wrote);
}

/**
 * Deletes a habit (tombstoned). Today's untouched open instance goes too, so a
 * deleted habit leaves Home right away; a completed or logged one stays as history.
 */
async function deleteHabit(habitId: string): Promise<void> {
  const todayTaskId = habitTaskId(habitId, toLocalDateKey());
  await db.transaction("rw", db.habits, db.tasks, async () => {
    recordDeletedHabitTombstone(habitId);
    await db.habits.delete(habitId);
    const todayTask = await db.tasks.get(todayTaskId);
    if (todayTask && todayTask.status === "queued" && (todayTask.accumulatedSeconds || 0) === 0) {
      recordDeletedTaskTombstone(todayTaskId);
      await db.tasks.delete(todayTaskId);
    }
  });
  emitChange();
}

/**
 * Idempotently materializes every daily habit's instance for `dateKey`,
 * skipping any whose deterministic id already exists or is tombstoned.
 * Returns the number of tasks created.
 */
async function materializeHabits(dateKey: string, options?: LocalWriteOptions): Promise<number> {
  if ((await db.habits.count()) === 0) return 0;
  const added = await db.transaction("rw", db.habits, db.tasks, async () => {
    const habits = (await db.habits.toArray()).sort(compareRank);
    if (habits.length === 0) return 0;
    const candidateIds = habits.map((h) => habitTaskId(h.id, dateKey));
    const existing = await db.tasks.bulkGet(candidateIds);
    const toAdd: Task[] = [];
    habits.forEach((habit, i) => {
      if (existing[i] || hasLocalTaskTombstone(candidateIds[i])) return;
      toAdd.push(buildHabitTaskRow(habit, dateKey));
    });
    if (toAdd.length > 0) await db.tasks.bulkPut(toAdd);
    return toAdd.length;
  });
  return changed(added, options);
}

/**
 * One habit's instance for `dateKey`, materializing the day first when it is
 * missing. Undefined when the habit is gone or the instance is tombstoned.
 */
async function ensureHabitTaskForDay(habitId: string, dateKey: string): Promise<Task | undefined> {
  const id = habitTaskId(habitId, dateKey);
  const existing = await db.tasks.get(id);
  if (existing) return existing;
  await materializeHabits(dateKey);
  return db.tasks.get(id);
}

// ── Time logs ────────────────────────────────────────────────────────────

/** Deletes a logged session here and, through its tombstone, on every synced device. */
async function deleteTimeLog(logId: string): Promise<void> {
  await db.transaction("rw", db.timeLogs, async () => {
    recordDeletedLogTombstone(logId);
    await db.timeLogs.delete(logId);
  });
  emitChange();
}

export const localStore = {
  createTask,
  updateTask,
  editChecklist,
  completeTask,
  reopenTask,
  deleteTask,
  reorderTasks,
  flushBurst,
  requeueIfActive,
  applyFocusEffects,
  createQuest,
  updateQuest,
  completeQuest,
  reopenQuest,
  deleteQuest,
  createHabit,
  updateHabit,
  deleteHabit,
  materializeHabits,
  ensureHabitTaskForDay,
  deleteTimeLog,
};
