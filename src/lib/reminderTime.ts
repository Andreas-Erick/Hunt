/**
 * Reminder times (ADR-0007): the one shape a reminder time takes, when it
 * fires, and the shape of a due reminder. Shared by the Task and Habit reminder
 * rules (reminders.ts, habitReminders.ts). Pure.
 */

/** What a reminder is for: a dated Task, or a Habit day. Snoozes join later. */
export type ReminderKind = "task" | "habit";

/** One reminder that is due. `kind` names its source, so callers switch on it. */
export interface DueReminder {
  kind: ReminderKind;
  /**
   * Stable per item and fire time: a device notifies each key once, and the
   * key doubles as the notification tag so two windows replace, not stack.
   */
  key: string;
  /** The Task's id, or the Habit's id. */
  itemId: string;
  title: string;
  /** The day it fires on (YYYY-MM-DD, local). */
  dateKey: string;
  /** Local "HH:MM". */
  time: string;
  /** Epoch ms of `dateKey` at `time` in the device's time zone. */
  fireAt: number;
}

/** A half-open time window, epoch ms: `from <= fireAt < to`. */
export interface ReminderWindow {
  from: number;
  to: number;
}

const REMINDER_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a local 24-hour "HH:MM", the only shape a reminder time takes. */
export function isReminderTime(value: unknown): value is string {
  return typeof value === "string" && REMINDER_TIME_RE.test(value);
}

/** Epoch ms of local `dateKey` at local `time`, or null for a malformed date. */
export function localFireAt(dateKey: string, time: string): number | null {
  const m = DATE_KEY_RE.exec(dateKey);
  if (!m) return null;
  const [hour, minute] = time.split(":").map(Number);
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute).getTime();
  return Number.isFinite(at) ? at : null;
}

/** Most reminder times one Habit keeps. */
export const MAX_HABIT_REMINDER_TIMES = 6;

/**
 * A Habit's reminder times in stored form: well-formed ones only, ascending,
 * without repeats, at most MAX_HABIT_REMINDER_TIMES (the earliest). Also the
 * sync boundary's check: undefined when nothing valid is left.
 */
export function sanitizeHabitReminderTimes(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const times = Array.from(new Set(raw.filter(isReminderTime))).sort().slice(0, MAX_HABIT_REMINDER_TIMES);
  return times.length > 0 ? times : undefined;
}
