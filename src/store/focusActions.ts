/**
 * The command store's Focus actions: start, pause, resume, complete and leave a
 * focus session through the shared focus state machine (lib/focusSession.ts).
 * Kept apart from the sync and CRUD wiring in useCommandStore.ts.
 */

import { reads } from "@/lib/reads";
import { isMissedHabitTask, toLocalDateKey } from "@/lib/dateUtils";
import {
  fromFocusSession,
  toFocusSession,
  type ActiveFocusState,
  type FocusSession,
  type QuestAccent,
} from "@/lib/domainTypes";
import { nextFocusStamp, transitionFocus } from "@/lib/focusSession";
import { localStore } from "@/lib/localStore";
import { compareRank } from "@/lib/syncTypes";
import { pickNextFocusTask } from "@/lib/taskQueue";
import type { RunAction } from "./habitDayActions";

export type HudView = "command" | "plan" | "focus" | "quests" | "habits" | "lists" | "telemetry" | "guide" | "log";

export interface CompletedDirectiveFeedback {
  taskTitle: string;
  questCode: string;
  accent: QuestAccent | "slate";
  loggedSeconds: number;
  nextTaskTitle: string | null;
  timestamp: number;
}

/** The store fields that hold the focus session. */
export interface FocusFields {
  activeTaskId: string | null;
  isRunning: boolean;
  sessionStartedAt: number | null;
  focusUpdatedAt: number;
}

export interface FocusActions {
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
}

/** What the Focus actions read from and write to the store. */
export interface FocusHost extends FocusFields, FocusActions {
  activeView: HudView;
  lastCompletedFeedback: CompletedDirectiveFeedback | null;
  requestSync: () => void;
}

/** Projects store focus fields into the validated FocusSession state union. */
export function readStoreFocusSession(
  state: FocusFields
): FocusSession {
  return toFocusSession({
    activeTaskId: state.activeTaskId,
    isRunning: state.isRunning,
    sessionStartedAt: state.sessionStartedAt,
    updatedAt: state.focusUpdatedAt || 0,
  });
}

/** Converts a validated FocusSession transition into Zustand store fields. */
export function focusSessionToStorePatch(
  session: FocusSession
): Pick<
  FocusFields,
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

export function readStoreActiveFocus(
  state: FocusFields
): ActiveFocusState {
  return fromFocusSession(readStoreFocusSession(state));
}

/**
 * Store fields for a session produced by a LOCAL focus transition, re-stamped
 * (R6) against the focus as it is now: an await between the transition and
 * this commit may have let a newer focus arrive.
 */
export function commitLocalSession(get: () => FocusFields, session: FocusSession) {
  const current = readStoreFocusSession(get());
  return focusSessionToStorePatch({
    ...session,
    updatedAt: Math.max(session.updatedAt, nextFocusStamp(current, Date.now())),
  });
}

/**
 * Completes the focused task (completeActiveTask's body): logs its burst,
 * stamps it completed (R6, re-read after the flush), stops the focus session
 * without auto-starting the next task, and keeps Focus view open when another
 * task is queued for today so the user can choose whether to start it.
 */
async function completeFocusedTask(
  get: () => FocusHost,
  set: (patch: Partial<FocusHost>) => void
): Promise<void> {
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

/** Single-flight guard for completeActiveTask (one store per page). */
let completeInFlight: Promise<void> | null = null;

/** Reports a failed synchronous action (shown through actionError). */
type ReportFailure = (name: string, err: unknown) => void;

export function focusActions(
  get: () => FocusHost,
  set: (patch: Partial<FocusHost>) => void,
  run: RunAction,
  report: ReportFailure
): FocusActions {
  return {
    initializeFocus: async (requestedTaskId?: string) => {
      await run("initializeFocus", async () => {
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
        report("engageTimer", err);
      }
    },

    suspendTimer: async () => {
      await run("suspendTimer", async () => {
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
        completeInFlight = run("completeActiveTask", () =>
          completeFocusedTask(get, set)
        ).then(() => {
          completeInFlight = null;
        });
      }
      return completeInFlight;
    },

    completeTaskById: async (taskId: string) => {
      await run("completeTaskById", async () => {
        if (get().activeTaskId === taskId) {
          await get().completeActiveTask();
          return;
        }
        await localStore.completeTask(taskId);
      });
    },

    reopenTaskById: async (taskId: string) => {
      await run("reopenTaskById", () => localStore.reopenTask(taskId));
    },

    returnToQueue: async () => {
      await run("returnToQueue", async () => {
        const next = transitionFocus(readStoreFocusSession(get()), { type: "stop" }, Date.now());
        await localStore.applyFocusEffects(next.effects);
        set({ ...commitLocalSession(get, next.session), activeView: "command" });
        get().requestSync();
      });
    },
  };
}
