export const SYNC_TOKEN_STORAGE_KEY = "hunt-sync-token-v1";
export const TOMBSTONE_STORAGE_KEY = "hunt-sync-tombstones-v1";

export const QUEST_ACCENT_KEYS = [
  "cyan",
  "emerald",
  "amber",
  "purple",
  "rose",
  "sky",
  "orange",
  "lime",
] as const;

export type QuestAccent = (typeof QUEST_ACCENT_KEYS)[number];

export interface Quest {
  id: string;
  slotIndex: 0 | 1 | 2;
  code: string;
  title: string;
  description: string;
  accentColor: QuestAccent;
  targetWeeklyHours: number;
  archived: boolean;
  createdAt: number;
  updatedAt?: number;
  completedAt?: number;
}

/**
 * How a Habit's day succeeds (GLOSSARY: Habit Kind). Chosen when the Habit is
 * made and never changed. A row without one is a Check Habit.
 */
export type HabitKind = "check" | "count";

export interface Habit {
  id: string;
  title: string;
  notes: string;
  questId: string | null; // null = Other / Maintenance work
  rank: number;
  createdAt: number;
  updatedAt?: number;
  /** Habit Kind; missing on rows made before Kinds existed, which read as "check". */
  kind?: HabitKind;
  /** Count Habit: the day's total that makes it Met (a positive number). */
  target?: number;
  /** Count Habit: what is counted, e.g. "miles" (may be empty). */
  unit?: string;
}

export type TaskStatus = "queued" | "active" | "completed" | "archived";

export interface Task {
  id: string;
  title: string;
  notes: string;
  questId: string | null; // null = Other / Maintenance work
  status: TaskStatus;
  rank: number;
  accumulatedSeconds: number;
  scheduledDate?: string; // YYYY-MM-DD local date for "Plan the week"
  habitId?: string; // Source Habit.id when materialized from a daily habit
  createdAt: number;
  updatedAt?: number;
  completedAt?: number;
  /** A Count Habit's day Task: the day's one total (+1 and exact entry both write it). */
  amount?: number;
  /**
   * A Count Habit's day Task: tap time of the newest `+1` Pending Tick applied to it, so the
   * same queued tick read again is never counted twice.
   */
  countTickedAt?: number;
}

export interface TimeLog {
  id: string;
  taskId: string;
  taskTitleSnapshot: string;
  questId: string | null;
  questCodeSnapshot: string;
  accentColorSnapshot: QuestAccent | "slate";
  startTime: number;
  endTime: number;
  durationSeconds: number;
  dateKey: string; // YYYY-MM-DD local date
}

export interface ActiveFocusState {
  activeTaskId: string | null;
  isRunning: boolean;
  sessionStartedAt: number | null;
  updatedAt: number;
}

/**
 * Explicit discriminated state machine for focus sessions.
 * Eliminates illegal states (such as running without a taskId or start timestamp).
 */
export type FocusSession =
  | {
      readonly status: "idle";
      readonly updatedAt: number;
    }
  | {
      readonly status: "running";
      readonly taskId: string;
      readonly sessionStartedAt: number;
      readonly updatedAt: number;
    }
  | {
      readonly status: "paused";
      readonly taskId: string;
      readonly updatedAt: number;
    };

/** Projects wire/store ActiveFocusState into the total FocusSession union. */
export function toFocusSession(focus: ActiveFocusState): FocusSession {
  const updatedAt =
    typeof focus.updatedAt === "number" && Number.isFinite(focus.updatedAt) && focus.updatedAt >= 0
      ? focus.updatedAt
      : 0;
  if (!focus.activeTaskId) {
    return { status: "idle", updatedAt };
  }
  if (
    focus.isRunning &&
    typeof focus.sessionStartedAt === "number" &&
    Number.isFinite(focus.sessionStartedAt) &&
    focus.sessionStartedAt > 0
  ) {
    return {
      status: "running",
      taskId: focus.activeTaskId,
      sessionStartedAt: focus.sessionStartedAt,
      updatedAt,
    };
  }
  return {
    status: "paused",
    taskId: focus.activeTaskId,
    updatedAt,
  };
}

/** Serializes a validated FocusSession transition back into ActiveFocusState fields. */
export function fromFocusSession(session: FocusSession): ActiveFocusState {
  switch (session.status) {
    case "idle":
      return {
        activeTaskId: null,
        isRunning: false,
        sessionStartedAt: null,
        updatedAt: session.updatedAt,
      };
    case "paused":
      return {
        activeTaskId: session.taskId,
        isRunning: false,
        sessionStartedAt: null,
        updatedAt: session.updatedAt,
      };
    case "running":
      return {
        activeTaskId: session.taskId,
        isRunning: true,
        sessionStartedAt: session.sessionStartedAt,
        updatedAt: session.updatedAt,
      };
  }
}
