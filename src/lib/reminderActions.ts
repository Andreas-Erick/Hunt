import { habitTaskId } from "./dateUtils";
import type { Habit } from "./domainTypes";
import { habitKindOf } from "./habitKind";
import type { PendingTick } from "./pendingTicks";

/**
 * Notification actions (ADR-0007): what a reminder's notification lets the
 * user do besides Snooze. Done on a Task or a Check Habit's day, +1 on a Count
 * Habit's day. Either is written as a Pending Tick (ADR-0006) and applied
 * through HuntCore's applyPendingTicks, never by the shell. Pure.
 */

/** The tick a notification's action writes, and the Task it names. */
export interface ReminderAction {
  tick: "done" | "+1";
  /** The Task to tick: the Task itself, or the Habit's day Task (made on apply if missing). */
  taskId: string;
}

/** The part of a reminder the action depends on; `kind` is "task" or "habit". */
export interface ReminderTarget {
  kind: string;
  itemId: string;
  dateKey: string;
}

/**
 * The action a reminder's notification offers, or null for none: an Avoid
 * Habit's check-in has nothing to tick (a Slip is logged in Hunt), and a Habit
 * that is gone or a kind this rule does not know offers only Snooze. A habit
 * action names the Habit's day Task (`habtsk-<date>-<habitId>`).
 */
export function reminderAction(reminder: ReminderTarget, habits: readonly Habit[] | undefined): ReminderAction | null {
  if (reminder.kind === "task") return { tick: "done", taskId: reminder.itemId };
  if (reminder.kind !== "habit") return null;
  const habit = (habits ?? []).find((h) => h.id === reminder.itemId);
  if (!habit) return null;
  const kind = habitKindOf(habit);
  // A stored kind this build does not know (synced from a newer device) is not a Check.
  if (habit.kind !== undefined && habit.kind !== kind) return null;
  const taskId = habitTaskId(habit.id, reminder.dateKey);
  if (kind === "check") return { tick: "done", taskId };
  if (kind === "count") return { tick: "+1", taskId };
  // "avoid": a check-in, Snooze only.
  return null;
}

/** The Pending Tick `action` writes when tapped at `tickedAt` on a reminder for `dateKey`. */
export function reminderActionTick(action: ReminderAction, dateKey: string, tickedAt: number): PendingTick {
  const tick: PendingTick = { taskId: action.taskId, dateKey, tickedAt };
  if (action.tick === "+1") tick.kind = "+1";
  return tick;
}
