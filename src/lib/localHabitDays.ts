import { db } from "./db";
import { changed, emitChange } from "./localChange";
import { habitTaskId } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { correctHabitDayRow, type HabitDayMark } from "./habitCalendar";
import { isHabitScheduledOn } from "./habitFrequency";
import { habitSkipRows } from "./habitSkip";
import { habitWeekDays, habitWeekStart } from "./habitWeek";
import { hasLocalTaskTombstone } from "./syncTombstones";
import { buildHabitTaskRow, nextStamp } from "./taskQueue";

/**
 * The Local Store's habit day writes (localStore.ts exposes them): one day
 * Task made on demand, Skips (an N per week Habit's whole Habit Week) and
 * calendar corrections, each through the shared rule the phone uses too.
 */

/**
 * One habit's instance for `dateKey`, materializing the day first when it is
 * missing. Undefined when the habit is gone or the instance is tombstoned.
 */
export async function ensureHabitTaskForDay(habitId: string, dateKey: string): Promise<Task | undefined> {
  const id = habitTaskId(habitId, dateKey);
  const existing = await db.tasks.get(id);
  if (existing) return existing;
  const habit = await db.habits.get(habitId);
  if (!habit || !isHabitScheduledOn(habit, dateKey) || hasLocalTaskTombstone(id)) return undefined;
  await db.tasks.put(buildHabitTaskRow(habit, dateKey));
  emitChange();
  return db.tasks.get(id);
}

/** Every habit day Task of the Habit Week holding `dateKey`. */
export async function habitWeekTasks(dateKey: string): Promise<Task[]> {
  const days = habitWeekDays(habitWeekStart(dateKey));
  return (await db.tasks.where("scheduledDate").between(days[0], days[6], true, true).toArray()).filter((t) => t.habitId);
}

/** Sets a habit day (an N per week Habit: its Habit Week) Skipped or back: the rows habitSkipRows builds. */
export async function setHabitDaySkipped(habitId: string, dateKey: string, skipped: boolean): Promise<boolean> {
  const wrote = await db.transaction("rw", db.habits, db.tasks, async () => {
    // A day Task whose Habit row is gone (not synced yet) is judged as an old daily row.
    const habit = (await db.habits.get(habitId)) ?? ({ id: habitId } as Habit);
    const weekTasks = await habitWeekTasks(dateKey);
    const rows = habitSkipRows(habit, dateKey, weekTasks, skipped, Date.now());
    const known = habit.title === undefined ? new Set(weekTasks.map((t) => t.id)) : null;
    const allowed = rows.filter((t) => !hasLocalTaskTombstone(t.id) && (!known || known.has(t.id)));
    // An un-Skipped row is stored without the flag (`skipped: undefined` would keep the key).
    const stored = allowed.map(({ skipped: flag, ...rest }) => (flag ? { ...rest, skipped: flag } : rest));
    if (stored.length > 0) await db.tasks.bulkPut(stored);
    return allowed.length > 0;
  });
  return changed(wrote);
}

/** Ticks, unticks or Skips one habit day from its calendar, materializing it first: the correctHabitDayRow row. */
export async function correctHabitDay(habitId: string, dateKey: string, mark: HabitDayMark): Promise<boolean> {
  const day = await ensureHabitTaskForDay(habitId, dateKey);
  if (!day) return false;
  const at = Date.now();
  const wrote = await db.transaction("rw", db.tasks, db.habits, async () => {
    const row = await db.tasks.get(day.id);
    // A Count Habit's day is corrected through the Count rule (its total follows the mark).
    const next = row && correctHabitDayRow(row, mark, at, await db.habits.get(habitId));
    if (!row || !next || next === row) return false;
    await db.tasks.update(row.id, { ...next, updatedAt: nextStamp(row) });
    return true;
  });
  return changed(wrote);
}
