"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toLocalDateKey } from "@/lib/dateUtils";
import type { ChecklistEdit } from "@/lib/checklist";
import type { QuestAccent } from "@/lib/domainTypes";
import { logDiagnostic, recordBreadcrumb, summarizeError } from "@/lib/diagnostics";
import { transitionFocus } from "@/lib/focusSession";
import {
  localStore,
  onLocalChange,
  type HabitChanges,
  type NewHabit,
  type QuestChanges,
  type TaskChanges,
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
import type { SyncPayload } from "@/lib/syncTypes";
import { currentPlatform } from "@/lib/platform";
import { habitDayActions, type HabitDayActions } from "./habitDayActions";
import { listActions, type ListActions } from "./listActions";
import { mergePersistedFocus } from "./persistedFocus";
import {
  commitLocalSession,
  focusActions,
  focusSessionToStorePatch,
  readStoreActiveFocus,
  readStoreFocusSession,
  type CompletedDirectiveFeedback,
  type FocusActions,
  type HudView,
} from "./focusActions";

export {
  orderAfterDrop,
  pickNextFocusTask,
  planRankMoves,
  sessionLogId,
} from "@/lib/taskQueue";

export type SnapshotImportResult =
  | { ok: true; merged: SyncPayload }
  | { ok: false; reason: "bad_format" | "storage"; error: unknown };

export type { HabitChanges, QuestChanges, TaskChanges } from "@/lib/localStore";
export type { CompletedDirectiveFeedback, HudView } from "./focusActions";

interface CommandStoreState extends HabitDayActions, ListActions, FocusActions {
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
  updateTask: (taskId: string, updates: TaskChanges) => Promise<boolean>;
  /**
   * Applies one Checklist edit (shared rule: refused on a habit day Task).
   * Resolves to true only when the Checklist changed and was saved.
   */
  editChecklist: (taskId: string, edit: ChecklistEdit) => Promise<boolean>;
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
  /** False when the quest is missing or the write failed (deleteQuest: only when it failed). */
  completeQuest: (questId: string) => Promise<boolean>;
  /** Restores a completed quest back to Active Quests (`archived: false`). */
  reopenQuest: (questId: string) => Promise<boolean>;
  deleteQuest: (questId: string) => Promise<boolean>;

  // Daily Habit CRUD & Materialization
  /**
   * Resolves to false when the local write failed (actionError is then set) or was refused
   * (invalid input, or MAX_SYNC_HABITS reached), true otherwise. updateHabit is false only
   * when the write failed: a Habit deleted on another device must still close its drawer.
   */
  createHabit: (params: NewHabit) => Promise<boolean>;
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
 * runAction for a write that resolves to false when it refused (row missing, invalid input,
 * a sync cap reached): false then too, so the caller can keep the user's text.
 */
async function runWrite(set: StoreSet, name: string, action: () => Promise<boolean>): Promise<boolean> {
  let wrote = false;
  const ok = await runAction(set, name, async () => {
    wrote = await action();
  });
  return ok && wrote;
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
 * One sync round trip + local bookkeeping. Returns the failure code (null on
 * success) and whether it wrote local rows that still need to be pushed
 * (flushed burst).
 */
async function runSyncOnce(
  get: StoreGet,
  set: StoreSet
): Promise<{ error: SyncErrorCode | null; wroteLocal: boolean }> {
  // The browser demo has no sync hub (ADR-0010): a pass is a no-op, not a network error.
  if (!currentPlatform.sync) return { error: null, wroteLocal: false };
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

        ...focusActions(get, set, (name, action) => runAction(set, name, action), (name, err) =>
          reportActionFailure(set, name, err)
        ),

        createTask: (params) =>
          runAction(set, "createTask", () => localStore.createTask(params)),

        updateTask: (taskId, updates) =>
          runAction(set, "updateTask", () => localStore.updateTask(taskId, updates)),

        editChecklist: async (taskId, edit) => {
          let applied = false;
          const ok = await runAction(set, "editChecklist", async () => {
            applied = await localStore.editChecklist(taskId, edit);
          });
          return ok && applied;
        },

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
          runWrite(set, "createQuest", () => localStore.createQuest(params)),

        updateQuest: (questId, changes) =>
          runAction(set, "updateQuest", () => localStore.updateQuest(questId, changes)),

        completeQuest: (questId) =>
          runWrite(set, "completeQuest", () => localStore.completeQuest(questId)),

        reopenQuest: (questId) => runWrite(set, "reopenQuest", () => localStore.reopenQuest(questId)),

        deleteQuest: (questId) => runAction(set, "deleteQuest", () => localStore.deleteQuest(questId)),

        createHabit: (params) => runWrite(set, "createHabit", () => localStore.createHabit(params)),

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
        ...listActions((name, action) => runAction(set, name, action)),

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
      merge: mergePersistedFocus,
    }
  )
);

// Every Local Store write asks for a (debounced) sync.
onLocalChange(() => useCommandStore.getState().requestSync());
