import type { Habit } from "./domainTypes";
import { REMINDER_LATE_LIMIT_MS } from "./reminderAlarm";
import { reminderAction, type ReminderAction } from "./reminderActions";
import { dueReminders, type DueReminder, type ReminderSources } from "./reminders";
import { sanitizeReminderSnoozes, type ReminderSnooze } from "./reminderSnooze";

/**
 * The phone's Reminder Plan (ADR-0007): the reminders the Android shell arms
 * exact alarms for. The page builds it after every save and every sync and
 * hands it to the shell, which only arms, posts and opens; which reminders are
 * due, and which action each notification offers, is decided here.
 *
 * Pure: `now` is passed in.
 */

/** How far ahead the plan reaches: reminders keep arriving while Hunt stays closed this long. */
export const REMINDER_PLAN_AHEAD_MS = 7 * 24 * 60 * 60_000;
/** The most reminders a plan holds (the earliest ones), so the shell's file stays small. */
export const REMINDER_PLAN_MAX = 64;

/** One planned reminder: what to show, plus what its notification's actions write. */
export type PlannedReminder = DueReminder & {
  /** The Pending Tick its Done or +1 writes; absent when it offers only Snooze. */
  action?: ReminderAction;
  /** Set on a snoozed reminder: the original, which a second Snooze moves the snooze of. */
  snoozeOf?: { key: string; fireAt: number };
};

export interface ReminderPlan {
  /** Bumped when the shape changes; the shell ignores a version it does not know. */
  version: 1;
  /** Earliest first. Each `key` is posted once by the shell, and is the notification tag. */
  reminders: PlannedReminder[];
  /**
   * The snoozes this plan judged (folded in, or dropped because their item is
   * done). The shell stands in only for a snooze stored after it, until the
   * page plans again.
   */
  snoozes: ReminderSnooze[];
}

/** What the plan reads: the rule's sources, and the Habits whose Kind picks Done or +1. */
export type ReminderPlanSources = ReminderSources & { habits?: readonly Habit[] };

/**
 * The reminders due from 10 minutes ago (an alarm that runs late still fires;
 * the shell never posts a key twice) to a week ahead, earliest first.
 */
export function reminderPlan(sources: ReminderPlanSources, now: number): ReminderPlan {
  const snoozes = sanitizeReminderSnoozes(sources.snoozes ?? []);
  const due = dueReminders({ ...sources, snoozes }, { from: now - REMINDER_LATE_LIMIT_MS, to: now + REMINDER_PLAN_AHEAD_MS });
  const reminders = due.slice(0, REMINDER_PLAN_MAX).map((r): PlannedReminder => {
    const action = reminderAction(r, sources.habits);
    return action ? { ...r, action } : r;
  });
  return { version: 1, reminders, snoozes };
}
