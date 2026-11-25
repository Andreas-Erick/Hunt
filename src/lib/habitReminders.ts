import { dateKeyFromOffset, toLocalDateKey } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { completionDateKey } from "./habitDay";
import { habitFrequencyOn, isPerWeekFrequency } from "./habitFrequency";
import { habitDayOutcome } from "./habitOutcome";
import { habitWeekOf } from "./habitWeek";
import { localFireAt, sanitizeHabitReminderTimes, type DueReminder, type ReminderWindow } from "./reminderTime";

/**
 * Habit reminders (ADR-0007): a Habit's reminder times, due on each day it is
 * asked for while that day's Outcome is still Open. Part of the dueReminders
 * rule; pure.
 */

/** The most days one window is walked (a plan reaches 7 days ahead; this only bounds a bad window). */
const MAX_WINDOW_DAYS = 31;

/**
 * Whether a Habit day still wants its reminder: its Outcome, judged on the day
 * itself, is Open. Met, Skipped, unscheduled (null) and Ended days stay quiet.
 * The one seam for Habit Kinds and Habit Weeks: habitDayOutcome judges them,
 * so an Avoid Habit's check-in is due while no Slip ends its day. An N per
 * week day is Open on its own, so its Habit Week is read too: once the week
 * holds N Met days, or was set aside (Skipped), its other days go quiet, as
 * the Today view's skip state reads it.
 */
function wantsReminder(habit: Habit, dayKey: string, dayTaskOn: (dayKey: string) => Task | undefined): boolean {
  const dayOutcomeOn = (day: string) => habitDayOutcome({ habit, dayKey: day, dayTask: dayTaskOn(day), todayKey: dayKey });
  if (dayOutcomeOn(dayKey) !== "open") return false;
  if (!isPerWeekFrequency(habitFrequencyOn(habit, dayKey))) return true;
  // firstDayKey only marks a Partial Week, which is still worth a reminder, so it is not read here.
  const week = habitWeekOf(habit, dayKey, { dayTaskOn, dayOutcomeOn, firstDayKey: "" }, dayKey);
  return !week || (week.met < week.target && !week.skipped);
}

/**
 * Each Habit's day Tasks, by the day they count for: a completed one by
 * completionDateKey (a late tick lands on its scheduled day), any other by
 * scheduledDate. A completed Task wins its day.
 */
function dayTasksByHabit(tasks: readonly Task[], habitIds: ReadonlySet<string>): Map<string, Map<string, Task>> {
  const byHabit = new Map<string, Map<string, Task>>();
  for (const task of tasks) {
    if (!task.habitId || !habitIds.has(task.habitId)) continue;
    const day = completionDateKey(task) ?? task.scheduledDate;
    if (!day) continue;
    let days = byHabit.get(task.habitId);
    if (!days) byHabit.set(task.habitId, (days = new Map()));
    const held = days.get(day);
    if (!held || (held.status !== "completed" && task.status === "completed")) days.set(day, task);
  }
  return byHabit;
}

/** The Habit reminders that fall in `window` (unsorted). */
export function dueHabitReminders(
  habits: readonly Habit[],
  tasks: readonly Task[],
  window: ReminderWindow
): DueReminder[] {
  const timed = habits
    .map((habit) => ({ habit, times: sanitizeHabitReminderTimes(habit.reminderTimes) ?? [] }))
    .filter((h) => h.times.length > 0);
  if (timed.length === 0 || !(window.to > window.from)) return [];
  const dayTasks = dayTasksByHabit(tasks, new Set(timed.map((h) => h.habit.id)));
  const lastDay = toLocalDateKey(window.to - 1);
  const due: DueReminder[] = [];
  let dayKey = toLocalDateKey(window.from);
  for (let n = 0; n < MAX_WINDOW_DAYS && dayKey <= lastDay; n++, dayKey = dateKeyFromOffset(dayKey, 1)) {
    for (const { habit, times } of timed) {
      if (!wantsReminder(habit, dayKey, (day) => dayTasks.get(habit.id)?.get(day))) continue;
      for (const time of times) {
        const fireAt = localFireAt(dayKey, time);
        if (fireAt === null || fireAt < window.from || fireAt >= window.to) continue;
        due.push({
          kind: "habit",
          key: `habit:${habit.id}:${dayKey}T${time}`,
          itemId: habit.id,
          title: habit.title,
          dateKey: dayKey,
          time,
          fireAt,
        });
      }
    }
  }
  return due;
}
