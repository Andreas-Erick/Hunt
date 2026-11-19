"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  db,
  habitTaskId,
  isTaskVisibleToday,
  toLocalDateKey,
  type Habit,
  type Quest,
  type QuestAccent,
  type Task,
} from "@/lib/db";
import {
  logDiagnostic,
  recordBreadcrumb,
  summarizeError,
} from "@/lib/diagnostics";
import {
  describeSyncError,
  hasLocalLogTombstone,
  hasLocalTaskTombstone,
  performServerSync,
  recordDeletedHabitTombstone,
  recordDeletedLogTombstone,
  recordDeletedQuestTombstone,
  recordDeletedTaskTombstone,
  type SyncErrorCode,
} from "@/lib/syncEngine";
import {
  compareRank,
  isSafeSyncId,
  losingSessionEndAt,
  MAX_ENTITY_ID_LENGTH,
  MAX_HABIT_TITLE_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
} from "@/lib/syncTypes";

export type HudView = "command" | "plan" | "focus" | "quests" | "habits" | "telemetry" | "guide" | "log";

export interface CompletedDirectiveFeedback {
  taskTitle: string;
  questCode: string;
  accent: QuestAccent | "slate";
  loggedSeconds: number;
  nextTaskTitle: string | null;
  timestamp: number;
}

/** Quest fields the edit drawer can change (updateQuest). */
export type QuestChanges = Partial<
  Pick<Quest, "title" | "description" | "accentColor" | "targetWeeklyHours">
>;

/** Daily habit fields the edit form can change (updateHabit). */
export type HabitChanges = Partial<Pick<Habit, "title" | "notes" | "questId">>;

interface CommandStoreState {
  activeView: HudView;
  activeTaskId: string | null;
  isRunning: boolean;
  sessionStartedAt: number | null; // Timestamp (ms) when current running burst started
  focusUpdatedAt: number;
  lastCompletedFeedback: CompletedDirectiveFeedback | null;

  // Cross-Device Sync State
  /** Time of the last successful round trip to the local sync server. */
  lastSyncedAt: number | null;
  /** The LOCAL sync server (/api/sync) answered the last attempt. Says nothing about the phone. */
  isSyncOnline: boolean;
  lanUrls: string[];
  /** When the server last heard from the phone (android / mobile-web client), or null if never. */
  phoneLastSeenAt: number | null;
  /** Error code of the last failed sync attempt, null after a success. */
  syncError: SyncErrorCode | null;
  /** Runs a sync now (single-flight; a call while one is in flight schedules ONE coalesced rerun). */
  syncNow: () => Promise<boolean>;
  /**
   * The periodic background sync: resolves false without a request while
   * auto-sync is backing off after a transient failure or paused after a
   * deterministic one (until a local edit's requestSync() or a successful
   * sync); otherwise runs syncNow(). Manual, resume and boot syncs use syncNow.
   */
  autoSync: () => Promise<boolean>;
  /** Trailing-debounced sync request (~300 ms); use after local mutations. Lifts an auto-sync pause. */
  requestSync: () => void;

  /** User-facing text of the last failed local (IndexedDB) action; not persisted. */
  actionError: string | null;
  clearActionError: () => void;

  // Navigation
  setActiveView: (view: HudView) => void;
  clearFeedback: () => void;

  // Focus & Chronometer Operations. Every action below that touches IndexedDB
  // never rejects: a failure is logged and shown through actionError.
  initializeFocus: (taskId?: string) => Promise<void>;
  engageTimer: () => void;
  suspendTimer: () => Promise<void>;
  /** Single-flight: calls while one completion runs share it. */
  completeActiveTask: () => Promise<void>;
  completeTaskById: (taskId: string) => Promise<void>;
  reopenTaskById: (taskId: string) => Promise<void>;
  returnToQueue: () => Promise<void>;

  // Queue & Task CRUD Operations
  /** Resolves to false when the local write failed (actionError is then set), true otherwise. */
  createTask: (params: {
    title: string;
    notes?: string;
    questId: string | null;
    promoteToTop?: boolean;
    scheduledDate?: string;
  }) => Promise<boolean>;
  /**
   * The title is trimmed and cut to MAX_TASK_TITLE_LENGTH; an empty one keeps
   * the old title. Resolves to false when the local write failed, true otherwise.
   */
  updateTask: (
    taskId: string,
    updates: Partial<{
      title: string;
      notes: string;
      questId: string | null;
      scheduledDate: string;
    }>
  ) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<void>;
  /**
   * Puts the given tasks in this order by rewriting as FEW rows as possible
   * (one row for a single drag). `movedTaskId` (the dragged task) is the row
   * preferred for the rewrite when several minimal choices exist.
   */
  reorderTaskQueue: (orderedTaskIds: string[], movedTaskId?: string) => Promise<void>;

  // Quest CRUD Operations
  /** Resolves to false when the local write failed (actionError is then set), true otherwise. */
  createQuest: (params: {
    title: string;
    description?: string;
    accentColor?: QuestAccent;
    targetWeeklyHours?: number;
  }) => Promise<boolean>;
  /**
   * The title is trimmed and cut to MAX_QUEST_TITLE_LENGTH; an empty one keeps
   * the old title. A finite targetWeeklyHours is floored at 1 (as createQuest);
   * a non-finite one is ignored. Resolves to false when the local write failed,
   * true otherwise.
   */
  updateQuest: (questId: string, changes: QuestChanges) => Promise<boolean>;
  deleteQuest: (questId: string) => Promise<void>;

