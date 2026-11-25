"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { reads } from "@/lib/reads";
import { isMissedHabitTask, toLocalDateKey } from "@/lib/dateUtils";
import {
  fromFocusSession,
  toFocusSession,
  type ActiveFocusState,
  type FocusSession,
  type QuestAccent,
} from "@/lib/domainTypes";
import {
  logDiagnostic,
  recordBreadcrumb,
  summarizeError,
} from "@/lib/diagnostics";
import { nextFocusStamp, transitionFocus } from "@/lib/focusSession";
import {
  localStore,
  onLocalChange,
  type HabitChanges,
  type QuestChanges,
} from "@/lib/localStore";
import { SnapshotFormatError, importAndMergeSnapshotJson } from "@/lib/applySnapshot";
import {
  describeSyncError,
  httpSyncTransport,
  performServerSync,
  type SyncErrorCode,
  type SyncTransport,
} from "@/lib/syncEngine";
import {
  createSyncScheduler,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_SYNC_DEBOUNCE_MS,
  type SyncScheduler,
} from "@/lib/syncScheduler";
import {
  compareRank,
  isSafeSyncId,
  MAX_ENTITY_ID_LENGTH,
  type SyncPayload,
} from "@/lib/syncTypes";
import { pickNextFocusTask } from "@/lib/taskQueue";
import { habitDayActions, type HabitDayActions } from "./habitDayActions";

export {
  orderAfterDrop,
  pickNextFocusTask,
  planRankMoves,
  sessionLogId,
} from "@/lib/taskQueue";

export type HudView = "command" | "plan" | "focus" | "quests" | "habits" | "telemetry" | "guide" | "log";

export type SnapshotImportResult =
  | { ok: true; merged: SyncPayload }
  | { ok: false; reason: "bad_format" | "storage"; error: unknown };

export interface CompletedDirectiveFeedback {
  taskTitle: string;
  questCode: string;
  accent: QuestAccent | "slate";
  loggedSeconds: number;
  nextTaskTitle: string | null;
  timestamp: number;
}

export type { HabitChanges, QuestChanges } from "@/lib/localStore";

interface CommandStoreState extends HabitDayActions {
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
  /**
   * Merges an offline JSON snapshot into local IndexedDB, reconciles active focus
   * (flushing any losing running session via R4), and materializes daily habits.
   * Never rejects.
   */
  importSnapshot: (jsonText: string) => Promise<SnapshotImportResult>;

  /** User-facing text of the last failed local (IndexedDB) action; not persisted. */
  actionError: string | null;
  clearActionError: () => void;

