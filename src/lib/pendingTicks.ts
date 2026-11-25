import type { Habit, HabitKind, Task } from "./domainTypes";
import { addHabitDayCount } from "./habitCount";
import { logHabitSlip } from "./habitAvoid";
import { habitDaySlips, habitKindOf } from "./habitKind";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";
import { completeTaskRow, missingHabitRows } from "./taskQueue";

/**
 * A Pending Tick (ADR-0006): a Task ticked on the Day Widget that Hunt has not
 * applied yet. The Android shell queues these; the phone page applies them
 * through HuntCore when it starts.
 */
export interface PendingTick {
  taskId: string;
  /** Local YYYY-MM-DD of the widget day the Task was ticked on. */
  dateKey: string;
  /** Epoch ms of the tap; becomes the Task's completion time. */
  tickedAt: number;
  /**
   * What the tap meant: absent for "done" (a Check Habit or plain Task), "+1"
   * for one more on a Count Habit's day, "slip" for a Slip on an Avoid Habit's
   * day. The shell writes it from the row's Habit Kind in the Widget Snapshot.
   */
  kind?: "+1" | "slip";
}

/**
 * Why a stale tick was dropped. A tick never overrides a newer change:
 * - `missing`: the Task (or the Habit behind a not-yet-created Habit row) is
 *   gone, or the tick is malformed;
 * - `already-done` / `archived`: the Task was completed or archived elsewhere;
 * - `in-focus`: the Task is in Focus now, and Focus sessions only end inside
 *   the app (finishing it needs a TimeLog and a Focus transition);
 * - `already-counted`: this `+1` was applied before (the queue was read again
 *   before the shell removed it);
 * - `already-slipped`: the Avoid Habit's day already has a Slip (this one,
 *   read again, or one logged elsewhere); the day is Missed either way;
 * - `wrong-kind`: a tick whose kind does not match the row's Habit Kind (a
 *   `+1` only on a Count Habit's day, a `slip` only on an Avoid Habit's, a
 *   done tick on neither).
 */
export type PendingTickSkipReason =
  | "missing"
  | "already-done"
  | "archived"
  | "in-focus"
  | "already-counted"
  | "already-slipped"
  | "wrong-kind";

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
    tick.tickedAt > 0 &&
    (tick.kind === undefined || tick.kind === "+1" || tick.kind === "slip")
  );
}

/**
 * The daily Habit row a tick names when Hunt has not created it yet (the
 * widget lists today's Habits by their fixed ids before the app has run that
 * day), or null. A row deleted elsewhere stays deleted.
 */
function habitRowFor(state: SyncPayload, tick: PendingTick): Task | null {
  return missingHabitRows(state, tick.dateKey).find((t) => t.id === tick.taskId) ?? null;
}

function doneSkipReason(state: SyncPayload, task: Task): PendingTickSkipReason | null {
  if (task.status === "completed") return "already-done";
  if (task.status === "archived") return "archived";
  if (state.activeFocus?.activeTaskId === task.id) return "in-focus";
  return null;
}

/**
 * The Task `tick` turns `task` into, or why it is skipped. A done tick
 * completes the Task through the shared complete-a-Task rule; a `+1` adds one
 * to a Count Habit day through the shared Count rule (also on a day already
 * Met, and in Focus, since counting ends no session) and records its tap time,
 * so the same `+1` read again is skipped; a `slip` logs a Slip on an Avoid
 * Habit day through the shared Slip rule, once: one Slip already makes the day
 * Missed, so a day that has one skips it.
 */
/** The tick kind a row of each Habit Kind takes (a plain Task takes a done tick, as Check). */
const TICK_KIND_OF: Record<HabitKind, PendingTick["kind"]> = { check: undefined, count: "+1", avoid: "slip" };

function applyTick(
  state: SyncPayload,
  task: Task,
  tick: PendingTick
): Task | PendingTickSkipReason {
  const habit: Habit | undefined = task.habitId
    ? (state.habits ?? []).find((h) => h.id === task.habitId)
    : undefined;
  const habitKind = habit ? habitKindOf(habit) : "check";
  if (tick.kind !== TICK_KIND_OF[habitKind]) return "wrong-kind";
  if (!habit || habitKind === "check") return doneSkipReason(state, task) ?? completeTaskRow(task, tick.tickedAt);
  if (task.status === "archived") return "archived";
  if (habitKind === "avoid") return habitDaySlips(task) > 0 ? "already-slipped" : logHabitSlip(task, tick.tickedAt);
  if ((task.countTickedAt ?? 0) >= tick.tickedAt) return "already-counted";
  return { ...addHabitDayCount(task, habit, tick.tickedAt), countTickedAt: tick.tickedAt };
}

/**
 * Applies Pending Ticks in order (applyTick), so the row-level merge
 * (ADR-0001) treats each like any other edit. A tick for today's Habit row
 * that does not exist yet first creates the row. Stale ticks are skipped with
 * a reason. Idempotent: applying the same ticks again skips them all (as
 * `already-done` or `already-counted`) and returns the state unchanged. Pure.
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
    const task = existing ?? habitRowFor(state, tick);
    if (!task) {
      skipped.push({ tick, reason: "missing" });
      continue;
    }
    const result = applyTick(state, task, tick);
    if (typeof result === "string") skipped.push({ tick, reason: result });
    else if (existing) tasks = tasks.map((t) => (t === existing ? result : t));
    else tasks = [...tasks, result].sort(compareRank);
  }
  return { state: tasks === state.tasks ? state : { ...state, tasks }, skipped };
}