  // Daily Habit CRUD & Materialization
  /** Resolves to false when the local write failed (actionError is then set), true otherwise. */
  createHabit: (params: {
    title: string;
    notes?: string;
    questId: string | null;
  }) => Promise<boolean>;
  updateHabit: (habitId: string, changes: HabitChanges) => Promise<boolean>;
  deleteHabit: (habitId: string) => Promise<void>;
  /**
   * Ensures every daily habit has a task materialized for `dateKey` (default: today),
   * skipping any whose deterministic id already exists or was deleted (tombstoned).
   * Returns the number of newly created tasks.
   */
  materializeDailyHabits: (dateKey?: string) => Promise<number>;

  // Time Log Operations
  /** Deletes a logged session here and, through its tombstone, on every synced device. */
  deleteTimeLog: (logId: string) => Promise<void>;
}

/** Trailing debounce for mutation-triggered syncs. */
export const SYNC_DEBOUNCE_MS = 300;
/** Auto-sync pause after the first consecutive transient failure (before jitter); doubles per failure. */
export const AUTO_SYNC_BASE_BACKOFF_MS = 5_000;
/** Longest auto-sync pause after transient failures (before jitter). */
export const AUTO_SYNC_MAX_BACKOFF_MS = 60_000;
/** Max coalesced reruns inside one syncNow() before handing over to requestSync(). */
const MAX_COALESCED_RERUNS = 3;

/**
 * Deterministic TimeLog id for one focus session. The same session flushed on
 * two devices (or twice on one) yields the same id, so the union merge keeps
 * exactly one log for it.
 */
export function sessionLogId(taskId: string, sessionStartedAt: number): string {
  return `log-${sessionStartedAt}-${taskId}`;
}

/**
 * R6: stamp for a local write to an existing row. Never older than the row it
 * replaces (the row may carry a newer stamp from a device whose clock is ahead),
 * so the edit cannot silently lose last-write-wins on the next sync.
 */
function nextStamp(row: { updatedAt?: number } | null | undefined): number {
  return Math.max(Date.now(), (row?.updatedAt || 0) + 1);
}

/** R6 for the focus state: a local focus change is always newer than the focus it replaces. */
function nextFocusStamp(get: StoreGet): number {
  return Math.max(Date.now(), (get().focusUpdatedAt || 0) + 1);
}

/**
 * Trimmed `title` cut to at most `max` UTF-16 units without splitting a
 * surrogate pair (the same cut the sync validator applies), so the server
 * never has to change a title this store saved.
 */
