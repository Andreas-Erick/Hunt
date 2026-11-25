import { habitTaskId } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { habitFrequencyOn, isPerWeekFrequency } from "./habitFrequency";
import { habitWeekDays, habitWeekStart } from "./habitWeek";
import { buildHabitTaskRow, skipHabitDayRow } from "./taskQueue";

/**
 * SHARED Skip rule for both apps: the day Task rows to write when the user sets
 * `dayKey` aside (`skipped`) or undoes that, stamped at `at`. Empty when nothing
 * changes. A missing day Task is built by its fixed id; the caller leaves out a
 * tombstoned id.
 *
 * - A daily Habit (every day, chosen weekdays) skips that one day.
 * - An N per week Habit skips its whole Habit Week. The Skip is written on the
 *   day it is made (that day's Task), never on another day's row, so it races
 *   only with a tick of that same day under row-level last-write-wins
 *   (ADR-0001); the week is Skipped while any of its day Tasks is. Undo clears
 *   the flag on every day Task of the week.
 *
 * `habitTasks` are this Habit's day Tasks (others are ignored). Pure.
 */
export function habitSkipRows(
  habit: Habit,
  dayKey: string,
  habitTasks: readonly Task[],
  skipped: boolean,
  at: number
): Task[] {
  const byId = new Map(habitTasks.filter((t) => t.habitId === habit.id).map((t) => [t.id, t]));
  const dayRow = (day: string) => byId.get(habitTaskId(habit.id, day));
  const days = isPerWeekFrequency(habitFrequencyOn(habit, dayKey)) ? habitWeekDays(habitWeekStart(dayKey)) : [dayKey];
  const flagged = days.map(dayRow).filter((t): t is Task => Boolean(t?.skipped));
  if (!skipped) return flagged.map((t) => skipHabitDayRow(t, false, at));
  if (flagged.length > 0) return [];
  return [skipHabitDayRow(dayRow(dayKey) ?? buildHabitTaskRow(habit, dayKey), true, at)];
}
