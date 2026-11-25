import { db } from "./db";
import { habitTaskId } from "./dateUtils";
import type { Habit, HabitKind, Task } from "./domainTypes";
import { addHabitDayCount, setHabitDayAmount } from "./habitCount";
import { habitKindOf, isCountTarget, MAX_COUNT_UNIT_LENGTH } from "./habitKind";
import { hasLocalTaskTombstone } from "./syncTombstones";
import { buildHabitTaskRow, completeTaskRow, nextStamp } from "./taskQueue";

/**
 * The Local Store's Count Habit writes (localStore.ts calls these and emits
 * its change signal). Every total goes through the shared Count rule
 * (habitCount.ts), as on the phone, so a day's total and its tick never
 * disagree on either device.
 */

/** What a new habit is made from; a Count Habit also needs a positive target. */
export interface NewHabit {
  title: string;
  notes?: string;
  questId: string | null;
  /** Habit Kind, fixed once the Habit is made; defaults to "check". */
  kind?: HabitKind;
  target?: number;
  unit?: string;
}

/** A unit as stored: trimmed and cut to MAX_COUNT_UNIT_LENGTH. */
const cleanUnit = (unit: string | undefined) => (unit ?? "").trim().slice(0, MAX_COUNT_UNIT_LENGTH);

/** A new habit's Kind fields, or null for a Count Habit without a usable target. */
export function newHabitKindFields(params: NewHabit): Partial<Habit> | null {
  const kind = habitKindOf(params);
  if (kind !== "count") return { kind };
  return isCountTarget(params.target) ? { kind, target: params.target, unit: cleanUnit(params.unit) } : null;
}

/** An edit's valid target and unit for a Count Habit (its Kind itself never changes). */
export function countFieldChanges(row: Habit, changes: Partial<Pick<Habit, "target" | "unit">>): Partial<Habit> {
  if (habitKindOf(row) !== "count") return {};
  const patch: Partial<Habit> = {};
  if (isCountTarget(changes.target)) patch.target = changes.target;
  if (typeof changes.unit === "string") patch.unit = cleanUnit(changes.unit);
  return patch;
}

/** The Count Habit a day Task belongs to, or undefined. Inside a transaction over habits. */
async function countHabitOf(task: Task): Promise<Habit | undefined> {
  const habit = task.habitId ? await db.habits.get(task.habitId) : undefined;
  return habit && habitKindOf(habit) === "count" ? habit : undefined;
}

/**
 * The row "complete this Task" writes. A Count Habit's day is not ticked but
 * counted: one more (the shared +1 rule), completing it once its total reaches
 * the target, so a tick from any list keeps the total and the Outcome in step.
 * Its Focus ends either way, so a day in Focus is counted as an open one.
 * Inside a transaction over tasks and habits.
 */
export async function completedRow(row: Task, completedAt: number): Promise<Task> {
  const habit = await countHabitOf(row);
  if (!habit) return completeTaskRow(row, completedAt);
  return addHabitDayCount(row.status === "active" ? { ...row, status: "queued" } : row, habit, completedAt);
}

/** Reopens a Task; a Count Habit's day is reopened by clearing its total. False when it is gone. */
export function reopenTaskRow(taskId: string): Promise<boolean> {
  return db.transaction("rw", db.tasks, db.habits, async () => {
    const row = await db.tasks.get(taskId);
    if (!row) return false;
    const habit = await countHabitOf(row);
    const now = Date.now();
    if (habit) await db.tasks.put(setHabitDayAmount(row, habit, 0, now));
    else await db.tasks.update(taskId, { status: "queued", completedAt: undefined, updatedAt: nextStamp(row, now) });
    return true;
  });
}

/**
 * Sets a Count Habit's total for `dateKey` (exact entry), or adds one with
 * `"+1"`, creating the day's Task first when it is missing. False when the
 * Habit is gone, is not a Count Habit, or its day Task is tombstoned.
 */
export function writeHabitAmount(habitId: string, dateKey: string, amount: number | "+1"): Promise<boolean> {
  const now = Date.now();
  return db.transaction("rw", db.habits, db.tasks, async () => {
    const habit = await db.habits.get(habitId);
    if (!habit || habitKindOf(habit) !== "count") return false;
    const id = habitTaskId(habitId, dateKey);
    const row = (await db.tasks.get(id)) ?? (hasLocalTaskTombstone(id) ? undefined : buildHabitTaskRow(habit, dateKey));
    if (!row) return false;
    await db.tasks.put(amount === "+1" ? addHabitDayCount(row, habit, now) : setHabitDayAmount(row, habit, amount, now));
    return true;
  });
}