function clampTitle(title: string, max: number): string {
  const text = title.trim();
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Writes `changes` to an existing task with an R6 stamp, reading the row in
 * the same rw transaction (so a flush or sync that just wrote it is seen).
 * Returns false when the task does not exist.
 */
async function writeTask(
  taskId: string,
  changes: Partial<Omit<Task, "id" | "updatedAt">>
): Promise<boolean> {
  return db.transaction("rw", db.tasks, async () => {
    const row = await db.tasks.get(taskId);
    if (!row) return false;
    await db.tasks.update(taskId, { ...changes, updatedAt: nextStamp(row) });
    return true;
  });
}

/**
 * SHARED "next focus task" rule: among QUEUED tasks that are unscheduled or
 * scheduled for `todayKey` or earlier, the first quest task in rank order
 * (compareRank: rank, ties by id), else the first other task; null when none.
 * Pure: `tasks` is not modified.
 */
export function pickNextFocusTask(
  tasks: readonly Task[],
  todayKey: string
): Task | null {
  const today = tasks
    .filter((t) => t.status === "queued" && isTaskVisibleToday(t, todayKey))
    .sort(compareRank);
  return today.find((t) => t.questId !== null) ?? today[0] ?? null;
}

/**
 * Pure helper: builds the deterministic daily task row for a habit on `dateKey`.
 * Uses `updatedAt = habit.createdAt || 1` and `rank = habit.rank` so laptop and
 * phone materialize identical rows offline and any real user action wins LWW.
 */
function buildHabitTaskRow(habit: Habit, dateKey: string): Task {
  const stamp = Math.max(1, Number(habit.createdAt) || 1);
  return {
    id: habitTaskId(habit.id, dateKey),
    title: habit.title,
    notes: habit.notes || "",
    questId: habit.questId,
    habitId: habit.id,
    status: "queued",
    rank: Number.isFinite(habit.rank) ? habit.rank : RANK_STEP,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * Idempotently materializes today's daily habit tasks into IndexedDB.
 * Skips any habit whose task for `dateKey` already exists or is tombstoned.
 */
async function materializeHabitsIntoDB(dateKey: string): Promise<number> {
  return db.transaction("rw", db.habits, db.tasks, async () => {
    const habits = (await db.habits.toArray()).sort(compareRank);
    if (habits.length === 0) return 0;
    const candidateIds = habits.map((h) => habitTaskId(h.id, dateKey));
    const existing = await db.tasks.bulkGet(candidateIds);
    const toAdd: Task[] = [];
    habits.forEach((habit, i) => {
      const taskId = candidateIds[i];
      if (existing[i] || hasLocalTaskTombstone(taskId)) return;
      toAdd.push(buildHabitTaskRow(habit, dateKey));
    });
    if (toAdd.length > 0) {
      await db.tasks.bulkPut(toAdd);
    }
    return toAdd.length;
  });
}

/**
 * Flush current running burst into IndexedDB TimeLog and increment task's accumulatedSeconds.
 * Returns the burst seconds flushed (0 when nothing was flushed, also for a
 * missing or non-finite session start, so a corrupted state never logs NaN).
 *
 * `endAt` is the session's end (default: now). runSyncOnce passes an earlier
 * end when the session was replaced on another device before we found out
 * (shared rule R4, see losingSessionEndAt).
 *
 * Atomic (read-modify-write inside one rw transaction) and idempotent (shared
 * rule R3): nothing is logged or counted when the session's log id exists or is
 * tombstoned, or any log has the same task + startTime (e.g. logged by the
 * phone, or by a concurrent flush here).
 */
async function flushActiveBurst(
  taskId: string,
  sessionStartedAt: number | null,
  endAt?: number
): Promise<number> {
  if (!sessionStartedAt || !Number.isFinite(sessionStartedAt)) return 0;
  const logId = sessionLogId(taskId, sessionStartedAt);
  if (hasLocalLogTombstone(logId)) return 0;

  return db.transaction("rw", db.tasks, db.quests, db.timeLogs, async () => {
    const task = await db.tasks.get(taskId);
    if (!task) return 0;

    if (await db.timeLogs.get(logId)) return 0;
    const alreadyLogged = await db.timeLogs
      .where("taskId")
      .equals(taskId)
      .filter((l) => l.startTime === sessionStartedAt)
      .count();
    if (alreadyLogged > 0) return 0;

    const end =
      typeof endAt === "number" && Number.isFinite(endAt) ? endAt : Date.now();
    const elapsedSeconds = Math.max(1, Math.round((end - sessionStartedAt) / 1000));

    const quest = task.questId ? await db.quests.get(task.questId) : undefined;
    const questCodeSnapshot = quest ? quest.title : "Other";
    const accentColorSnapshot: QuestAccent | "slate" = quest
      ? quest.accentColor
      : "slate";

    await db.tasks.update(taskId, {
      accumulatedSeconds: (task.accumulatedSeconds || 0) + elapsedSeconds,
      updatedAt: nextStamp(task),
    });

    await db.timeLogs.add({
      id: logId,
      taskId: task.id,
      taskTitleSnapshot: task.title,
      questId: task.questId,
      questCodeSnapshot,
      accentColorSnapshot,
      startTime: sessionStartedAt,
      endTime: end,
      durationSeconds: elapsedSeconds,
      dateKey: toLocalDateKey(end),
    });

    return elapsedSeconds;
  });
}

/** Sets an 'active' task back to 'queued'. Returns true if a row was written. */
async function requeueIfActive(taskId: string): Promise<boolean> {
  return db.transaction("rw", db.tasks, async () => {
    const task = await db.tasks.get(taskId);
    if (!task || task.status !== "active") return false;
    await db.tasks.update(taskId, { status: "queued", updatedAt: nextStamp(task) });
    return true;
  });
}

/** Distance between neighbouring ranks for rows placed at the top/bottom. */
const RANK_STEP = 1000;
/** Smallest rank gap per row placed between two kept rows. */
const MIN_RANK_GAP = 1e-6;

const rankValue = (t: { rank?: unknown }): number => Number(t.rank) || 0;

/**
 * Minimal-move rank plan for showing `rows` in exactly this order (rank order
 * with ties by id, see compareRank). Returns the new rank of every row that has
 * to change; all other rows keep their rank and are not written.
 *
 * Keeps the largest set of rows whose current ranks are already in the desired
 * order (a longest increasing subsequence under compareRank, restricted to
 * choices that leave room for the rows in between) and places each other row
 * strictly between its final neighbours: a run of k rows between kept ranks a
 * and b gets a + (b - a) * j / (k + 1); above the first kept row next - 1000·j;
 * below the last prev + 1000·j. A single drag therefore rewrites one row.
 * `preferMovedId` (the dragged row) is the one rewritten when several minimal
 * plans exist. Only if no valid plan results (exhausted float precision)
 * everything is renumbered (i + 1) * 1000.
 */
export function planRankMoves(
  rows: ReadonlyArray<Pick<Task, "id" | "rank">>,
  preferMovedId?: string
): Map<string, number> {
  const n = rows.length;
  const plan = new Map<string, number>();
  if (n === 0) return plan;

  const r = rows.map(rankValue);
  // Score = 2 per kept row, 1 for keeping the preferred-to-move row: the most
  // kept rows first, then the plan that rewrites the dragged row.
  const weight: number[] = rows.map((t) => (t.id === preferMovedId ? 1 : 2));
  const canKeepBoth = (i: number, j: number): boolean => {
    const between = j - i - 1;
    if (between === 0) return compareRank(rows[i], rows[j]) < 0;
    return (r[j] - r[i]) / (between + 1) >= MIN_RANK_GAP;
  };

  // score[j]: best plan for rows[0..j] that keeps row j (rows above the first
  // kept row always fit at the top, rows below the last at the bottom).
  const score = weight.slice();
  const prev = new Array<number>(n).fill(-1);
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (score[i] + weight[j] > score[j] && canKeepBoth(i, j)) {
        score[j] = score[i] + weight[j];
        prev[j] = i;
      }
    }
  }
  let last = 0;
  for (let j = 1; j < n; j++) if (score[j] > score[last]) last = j;
  const kept: number[] = [];
  for (let j = last; j !== -1; j = prev[j]) kept.push(j);
  kept.reverse();

  const finalRank = r.slice();
  const first = kept[0];
  for (let idx = first - 1, step = 1; idx >= 0; idx--, step++) {
    finalRank[idx] = r[first] - RANK_STEP * step;
  }
  for (let m = 0; m + 1 < kept.length; m++) {
    const a = kept[m];
    const b = kept[m + 1];
    const between = b - a - 1;
    for (let j = 1; j <= between; j++) {
      finalRank[a + j] = r[a] + ((r[b] - r[a]) * j) / (between + 1);
    }
  }
  const tail = kept[kept.length - 1];
  for (let idx = tail + 1, step = 1; idx < n; idx++, step++) {
    finalRank[idx] = r[tail] + RANK_STEP * step;
  }

  const ordered =
    finalRank.every(Number.isFinite) &&
    rows.every(
      (row, i) =>
        i === 0 ||
        compareRank(
          { id: rows[i - 1].id, rank: finalRank[i - 1] },
          { id: row.id, rank: finalRank[i] }
        ) < 0
    );
  if (!ordered) {
    for (let i = 0; i < n; i++) finalRank[i] = (i + 1) * RANK_STEP;
  }

  rows.forEach((row, i) => {
    if (row.rank !== finalRank[i]) plan.set(row.id, finalRank[i]);
  });
  return plan;
}

/**
 * Global queue order after dropping `draggedId` onto `targetId` in a list that
 * shows a subset (`listIds`, in display order) of all pending tasks
 * (`allPendingIds`, in rank order). The dragged task lands next to the target
 * (before it when dragged upwards in that list, after it when dragged
 * downwards); every other task keeps its place, so reorderTaskQueue rewrites
 * exactly one row and tasks outside the list are never touched.
 * Returns null when the drop changes nothing.
 */
export function orderAfterDrop(
  allPendingIds: readonly string[],
  listIds: readonly string[],
  draggedId: string,
  targetId: string
): string[] | null {
  const from = listIds.indexOf(draggedId);
  const to = listIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const order = allPendingIds.filter((id) => id !== draggedId);
  let at = order.indexOf(targetId);
  if (at === -1) return null;
  if (to > from) at += 1;
  order.splice(at, 0, draggedId);
  return order;
}

type StoreGet = () => CommandStoreState;
type StoreSet = (partial: Partial<CommandStoreState>) => void;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  return Object.is(a, b);
}

