import type { Task } from "./domainTypes";
import { snoozedReminders, type ReminderSnooze } from "./reminderSnooze";

/**
 * Reminders (ADR-0007): the one rule both apps plan their notifications from.
 * The desktop fires Windows notifications from it while the launcher runs; the
 * phone schedules Android alarms from it. Each re-plans after every save and
 * every sync, so an item finished on the other device goes quiet here too.
 *
 * Pure: no clock, storage or browser API. Times are local wall-clock times.
 */

const REMINDER_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a local 24-hour "HH:MM", the only shape a reminder time takes. */
export function isReminderTime(value: unknown): value is string {
  return typeof value === "string" && REMINDER_TIME_RE.test(value);
}

/**
 * One reminder that is due. `kind` names its source; Habit reminders and
 * snoozes join the union later, so callers switch on it.
 */
export interface DueReminder {
  kind: "task";
  /**
   * Stable per item and fire time: a device notifies each key once, and the
   * key doubles as the notification tag so two windows replace, not stack.
   */
  key: string;
  /** The Task's id. */
  itemId: string;
  title: string;
  /** The day it fires on (YYYY-MM-DD, local). */
  dateKey: string;
  /** Local "HH:MM". */
  time: string;
  /** Epoch ms of `dateKey` at `time` in the device's time zone. */
  fireAt: number;
}

/** What the rule reads. Habits are added here as they arrive. */
export interface ReminderSources {
  tasks: readonly Task[];
  /** This device's Snoozes (reminderSnooze.ts); each re-fires while its reminder is still due. */
  snoozes?: readonly ReminderSnooze[];
}

/** A half-open time window, epoch ms: `from <= fireAt < to`. */
export interface ReminderWindow {
  from: number;
  to: number;
}

/** Epoch ms of local `dateKey` at local `time`, or null for a malformed date. */
function localFireAt(dateKey: string, time: string): number | null {
  const m = DATE_KEY_RE.exec(dateKey);
  if (!m) return null;
  const [hour, minute] = time.split(":").map(Number);
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute).getTime();
  return Number.isFinite(at) ? at : null;
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
 * is due on its scheduled day at its reminder time while the Task is undone.
 * A Snooze re-fires its reminder at its end while that reminder is still due.
 */
export function dueReminders(sources: ReminderSources, window: ReminderWindow): DueReminder[] {
  const due = unsnoozedDue(sources, window);
  if (sources.snoozes) due.push(...snoozedReminders(sources.snoozes, (w) => unsnoozedDue(sources, w), window));
  return due.sort((a, b) => a.fireAt - b.fireAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** dueReminders without the snoozes, unsorted. */
function unsnoozedDue(sources: ReminderSources, window: ReminderWindow): DueReminder[] {
  const due: DueReminder[] = [];
  for (const task of sources.tasks) {
    const reminder = taskReminder(task);
    if (reminder && reminder.fireAt >= window.from && reminder.fireAt < window.to) {
      due.push(reminder);
    }
  }
  return due;
}
