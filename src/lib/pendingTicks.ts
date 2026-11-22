import { habitTaskId } from "./dateUtils";
import type { Task } from "./domainTypes";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";
import { buildHabitTaskRow, completeTaskRow } from "./taskQueue";

/**
 * A Pending Tick (ADR-0006): a Task ticked done on the Day Widget that Hunt has
 * not applied yet. The Android shell queues these; the phone page applies them
 * through HuntCore when it starts.
 */
export interface PendingTick {
  taskId: string;
  /** Local YYYY-MM-DD of the widget day the Task was ticked on. */
  dateKey: string;
  /** Epoch ms of the tap; becomes the Task's completion time. */
  tickedAt: number;
}

/**
 * Why a stale tick was dropped. A tick never overrides a newer change:
 * - `missing`: the Task (or the Habit behind a not-yet-created Habit row) is
 *   gone, or the tick is malformed;
 * - `already-done` / `archived`: the Task was completed or archived elsewhere;
 * - `in-focus`: the Task is in Focus now, and Focus sessions only end inside
 *   the app (finishing it needs a TimeLog and a Focus transition).
 */
export type PendingTickSkipReason = "missing" | "already-done" | "archived" | "in-focus";

export interface SkippedTick {
  tick: PendingTick;
  reason: PendingTickSkipReason;
}

export interface PendingTicksResult {
  /** The input state when nothing was applied; otherwise a new state. */
  state: SyncPayload;
  skipped: SkippedTick[];
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isWellFormed(tick: PendingTick): boolean {
  return (
    !!tick &&
    typeof tick.taskId === "string" &&
    tick.taskId !== "" &&
    typeof tick.dateKey === "string" &&
    DATE_KEY_RE.test(tick.dateKey) &&
    typeof tick.tickedAt === "number" &&
    Number.isFinite(tick.tickedAt) &&
    tick.tickedAt > 0
  );
}

/**
 * The daily Habit row a tick names when Hunt has not created it yet (the
 * widget lists today's Habits by their fixed ids before the app has run that
 * day), or null. A row deleted elsewhere stays deleted.
 */
function habitRowFor(state: SyncPayload, tick: PendingTick): Task | null {
  if ((state.deletedTaskIds ?? []).includes(tick.taskId)) return null;
  const habit = (state.habits ?? []).find((h) => habitTaskId(h.id, tick.dateKey) === tick.taskId);
  return habit ? buildHabitTaskRow(habit, tick.dateKey) : null;
}

function skipReason(state: SyncPayload, task: Task): PendingTickSkipReason | null {
  if (task.status === "completed") return "already-done";
  if (task.status === "archived") return "archived";
  if (state.activeFocus?.activeTaskId === task.id) return "in-focus";
  return null;
}

/**
 * Applies Pending Ticks in order: each named Task is completed through the
 * shared complete-a-Task rule with `tickedAt` as its completion time, so the
 * row-level merge (ADR-0001) treats it like any other edit. A tick for today's
 * Habit row that does not exist yet first creates the row. Stale ticks are
 * skipped with a reason. Idempotent: applying the same ticks again skips them
 * all as `already-done` and returns the state unchanged. Pure.
 */
export function applyPendingTicks(
  state: SyncPayload,
  ticks: readonly PendingTick[]
): PendingTicksResult {
  let tasks = state.tasks;
  const skipped: SkippedTick[] = [];
  for (const tick of ticks) {
    if (!isWellFormed(tick)) {
      skipped.push({ tick, reason: "missing" });
      continue;
    }
    const existing = tasks.find((t) => t.id === tick.taskId);
    if (existing) {
      const reason = skipReason(state, existing);
      if (reason) skipped.push({ tick, reason });
      else tasks = tasks.map((t) => (t === existing ? completeTaskRow(t, tick.tickedAt) : t));
      continue;
    }
    const created = habitRowFor(state, tick);
    if (!created) skipped.push({ tick, reason: "missing" });
    else tasks = [...tasks, completeTaskRow(created, tick.tickedAt)].sort(compareRank);
  }
  return { state: tasks === state.tasks ? state : { ...state, tasks }, skipped };
}