/** set() only the fields whose value actually changed (no-op sets re-render every subscriber). */
function setChanged<K extends keyof CommandStoreState>(
  get: StoreGet,
  set: StoreSet,
  patch: Partial<Pick<CommandStoreState, K>>
): void {
  const current = get();
  const diff: Partial<Pick<CommandStoreState, K>> = {};
  let changed = false;
  for (const key in patch) {
    if (!sameValue(current[key], patch[key])) {
      diff[key] = patch[key];
      changed = true;
    }
  }
  if (changed) set(diff);
}

/** Logs a failed local action and shows the user-safe text in actionError. */
function reportActionFailure(set: StoreSet, name: string, err: unknown): void {
  recordBreadcrumb({
    level: "ERROR",
    domain: "store",
    event: "action_failed",
    context: { action: name, ...summarizeError(err) },
  });
  console.error("[hunt] action_failed", name, err);
  try {
    set({ actionError: describeSyncError("local_db") });
  } catch {
    // Only persisting the focus fields to localStorage can throw here (e.g.
    // quota); zustand has already updated the in-memory state, so the alert shows.
  }
}

/**
 * Runs a Dexie-backed action. A failure is reported (reportActionFailure) and
 * resolves to false instead of rejecting, so the UI's fire-and-forget handlers
 * never produce unhandled rejections. No retry.
 */
async function runAction(
  set: StoreSet,
  name: string,
  action: () => Promise<unknown>
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (err) {
    reportActionFailure(set, name, err);
    return false;
  }
}

/**
 * One sync round trip + local bookkeeping. Returns the failure code (null on
 * success) and whether it wrote local rows that still need to be pushed
 * (flushed burst).
 */
async function runSyncOnce(
  get: StoreGet,
  set: StoreSet
): Promise<{ error: SyncErrorCode | null; wroteLocal: boolean }> {
  const snapshot = get();
  const res = await performServerSync({
    activeTaskId: snapshot.activeTaskId,
    isRunning: snapshot.isRunning,
    sessionStartedAt: snapshot.sessionStartedAt,
    updatedAt: snapshot.focusUpdatedAt || 0,
  });

  if (!res.ok || !res.merged) {
    const error = res.error ?? "unreachable";
    setChanged(get, set, { isSyncOnline: false, syncError: error });
    return { error, wroteLocal: false };
  }

  let wroteLocal = false;
  const patch: Partial<CommandStoreState> = {
    isSyncOnline: true,
    syncError: null,
    lastSyncedAt: res.merged.lastSyncedAt || Date.now(),
  };
  if (res.lanUrls && res.lanUrls.length > 0) patch.lanUrls = res.lanUrls;
  const phoneSeen = res.peers?.phone.lastSeenAt ?? null;
  // The server keeps peers in memory only; after a server restart keep what we knew.
  if (phoneSeen !== null) patch.phoneLastSeenAt = phoneSeen;

  const remote = res.merged.activeFocus;
  const before = get();
  if (remote && (remote.updatedAt || 0) > (before.focusUpdatedAt || 0)) {
    const sameSession =
      remote.activeTaskId === before.activeTaskId &&
      remote.sessionStartedAt === before.sessionStartedAt;

    // A newer focus from a DIFFERENT session replaces ours: first flush our own
    // running burst (idempotent, so a burst the other device already logged is
    // not counted twice) and give our task back to the queue. The burst ends
    // when the other device moved on, not now (R4: we may learn it hours late).
    if (!sameSession && before.activeTaskId) {
      try {
        if (before.isRunning && before.sessionStartedAt) {
          const endAt = losingSessionEndAt(
            before.activeTaskId,
            before.sessionStartedAt,
            remote,
            res.merged.timeLogs,
            Date.now()
          );
          if (
            (await flushActiveBurst(
              before.activeTaskId,
              before.sessionStartedAt,
              endAt
            )) > 0
          ) {
            wroteLocal = true;
          }
        }
        if (remote.activeTaskId !== before.activeTaskId) {
          if (await requeueIfActive(before.activeTaskId)) wroteLocal = true;
        }
      } catch (err) {
        logDiagnostic({
          level: "ERROR",
          domain: "sync",
          event: "flush_before_remote_focus_failed",
          context: summarizeError(err),
        });
      }
    }

    // A local focus change made while we were awaiting is newer than `remote`.
    if (get().focusUpdatedAt === before.focusUpdatedAt) {
      patch.activeTaskId = remote.activeTaskId;
      patch.isRunning = remote.isRunning;
      patch.sessionStartedAt = remote.sessionStartedAt;
      patch.focusUpdatedAt = remote.updatedAt;
    }
  }

  setChanged(get, set, patch);
  // If sync brought in new habits from another device, ensure today's tasks exist.
  if (res.changed) {
    try {
      const added = await materializeHabitsIntoDB(toLocalDateKey());
      if (added > 0) wroteLocal = true;
    } catch (err) {
      console.error("[hunt] action_failed", "materializeDailyHabits", err);
    }
  }
  return { error: null, wroteLocal };
}

