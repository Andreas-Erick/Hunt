import { REMINDER_LATE_LIMIT_MS } from "./reminderAlarm";
import { dueReminders, type DueReminder, type ReminderSources } from "./reminders";

/**
 * The phone's Reminder Plan (ADR-0007): the reminders the Android shell arms
 * exact alarms for. The page builds it after every save and every sync and
 * hands it to the shell, which only arms, posts and opens; which reminders are
 * due is decided here, by the shared dueReminders rule.
 *
 * Pure: `now` is passed in.
 */

/** How far ahead the plan reaches: reminders keep arriving while Hunt stays closed this long. */
export const REMINDER_PLAN_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** The most reminders a plan holds (the earliest ones), so the shell's file stays small. */
export const REMINDER_PLAN_MAX = 64;

export interface ReminderPlan {
  /** Bumped when the shape changes; the shell ignores a version it does not know. */
  version: 1;
  /** Earliest first. Each `key` is posted once by the shell, and is the notification tag. */
  reminders: DueReminder[];
}

/**
 * The reminders due from 10 minutes ago (an alarm that runs late still fires;
 * the shell never posts a key twice) to a week ahead, earliest first.
 */
export function reminderPlan(sources: ReminderSources, now: number): ReminderPlan {
  const due = dueReminders(sources, { from: now - REMINDER_LATE_LIMIT_MS, to: now + REMINDER_PLAN_AHEAD_MS });
  return { version: 1, reminders: due.slice(0, REMINDER_PLAN_MAX) };
}