  // Navigation
  /**
   * Asked by setActiveView before it leaves the current view; false keeps the
   * view. A view registers one only while it holds unsaved form edits, which
   * leaving would unmount. Not persisted.
   */
  discardGuard: (() => boolean) | null;
  setDiscardGuard: (guard: (() => boolean) | null) => void;
  /** Switches the view unless the registered discardGuard declines. */
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
  /**
   * Retires a quest into Completed Quests (`archived: true`, `completedAt: now`),
   * keeps historical time logs and completed tasks linked, and moves remaining
   * open tasks and daily habits to Other work (`questId: null`).
   */
  completeQuest: (questId: string) => Promise<void>;
  /** Restores a completed quest back to Active Quests (`archived: false`). */
  reopenQuest: (questId: string) => Promise<void>;
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
export const SYNC_DEBOUNCE_MS = DEFAULT_SYNC_DEBOUNCE_MS;
/** Auto-sync pause after the first consecutive transient failure (before jitter); doubles per failure. */
export const AUTO_SYNC_BASE_BACKOFF_MS = DEFAULT_BASE_BACKOFF_MS;
/** Longest auto-sync pause after transient failures (before jitter). */
export const AUTO_SYNC_MAX_BACKOFF_MS = DEFAULT_MAX_BACKOFF_MS;

/** Projects store focus fields into the validated FocusSession state union. */
function readStoreFocusSession(
  state: Pick<
    CommandStoreState,
    "activeTaskId" | "isRunning" | "sessionStartedAt" | "focusUpdatedAt"
  >
): FocusSession {
  return toFocusSession({
    activeTaskId: state.activeTaskId,
    isRunning: state.isRunning,
    sessionStartedAt: state.sessionStartedAt,
    updatedAt: state.focusUpdatedAt || 0,
  });
}

/** Converts a validated FocusSession transition into Zustand store fields. */
function focusSessionToStorePatch(
  session: FocusSession
): Pick<
  CommandStoreState,
  "activeTaskId" | "isRunning" | "sessionStartedAt" | "focusUpdatedAt"
> {
  const wire = fromFocusSession(session);
  return {
    activeTaskId: wire.activeTaskId,
    isRunning: wire.isRunning,
    sessionStartedAt: wire.sessionStartedAt,
    focusUpdatedAt: wire.updatedAt,
  };
}

function readStoreActiveFocus(
  state: Pick<
    CommandStoreState,
    "activeTaskId" | "isRunning" | "sessionStartedAt" | "focusUpdatedAt"
  >
): ActiveFocusState {
  return fromFocusSession(readStoreFocusSession(state));
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
 * A failed habit materialization after a sync or import: kept in the breadcrumb
 * ring, logged with the legacy console tag, and not shown to the user (the
 * sync or import itself succeeded; the next boot or day change retries).
 */
function recordMaterializeFailure(err: unknown): void {
  recordBreadcrumb({
    level: "ERROR",
    domain: "store",
    event: "action_failed",
    context: { action: "materializeDailyHabits", ...summarizeError(err) },
  });
  console.error("[hunt] action_failed", "materializeDailyHabits", err);
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
 * Applies a merged payload's `activeFocus` to this device (the "remote" focus
 * transition): a losing local running burst is logged with its R4 end and a
 * replaced active task requeued, then the winning focus is added to `patch`.
 * Returns whether local rows were written (they still need to be pushed).
 */
async function reconcileMergedFocus(
  merged: SyncPayload,
  get: StoreGet,
  patch: Partial<CommandStoreState>
): Promise<boolean> {
  const remote = merged.activeFocus;
  if (!remote) return false;
  const before = readStoreFocusSession(get());
  const next = transitionFocus(
    before,
    { type: "remote", remote, timeLogs: merged.timeLogs },
    Date.now()
  );
  if (next.session === before) return false;
  let wroteLocal = false;
  try {
    // The sync's own rerun pushes these writes (no debounced extra sync).
    wroteLocal = await localStore.applyFocusEffects(next.effects, { notify: false });
  } catch (err) {
    logDiagnostic({
      level: "ERROR",
      domain: "sync",
      event: "flush_before_remote_focus_failed",
      context: summarizeError(err),
    });
  }
  // A local focus change made while we were awaiting is newer than `remote`.
  if (get().focusUpdatedAt === before.updatedAt) {
    Object.assign(patch, focusSessionToStorePatch(next.session));
  }
  return wroteLocal;
}

/**
 * Store fields for a session produced by a LOCAL focus transition, re-stamped
 * (R6) against the focus as it is now: an await between the transition and
 * this commit may have let a newer focus arrive.
 */
function commitLocalSession(get: StoreGet, session: FocusSession) {
  const current = readStoreFocusSession(get());
  return focusSessionToStorePatch({
    ...session,
    updatedAt: Math.max(session.updatedAt, nextFocusStamp(current, Date.now())),
  });
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
  const res = await performServerSync(readStoreActiveFocus(get()), syncTransport);

  if (!res.ok) {
    setChanged(get, set, { isSyncOnline: false, syncError: res.error });
    return { error: res.error, wroteLocal: false };
  }

  const patch: Partial<CommandStoreState> = {
    isSyncOnline: true,
    syncError: null,
    lastSyncedAt: res.merged.lastSyncedAt || Date.now(),
  };
  if (res.lanUrls && res.lanUrls.length > 0) patch.lanUrls = res.lanUrls;
  const phoneSeen = res.peers?.phone.lastSeenAt ?? null;
  // The server keeps peers in memory only; after a server restart keep what we knew.
  if (phoneSeen !== null) patch.phoneLastSeenAt = phoneSeen;

  let wroteLocal = await reconcileMergedFocus(res.merged, get, patch);

  setChanged(get, set, patch);
  // If sync brought in new habits from another device, ensure today's tasks exist.
  if (res.changed) {
    try {
      const added = await localStore.materializeHabits(toLocalDateKey(), { notify: false });
      if (added > 0) wroteLocal = true;
    } catch (err) {
      recordMaterializeFailure(err);
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
  const session = readStoreFocusSession(get());
  if (session.status === "idle") return;
  const activeTaskId = session.taskId;
  const cleared = () =>
    commitLocalSession(get, transitionFocus(session, { type: "clear" }, Date.now()).session);

  const currentTask = await reads.task(activeTaskId);
  if (!currentTask) {
    set(cleared());
    get().requestSync();
    return;
  }
  // Already completed elsewhere (e.g. on the phone while this focus had not
  // synced to it): it is not completed again and gets no placeholder log, but
  // this device's running session is still logged and focus still clears.
  const alreadyCompleted = currentTask.status === "completed";

  let burstSeconds = 0;
  if (session.status === "running") {
    burstSeconds = await localStore.flushBurst(activeTaskId, session.sessionStartedAt);
  } else if (!alreadyCompleted && (currentTask.accumulatedSeconds || 0) === 0) {
    burstSeconds = await localStore.flushBurst(activeTaskId, Date.now() - 1000);
  }

  const updatedTask = await reads.task(activeTaskId);
  const totalTaskSeconds =
    updatedTask?.accumulatedSeconds ||
    currentTask.accumulatedSeconds + burstSeconds;

  const quest = currentTask.questId
    ? await reads.quest(currentTask.questId)
    : undefined;

  const doneTs = Date.now();
  if (!alreadyCompleted) {
    await localStore.completeTask(activeTaskId, doneTs);
  }

  const nextTask = pickNextFocusTask(
    await reads.queuedTasks(),
    toLocalDateKey(doneTs)
  );

  const feedback: CompletedDirectiveFeedback = {
    taskTitle: currentTask.title,
    questCode: quest ? quest.title : "Other",
    accent: quest ? quest.accentColor : "slate",
    loggedSeconds: totalTaskSeconds,
    nextTaskTitle: nextTask ? nextTask.title : null,
    timestamp: Date.now(),
  };
  const currentView = get().activeView;
  set({
    ...cleared(),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A millisecond timestamp: a finite number in [0, MAX_SAFE_INTEGER]. */
function isStamp(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Zero-trust rehydration: validates the persisted focus fields (an invalid or
 * missing one gets its default), enforces `isRunning ⇒ activeTaskId && sessionStartedAt`,
 * and always lands on the Home screen (`activeView: "command"`) when opening the app.
 * Nothing else is copied, so a corrupted or tampered entry can neither replace an
 * action nor feed NaN into a flush.
 */
function sanitizePersistedFocus(persisted: Record<string, unknown>): PersistedFocusState {
  const { activeTaskId, isRunning, sessionStartedAt, focusUpdatedAt } = persisted;
  const taskId = isSafeSyncId(activeTaskId, MAX_ENTITY_ID_LENGTH) ? activeTaskId : null;
  const startedAt = isStamp(sessionStartedAt) && sessionStartedAt > 0 ? sessionStartedAt : null;
  return {
    activeView: "command",
    activeTaskId: taskId,
    isRunning: isRunning === true && taskId !== null && startedAt !== null,
    sessionStartedAt: startedAt,
    focusUpdatedAt: isStamp(focusUpdatedAt) ? focusUpdatedAt : 0,
  };
}

/** Single-flight guard for completeActiveTask (one store per page). */
let completeInFlight: Promise<void> | null = null;

/**
 * Failures worth retrying on their own: network/timeout, local IndexedDB,
 * HTTP 408, 429 and 5xx except 507. Every other code (400, 401, 403, 413, 422,
 * 507, a bad response, ...) fails the same way until something changes.
 */
export function isTransientSyncError(code: SyncErrorCode): boolean {
  if (code === "unreachable" || code === "local_db") return true;
  const m = /^http_(\d+)$/.exec(code);
  if (!m) return false;
  const status = Number(m[1]);
  return status === 408 || status === 429 || (status >= 500 && status <= 599 && status !== 507);
}

/** Where sync passes are sent; tests swap in an in-memory server. */
let syncTransport: SyncTransport = httpSyncTransport;

/** Replaces the sync transport (null restores the HTTP adapter). */
export function setSyncTransport(transport: SyncTransport | null): void {
  syncTransport = transport ?? httpSyncTransport;
}

let scheduler: SyncScheduler | null = null;

/** Deterministically cancels any pending debounced sync timer and resets transient scheduler backoff. */
export function disposeCommandStoreScheduler(): void {
  scheduler?.dispose();
}

export const useCommandStore = create<CommandStoreState>()(
  persist(
    (set, get) => {
      const sync = createSyncScheduler<SyncErrorCode>({
        runOnce: () => runSyncOnce(get, set),
        isTransient: isTransientSyncError,
        loopErrorCode: "local_db",
        onLoopError: (err) =>
          logDiagnostic({
            level: "ERROR",
            domain: "sync",
            event: "sync_loop_failed",
            context: summarizeError(err),
          }),
        // Through the store, so a replaced requestSync (tests) is honoured.
        requestFollowUp: () => get().requestSync(),
        syncFromDebounce: () => get().syncNow(),
      });
      scheduler = sync;
      return {
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
        discardGuard: null,

        syncNow: () => sync.syncNow(),
        autoSync: () => sync.autoSync(),
        requestSync: () => sync.request(),

        importSnapshot: async (jsonText: string): Promise<SnapshotImportResult> => {
          try {
            const merged = await importAndMergeSnapshotJson(
              jsonText,
              readStoreActiveFocus(get())
            );
            const patch: Partial<CommandStoreState> = {};
            await reconcileMergedFocus(merged, get, patch);
            setChanged(get, set, patch);
            try {
              await localStore.materializeHabits(toLocalDateKey(), { notify: false });
            } catch (err) {
              recordMaterializeFailure(err);
            }
            return { ok: true, merged };
          } catch (err) {
            if (err instanceof SnapshotFormatError || err instanceof SyntaxError) {
              return { ok: false, reason: "bad_format", error: err };
            }
            recordBreadcrumb({
              level: "ERROR",
              domain: "sync",
              event: "snapshot_import_failed",
              context: summarizeError(err),
            });
            console.error("[hunt] snapshot_import_failed", err);
            return { ok: false, reason: "storage", error: err };
          }
        },

        clearActionError: () => set({ actionError: null }),
        setDiscardGuard: (guard) => set({ discardGuard: guard }),
        setActiveView: (view) => {
          const { activeView, discardGuard } = get();
          if (view === activeView) return;
          if (discardGuard && !discardGuard()) return;
          set({ activeView: view });
        },
        clearFeedback: () => set({ lastCompletedFeedback: null }),

        initializeFocus: async (requestedTaskId?: string) => {
          await runAction(set, "initializeFocus", async () => {
            let session = readStoreFocusSession(get());

            if (
              requestedTaskId &&
              session.status === "running" &&
              session.taskId === requestedTaskId
            ) {
              // Already running on this task: keep the session (restarting it would
              // silently drop the time since sessionStartedAt).
              set({ activeView: "focus", lastCompletedFeedback: null });
              return;
            }

            let targetId = requestedTaskId;
            if (!targetId) {
              // Leave the current session first: its requeued task may be the pick.
              const left = transitionFocus(session, { type: "leave" }, Date.now());
              await localStore.applyFocusEffects(left.effects);
              session = { status: "idle", updatedAt: session.updatedAt };
              const queued = await reads.queuedTasks();
              const todayKey = toLocalDateKey();
              // Nothing for today: start the first queued task of any day, never a
              // missed daily habit day (that is history, not open work).
              const chosen =
                pickNextFocusTask(queued, todayKey) ??
                queued
                  .filter((t) => !isMissedHabitTask(t, todayKey))
                  .sort(compareRank)[0];
              if (!chosen) return;
              targetId = chosen.id;
            }

            const next = transitionFocus(session, { type: "start", taskId: targetId }, Date.now());
            await localStore.applyFocusEffects(next.effects);
            set({
              ...commitLocalSession(get, next.session),
              activeView: "focus",
              lastCompletedFeedback: null,
            });
            get().requestSync();
          });
        },

        engageTimer: () => {
          try {
            const session = readStoreFocusSession(get());
            const next = transitionFocus(session, { type: "resume" }, Date.now());
            if (next.session === session) return;
            set(commitLocalSession(get, next.session));
            get().requestSync();
          } catch (err) {
            reportActionFailure(set, "engageTimer", err);
          }
        },

        suspendTimer: async () => {
          await runAction(set, "suspendTimer", async () => {
            const session = readStoreFocusSession(get());
            const next = transitionFocus(session, { type: "pause" }, Date.now());
            if (next.session === session) return;
            await localStore.applyFocusEffects(next.effects);
            set(commitLocalSession(get, next.session));
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
            await localStore.completeTask(taskId);
          });
        },

        reopenTaskById: async (taskId: string) => {
          await runAction(set, "reopenTaskById", () => localStore.reopenTask(taskId));
        },

        returnToQueue: async () => {
          await runAction(set, "returnToQueue", async () => {
            const next = transitionFocus(readStoreFocusSession(get()), { type: "stop" }, Date.now());
            await localStore.applyFocusEffects(next.effects);
            set({ ...commitLocalSession(get, next.session), activeView: "command" });
            get().requestSync();
          });
        },

        createTask: (params) =>
          runAction(set, "createTask", () => localStore.createTask(params)),

        updateTask: (taskId, updates) =>
          runAction(set, "updateTask", () => localStore.updateTask(taskId, updates)),

        deleteTask: async (taskId) => {
          await runAction(set, "deleteTask", async () => {
            const session = readStoreFocusSession(get());
            if (session.status !== "idle" && session.taskId === taskId) {
              set(
                commitLocalSession(
                  get,
                  transitionFocus(session, { type: "clear" }, Date.now()).session
                )
              );
            }
            await localStore.deleteTask(taskId);
          });
        },

        reorderTaskQueue: async (orderedTaskIds, movedTaskId) => {
          await runAction(set, "reorderTaskQueue", () =>
            localStore.reorderTasks(orderedTaskIds, movedTaskId)
          );
        },

        createQuest: (params) =>
          runAction(set, "createQuest", () => localStore.createQuest(params)),

        updateQuest: (questId, changes) =>
          runAction(set, "updateQuest", () => localStore.updateQuest(questId, changes)),

        completeQuest: async (questId) => {
          await runAction(set, "completeQuest", () => localStore.completeQuest(questId));
        },

        reopenQuest: async (questId) => {
          await runAction(set, "reopenQuest", () => localStore.reopenQuest(questId));
        },

        deleteQuest: async (questId) => {
          await runAction(set, "deleteQuest", () => localStore.deleteQuest(questId));
        },

        createHabit: (params) =>
          runAction(set, "createHabit", () => localStore.createHabit(params)),

        updateHabit: (habitId, changes) =>
          runAction(set, "updateHabit", () => localStore.updateHabit(habitId, changes)),

        deleteHabit: async (habitId) => {
          await runAction(set, "deleteHabit", () => localStore.deleteHabit(habitId));
        },

        materializeDailyHabits: async (dateKey?: string) => {
          let added = 0;
          await runAction(set, "materializeDailyHabits", async () => {
            added = await localStore.materializeHabits(dateKey ?? toLocalDateKey());
          });
          return added;
        },

        ...habitDayActions((name, action) => runAction(set, name, action)),

        deleteTimeLog: async (logId) => {
          await runAction(set, "deleteTimeLog", () => localStore.deleteTimeLog(logId));
        },
      };
    },
    {
      name: "journey-hud-command-store",
      partialize: (state) => ({
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

// Every Local Store write asks for a (debounced) sync.
onLocalChange(() => useCommandStore.getState().requestSync());