/**
 * Completes the focused task (completeActiveTask's body): logs its burst,
 * stamps it completed (R6, re-read after the flush), stops the focus session
 * without auto-starting the next task, and keeps Focus view open when another
 * task is queued for today so the user can choose whether to start it.
 */
async function completeFocusedTask(get: StoreGet, set: StoreSet): Promise<void> {
  const { activeTaskId, isRunning, sessionStartedAt } = get();
  if (!activeTaskId) return;

  const currentTask = await db.tasks.get(activeTaskId);
  if (!currentTask) {
    set({
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      focusUpdatedAt: nextFocusStamp(get),
    });
    get().requestSync();
    return;
  }
  // Already completed elsewhere (e.g. on the phone while this focus had not
  // synced to it): it is not completed again and gets no placeholder log, but
  // this device's running session is still logged and focus still clears.
  const alreadyCompleted = currentTask.status === "completed";

  const now = Date.now();
  let burstSeconds = 0;
  if (isRunning && sessionStartedAt) {
    burstSeconds = await flushActiveBurst(activeTaskId, sessionStartedAt);
  } else if (!alreadyCompleted && (currentTask.accumulatedSeconds || 0) === 0) {
    burstSeconds = await flushActiveBurst(activeTaskId, now - 1000);
  }

  const updatedTask = await db.tasks.get(activeTaskId);
  const totalTaskSeconds =
    updatedTask?.accumulatedSeconds ||
    currentTask.accumulatedSeconds + burstSeconds;

  const quest = currentTask.questId
    ? await db.quests.get(currentTask.questId)
    : undefined;

  const doneTs = Date.now();
  if (!alreadyCompleted) {
    await writeTask(activeTaskId, { status: "completed", completedAt: doneTs });
  }

  const nextTask = pickNextFocusTask(
    await db.tasks.where("status").equals("queued").toArray(),
    toLocalDateKey(doneTs)
  );

  const nextTs = Date.now();
  const feedback: CompletedDirectiveFeedback = {
    taskTitle: currentTask.title,
    questCode: quest ? quest.title : "Other",
    accent: quest ? quest.accentColor : "slate",
    loggedSeconds: totalTaskSeconds,
    nextTaskTitle: nextTask ? nextTask.title : null,
    timestamp: nextTs,
  };
  const currentView = get().activeView;
  set({
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: nextFocusStamp(get),
    activeView:
      currentView === "focus" ? (nextTask ? "focus" : "command") : currentView,
    lastCompletedFeedback: feedback,
  });

  get().requestSync();
}

type PersistedFocusState = Pick<
  CommandStoreState,
  "activeView" | "activeTaskId" | "isRunning" | "sessionStartedAt" | "focusUpdatedAt"
>;

const HUD_VIEWS: Readonly<Record<HudView, true>> = {
  command: true,
  plan: true,
  focus: true,
  quests: true,
  habits: true,
  telemetry: true,
  guide: true,
  log: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHudView(value: unknown): value is HudView {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HUD_VIEWS, value);
}

/** A millisecond timestamp: a finite number in [0, MAX_SAFE_INTEGER]. */
function isStamp(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Zero-trust rehydration: the five persisted fields of a stored state, each
 * validated (an invalid or missing one gets its default), with the invariant
 * isRunning ⇒ activeTaskId && sessionStartedAt. Nothing else is copied, so a
 * corrupted or tampered entry can neither replace an action nor feed NaN into
 * a flush.
 */
function sanitizePersistedFocus(persisted: Record<string, unknown>): PersistedFocusState {
  const { activeView, activeTaskId, isRunning, sessionStartedAt, focusUpdatedAt } = persisted;
  const taskId = isSafeSyncId(activeTaskId, MAX_ENTITY_ID_LENGTH) ? activeTaskId : null;
  const startedAt = isStamp(sessionStartedAt) && sessionStartedAt > 0 ? sessionStartedAt : null;
  return {
    activeView: isHudView(activeView) ? activeView : "command",
    activeTaskId: taskId,
    isRunning: isRunning === true && taskId !== null && startedAt !== null,
    sessionStartedAt: startedAt,
    focusUpdatedAt: isStamp(focusUpdatedAt) ? focusUpdatedAt : 0,
  };
}

// Module-level sync scheduler state (one store per page).
let syncInFlight: Promise<boolean> | null = null;
let syncAgain = false;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let completeInFlight: Promise<void> | null = null;
/** Failed syncs in a row (reset by a success). */
let consecutiveSyncFailures = 0;
/** autoSync() sends nothing before this time (Infinity: until requestSync() or a success). */
let autoSyncPausedUntil = 0;
/** A mutation's debounced sync joined a sync already in flight (its coalesced rerun). */
let editJoinedInFlightSync = false;

/**
 * Failures worth retrying on their own: network/timeout, local IndexedDB,
 * HTTP 408, 429 and 5xx except 507. Every other code (400, 401, 403, 413, 422,
 * 507, a bad response, ...) fails the same way until something changes.
 */
function isTransientSyncError(code: SyncErrorCode): boolean {
  if (code === "unreachable" || code === "local_db") return true;
  const m = /^http_(\d+)$/.exec(code);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 507);
}

