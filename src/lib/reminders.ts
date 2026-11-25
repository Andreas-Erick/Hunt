import type { Habit, Task } from "./domainTypes";
import { dueHabitReminders } from "./habitReminders";
import { isReminderTime, localFireAt, type DueReminder, type ReminderWindow } from "./reminderTime";

export { isReminderTime };
export type { DueReminder, ReminderKind, ReminderWindow } from "./reminderTime";

/**
 * Reminders (ADR-0007): the one rule both apps plan their notifications from.
 * The desktop fires Windows notifications from it while the launcher runs; the
 * phone schedules Android alarms from it. Each re-plans after every save and
 * every sync, so an item finished on the other device goes quiet here too.
 *
 * Pure: no clock, storage or browser API. Times are local wall-clock times.
 */

/** What the rule reads. Snoozes are added here as they arrive. */
export interface ReminderSources {
  /** Every Task the rule may judge: dated ones, and the Habits' day Tasks of any status. */
  tasks: readonly Task[];
  /** Habits with reminder times; each day is judged by its day Task in `tasks`. */
  habits?: readonly Habit[];
}

/** An undone Task: queued or in Focus (done and archived Tasks stay quiet). */
function isUndone(task: Task): boolean {
  return task.status === "queued" || task.status === "active";
}

function taskReminder(task: Task): DueReminder | null {
  const { scheduledDate, reminderTime } = task;
  if (!isUndone(task) || !scheduledDate || !isReminderTime(reminderTime)) return null;
  const fireAt = localFireAt(scheduledDate, reminderTime);
  if (fireAt === null) return null;
  return {
    kind: "task",
    key: `task:${task.id}:${scheduledDate}T${reminderTime}`,
    itemId: task.id,
    title: task.title,
    dateKey: scheduledDate,
    time: reminderTime,
    fireAt,
  };
}

/**
 * The reminders due in `window`, earliest first (ties by key). A Task reminder
 * is due on its scheduled day at its reminder time while the Task is undone; a
 * Habit reminder at each of its times on each day it is asked for while that
 * day's Outcome is Open (habitReminders.ts).
 */
export function dueReminders(sources: ReminderSources, window: ReminderWindow): DueReminder[] {
  const due: DueReminder[] = [];
  for (const task of sources.tasks) {
    const reminder = taskReminder(task);
    if (reminder && reminder.fireAt >= window.from && reminder.fireAt < window.to) {
      due.push(reminder);
    }
  }
  if (sources.habits) due.push(...dueHabitReminders(sources.habits, sources.tasks, window));
  return due.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
