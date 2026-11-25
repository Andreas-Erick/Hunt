import { db } from "./db";
import { habitTaskId } from "./dateUtils";
import type { Task } from "./domainTypes";
import { logHabitSlip, undoHabitSlip } from "./habitAvoid";
import { habitKindOf } from "./habitKind";
import { hasLocalTaskTombstone } from "./syncTombstones";
import { buildHabitTaskRow, nextStamp } from "./taskQueue";

/**
 * The Local Store's Avoid Habit writes (localStore.ts calls these and emits its
 * change signal). Every Slip goes through the shared Slip rule (habitAvoid.ts),
 * as on the phone and for a Day Widget tap.
 */

/** Log a Slip, or undo the newest one. */
export type SlipEdit = "log" | "undo";

/**
 * The row "complete this Task" writes on an Avoid Habit's day: its tick logs a
 * Slip, as a Day Widget tap does. A day in Focus only leaves Focus: ending a
 * session is never a Slip.
 */
export function avoidCompletedRow(row: Task, at: number): Task {
  return row.status === "active" ? { ...row, status: "queued" } : logHabitSlip(row, at);
}

/** Reopening an Avoid Habit's day clears its Slips, so it reads as before any was logged. */
export function avoidReopenedRow(row: Task, at: number): Task {
  const next: Task = { ...row, status: "queued", updatedAt: nextStamp(row, at) };
  delete next.slips;
  delete next.completedAt;
  return next;
}

/**
 * Logs a Slip on an Avoid Habit's `dateKey`, or undoes one, creating the day's
 * Task first when it is missing. False when the Habit is gone, is not an Avoid
 * Habit, its day Task is tombstoned, or there is no Slip to undo.
 */
export function writeHabitSlip(habitId: string, dateKey: string, edit: SlipEdit): Promise<boolean> {
  const now = Date.now();
  return db.transaction("rw", db.habits, db.tasks, async () => {
    const habit = await db.habits.get(habitId);
    if (!habit || habitKindOf(habit) !== "avoid") return false;
    const id = habitTaskId(habitId, dateKey);
    const row = (await db.tasks.get(id)) ?? (hasLocalTaskTombstone(id) ? undefined : buildHabitTaskRow(habit, dateKey));
    if (!row || (edit === "undo" && !row.slips)) return false;
    await db.tasks.put(edit === "log" ? logHabitSlip(row, now) : undoHabitSlip(row, now));
    return true;
  });
}