/**
 * Auto-sync backoff after a sync attempt (`failure` null = success): transient
 * failures pause for min(60 s, 5 s · 2^(n-1)) with 50–100 % jitter,
 * deterministic ones until requestSync() or a successful sync.
 */
function recordSyncOutcome(failure: SyncErrorCode | null): void {
  if (failure === null) {
    consecutiveSyncFailures = 0;
    autoSyncPausedUntil = 0;
    return;
  }
  consecutiveSyncFailures += 1;
  if (!isTransientSyncError(failure)) {
    autoSyncPausedUntil = Infinity;
    return;
  }
  const backoff = Math.min(
    AUTO_SYNC_MAX_BACKOFF_MS,
    AUTO_SYNC_BASE_BACKOFF_MS * 2 ** (consecutiveSyncFailures - 1)
  );
  autoSyncPausedUntil = Date.now() + backoff * (0.5 + Math.random() / 2);
}

export const useCommandStore = create<CommandStoreState>()(
  persist(
    (set, get) => ({
      activeView: "command",
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      focusUpdatedAt: 0,
      lastCompletedFeedback: null,

      lastSyncedAt: null,
      isSyncOnline: false,
      lanUrls: [],
      phoneLastSeenAt: null,
      syncError: null,
      actionError: null,

      syncNow: () => {
        if (syncInFlight) {
          // Coalesce: the running sync does exactly one more pass afterwards.
          syncAgain = true;
          return syncInFlight;
        }
        if (syncDebounceTimer) {
          clearTimeout(syncDebounceTimer);
          syncDebounceTimer = null;
        }

        syncInFlight = (async () => {
          let failure: SyncErrorCode | null = null;
          try {
            let passes = 0;
            do {
              syncAgain = false;
              passes += 1;
              const result = await runSyncOnce(get, set);
              failure = result.error;
              if (failure) {
                // A rerun would fail the same way; autoSync() retries with backoff.
                syncAgain = false;
                break;
              }
              if (result.wroteLocal) syncAgain = true;
            } while (syncAgain && passes <= MAX_COALESCED_RERUNS);
          } catch (err) {
            logDiagnostic({
              level: "ERROR",
              domain: "sync",
              event: "sync_loop_failed",
              context: summarizeError(err),
            });
            failure = "local_db";
          } finally {
            syncInFlight = null;
          }
          recordSyncOutcome(failure);
          // A failed pass drops the coalesced rerun; an edit that joined it
          // still gets one attempt of its own (it may fix what failed).
          const retryForEdit = failure !== null && editJoinedInFlightSync;
          editJoinedInFlightSync = false;
          if (syncAgain || retryForEdit) {
            syncAgain = false;
            get().requestSync();
          }
          return failure === null;
        })();
        return syncInFlight;
      },

      autoSync: () =>
        Date.now() < autoSyncPausedUntil ? Promise.resolve(false) : get().syncNow(),

      requestSync: () => {
        // A local edit may be what a paused (deterministic) failure was waiting for.
        autoSyncPausedUntil = 0;
        if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(() => {
          syncDebounceTimer = null;
          if (syncInFlight) editJoinedInFlightSync = true;
          get()
            .syncNow()
            .catch(() => undefined);
        }, SYNC_DEBOUNCE_MS);
      },

      clearActionError: () => set({ actionError: null }),
      setActiveView: (view) => set({ activeView: view }),
      clearFeedback: () => set({ lastCompletedFeedback: null }),

      initializeFocus: async (requestedTaskId?: string) => {
        await runAction(set, "initializeFocus", async () => {
          const state = get();

          if (
            requestedTaskId &&
            state.activeTaskId === requestedTaskId &&
            state.isRunning &&
            state.sessionStartedAt
          ) {
            // Already running on this task: keep the session (restarting it would
            // silently drop the time since sessionStartedAt).
            set({ activeView: "focus", lastCompletedFeedback: null });
            return;
          }

          if (state.activeTaskId && state.activeTaskId !== requestedTaskId) {
            if (state.isRunning && state.sessionStartedAt) {
              await flushActiveBurst(state.activeTaskId, state.sessionStartedAt);
            }
            await requeueIfActive(state.activeTaskId);
          }

          let targetId = requestedTaskId;
          if (!targetId) {
            const queued = await db.tasks.where("status").equals("queued").toArray();
            // Nothing for today: start the first queued task of any day.
            const chosen =
              pickNextFocusTask(queued, toLocalDateKey()) ?? queued.sort(compareRank)[0];
            if (!chosen) return;
            targetId = chosen.id;
          }

          const startedAt = Date.now();
          await writeTask(targetId, { status: "active" });

          set({
            activeTaskId: targetId,
            isRunning: true,
            sessionStartedAt: startedAt,
            focusUpdatedAt: nextFocusStamp(get),
            activeView: "focus",
            lastCompletedFeedback: null,
          });

          get().requestSync();
        });
      },

      engageTimer: () => {
        try {
          const { activeTaskId, isRunning } = get();
          if (!activeTaskId || isRunning) return;
          set({
            isRunning: true,
            sessionStartedAt: Date.now(),
            focusUpdatedAt: nextFocusStamp(get),
          });
          get().requestSync();
        } catch (err) {
          reportActionFailure(set, "engageTimer", err);
        }
      },

      suspendTimer: async () => {
        await runAction(set, "suspendTimer", async () => {
          const { activeTaskId, isRunning, sessionStartedAt } = get();
          if (!activeTaskId || !isRunning) return;

          await flushActiveBurst(activeTaskId, sessionStartedAt);

          set({
            isRunning: false,
            sessionStartedAt: null,
            focusUpdatedAt: nextFocusStamp(get),
          });

          get().requestSync();
        });
      },

      completeActiveTask: () => {
        // Single-flight: a double click (or ten) completes the task once.
        if (!completeInFlight) {
          completeInFlight = runAction(set, "completeActiveTask", () =>
            completeFocusedTask(get, set)
          ).then(() => {
            completeInFlight = null;
          });
        }
        return completeInFlight;
      },

      completeTaskById: async (taskId: string) => {
        await runAction(set, "completeTaskById", async () => {
          if (get().activeTaskId === taskId) {
            await get().completeActiveTask();
            return;
          }
          await writeTask(taskId, { status: "completed", completedAt: Date.now() });
          get().requestSync();
        });
      },

      reopenTaskById: async (taskId: string) => {
        await runAction(set, "reopenTaskById", async () => {
          await writeTask(taskId, { status: "queued", completedAt: undefined });
          get().requestSync();
        });
      },

      returnToQueue: async () => {
        await runAction(set, "returnToQueue", async () => {
          const { activeTaskId, isRunning, sessionStartedAt } = get();
          if (activeTaskId) {
            if (isRunning && sessionStartedAt) {
              await flushActiveBurst(activeTaskId, sessionStartedAt);
            }
            await writeTask(activeTaskId, { status: "queued" });
          }
          set({
            activeTaskId: null,
            isRunning: false,
            sessionStartedAt: null,
            focusUpdatedAt: nextFocusStamp(get),
            activeView: "command",
          });
          get().requestSync();
        });
      },

      createTask: ({ title, notes = "", questId, promoteToTop = true, scheduledDate }) =>
        runAction(set, "createTask", async () => {
          const trimmed = clampTitle(title, MAX_TASK_TITLE_LENGTH);
          if (!trimmed) return;

          const queued = (
            await db.tasks.where("status").anyOf(["queued", "active"]).toArray()
          ).sort(compareRank);

          let newRank = RANK_STEP;
          if (queued.length > 0) {
            // Only the new row gets a rank; no other row is touched. Negative
            // ranks are fine (all sorts and the Dexie index are numeric). A synced
            // row may lack a rank (it sorts as 0), so rankValue keeps this finite.
            newRank = promoteToTop
              ? rankValue(queued[0]) - RANK_STEP
              : rankValue(queued[queued.length - 1]) + RANK_STEP;
          }

          const now = Date.now();
          await db.tasks.add({
            id: `tsk-${now}-${Math.random().toString(36).slice(2, 6)}`,
            title: trimmed,
            notes: notes.trim(),
            questId,
            status: "queued",
            rank: newRank,
            accumulatedSeconds: 0,
            scheduledDate: scheduledDate ?? toLocalDateKey(now),
            createdAt: now,
            updatedAt: now,
          });

          get().requestSync();
        }),

      updateTask: (taskId, updates) =>
        runAction(set, "updateTask", async () => {
          const changes = { ...updates };
          if (typeof updates.title === "string") {
            const title = clampTitle(updates.title, MAX_TASK_TITLE_LENGTH);
            if (title) changes.title = title;
            else delete changes.title;
          }
          await writeTask(taskId, changes);
          get().requestSync();
        }),

      deleteTask: async (taskId) => {
        await runAction(set, "deleteTask", async () => {
          recordDeletedTaskTombstone(taskId);
          if (get().activeTaskId === taskId) {
            set({
              activeTaskId: null,
              isRunning: false,
              sessionStartedAt: null,
              focusUpdatedAt: nextFocusStamp(get),
            });
          }
          await db.tasks.delete(taskId);
          get().requestSync();
        });
      },

      reorderTaskQueue: async (orderedTaskIds, movedTaskId) => {
        await runAction(set, "reorderTaskQueue", async () => {
          // Minimal move (planRankMoves): only the rows that must change rank are
          // written (and get a new updatedAt). Every rewritten row is a whole-row
          // last-write-wins over the phone's copy, so touching rows the user did
          // not move would revert edits made there while apart (e.g. reopen a
          // task completed on the phone).
          const changedCount = await db.transaction("rw", db.tasks, async () => {
            const ids = Array.from(new Set(orderedTaskIds));
            const rows = (await db.tasks.bulkGet(ids)).filter(
              (row): row is Task => !!row
            );
            const plan = planRankMoves(rows, movedTaskId);
            const updates = rows.flatMap((row) => {
              const rank = plan.get(row.id);
              return rank === undefined
                ? []
                : [{ ...row, rank, updatedAt: nextStamp(row) }];
            });
            if (updates.length > 0) await db.tasks.bulkPut(updates);
            return updates.length;
          });
          if (changedCount > 0) get().requestSync();
        });
      },

      createQuest: ({ title, description = "", accentColor = "cyan", targetWeeklyHours = 10 }) =>
        runAction(set, "createQuest", async () => {
          const trimmed = clampTitle(title, MAX_QUEST_TITLE_LENGTH);
          if (!trimmed) return;
          const now = Date.now();
          const existing = await db.quests.orderBy("slotIndex").toArray();
          const nextSlot = (existing.length % 3) as 0 | 1 | 2;

          await db.quests.add({
            id: `quest-${now}-${Math.random().toString(36).slice(2, 6)}`,
            slotIndex: nextSlot,
            code: trimmed.slice(0, 10).toUpperCase(),
            title: trimmed,
            description: description.trim(),
            accentColor,
            targetWeeklyHours: Math.max(1, Number(targetWeeklyHours) || 10),
            archived: false,
            createdAt: now,
            updatedAt: now,
          });
          get().requestSync();
        }),

      updateQuest: (questId, changes) =>
        runAction(set, "updateQuest", async () => {
          const patch: QuestChanges = {};
          if (typeof changes.title === "string") {
            const title = clampTitle(changes.title, MAX_QUEST_TITLE_LENGTH);
            if (title) patch.title = title;
          }
          if (typeof changes.description === "string") {
            patch.description = changes.description.trim();
          }
          if (changes.accentColor !== undefined) patch.accentColor = changes.accentColor;
          const hours = changes.targetWeeklyHours;
          if (typeof hours === "number" && Number.isFinite(hours)) {
            // Same floor as createQuest (and the quest drawer's former direct write).
            patch.targetWeeklyHours = Math.max(1, hours);
          }
          const written = await db.transaction("rw", db.quests, async () => {
            const row = await db.quests.get(questId);
            if (!row) return false;
            await db.quests.update(questId, { ...patch, updatedAt: nextStamp(row) });
            return true;
          });
          if (written) get().requestSync();
        }),

      deleteQuest: async (questId) => {
        await runAction(set, "deleteQuest", async () => {
          recordDeletedQuestTombstone(questId);

          await db.transaction("rw", db.quests, db.tasks, db.habits, async () => {
            const linkedTasks = await db.tasks
              .where("questId")
              .equals(questId)
              .toArray();
            for (const t of linkedTasks) {
              await db.tasks.update(t.id, {
                questId: null,
                updatedAt: nextStamp(t),
              });
            }
            const linkedHabits = await db.habits
              .where("questId")
              .equals(questId)
              .toArray();
            for (const h of linkedHabits) {
              await db.habits.update(h.id, {
                questId: null,
                updatedAt: nextStamp(h),
              });
            }
            await db.quests.delete(questId);
          });

          get().requestSync();
        });
      },

      createHabit: ({ title, notes = "", questId }) =>
        runAction(set, "createHabit", async () => {
          const trimmed = clampTitle(title, MAX_HABIT_TITLE_LENGTH);
          if (!trimmed) return;

          const now = Date.now();
          const todayKey = toLocalDateKey(now);
          await db.transaction("rw", db.habits, db.tasks, async () => {
            const existing = (await db.habits.toArray()).sort(compareRank);
            const newRank =
              existing.length > 0
                ? rankValue(existing[existing.length - 1]) + RANK_STEP
                : RANK_STEP;
            const habit: Habit = {
              id: `hab-${now}-${Math.random().toString(36).slice(2, 6)}`,
              title: trimmed,
              notes: notes.trim(),
              questId,
              rank: newRank,
              createdAt: now,
              updatedAt: now,
            };
            await db.habits.add(habit);
            const todayTaskId = habitTaskId(habit.id, todayKey);
            if (!hasLocalTaskTombstone(todayTaskId)) {
              await db.tasks.put(buildHabitTaskRow(habit, todayKey));
            }
          });
          get().requestSync();
        }),

      updateHabit: (habitId, changes) =>
        runAction(set, "updateHabit", async () => {
          const todayKey = toLocalDateKey();
          const written = await db.transaction("rw", db.habits, db.tasks, async () => {
            const row = await db.habits.get(habitId);
            if (!row) return false;
            const patch: Partial<Habit> = {};
            if (typeof changes.title === "string") {
              const title = clampTitle(changes.title, MAX_HABIT_TITLE_LENGTH);
              if (title) patch.title = title;
            }
            if (typeof changes.notes === "string") {
              patch.notes = changes.notes.trim();
            }
            if (changes.questId !== undefined) {
              patch.questId = changes.questId;
            }
            const stamp = nextStamp(row);
            await db.habits.update(habitId, { ...patch, updatedAt: stamp });

            // Keep today's open materialized task aligned with the updated habit.
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
                await db.tasks.update(todayTaskId, {
                  ...taskPatch,
                  updatedAt: nextStamp(todayTask),
                });
              }
            }
            return true;
          });
          if (written) get().requestSync();
        }),

      deleteHabit: async (habitId) => {
        await runAction(set, "deleteHabit", async () => {
          recordDeletedHabitTombstone(habitId);
          const todayTaskId = habitTaskId(habitId, toLocalDateKey());
          let removedTodayTask = false;
          await db.transaction("rw", db.habits, db.tasks, async () => {
            await db.habits.delete(habitId);
            const todayTask = await db.tasks.get(todayTaskId);
            // Remove today's untouched open instance so a deleted habit leaves Home right away;
            // keep any completed or logged task so history stays intact.
            if (
              todayTask &&
              todayTask.status === "queued" &&
              (todayTask.accumulatedSeconds || 0) === 0
            ) {
              await db.tasks.delete(todayTaskId);
              removedTodayTask = true;
            }
          });
          if (removedTodayTask) {
            recordDeletedTaskTombstone(todayTaskId);
          }
          get().requestSync();
        });
      },

      materializeDailyHabits: async (dateKey?: string) => {
        let added = 0;
        const ok = await runAction(set, "materializeDailyHabits", async () => {
          added = await materializeHabitsIntoDB(dateKey ?? toLocalDateKey());
        });
        if (ok && added > 0) get().requestSync();
        return added;
      },

      deleteTimeLog: async (logId) => {
        await runAction(set, "deleteTimeLog", async () => {
          recordDeletedLogTombstone(logId);
          await db.timeLogs.delete(logId);
          get().requestSync();
        });
      },
    }),
    {
      name: "journey-hud-command-store",
      partialize: (state) => ({
        activeView: state.activeView,
        activeTaskId: state.activeTaskId,
        isRunning: state.isRunning,
        sessionStartedAt: state.sessionStartedAt,
        focusUpdatedAt: state.focusUpdatedAt,
      }),
      // Hand-written merge (the default spreads every stored key over the
      // actions). No `version` bump: existing stored sessions keep loading.
      merge: (persisted, current) =>
        isRecord(persisted) ? { ...current, ...sanitizePersistedFocus(persisted) } : current,
    }
  )
);
