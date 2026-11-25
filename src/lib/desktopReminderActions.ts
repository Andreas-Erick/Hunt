"use client";

import type { Task } from "./domainTypes";
import type { ReminderAction, ReminderTarget } from "./reminderActions";
import type { DueReminder } from "./reminders";
import { sanitizeReminderSnoozes, snoozeReminder, type ReminderSnooze } from "./reminderSnooze";

/**
 * Desktop notification actions (ADR-0007). A Web Notification shown through a
 * service worker can carry buttons, which the launcher's Chromium window turns
 * into Windows toast buttons; a plain `new Notification` cannot. The worker
 * (public/hunt-reminder-sw.js) hands a pressed button to one open Hunt window,
 * which applies it here through the command store. Snoozes are kept in this
 * browser only and folded into dueReminders by the alarm.
 */

/** The worker's message type, and the script it runs from. */
export const REMINDER_ACTION_MESSAGE = "hunt-reminder-action";
const WORKER_URL = "/hunt-reminder-sw.js";
const SNOOZES_KEY = "hunt-reminder-snoozes-v1";

/** What a pressed button needs: the reminder and the tick its Done or +1 writes. */
export interface ReminderNotificationData {
  reminder: DueReminder;
  action: ReminderAction | null;
}

/** The command store's writes an action goes through. */
export interface ReminderActionDeps {
  completeTask: (taskId: string) => Promise<void>;
  /** A Habit's day Task, made first when missing; undefined when the Habit is gone. */
  ensureHabitDay: (habitId: string, dateKey: string) => Promise<Task | undefined>;
  /** One more on a Count Habit's day. */
  addCount: (habitId: string, dateKey: string) => Promise<void>;
}

/** The buttons a reminder's notification shows: its Done or +1, then Snooze 10 min. */
export function reminderNotificationActions(action: ReminderAction | null): { action: string; title: string }[] {
  const snooze = { action: "snooze", title: "Snooze 10 min" };
  if (!action) return [snooze];
  return [{ action: "tick", title: action.tick === "+1" ? "+1" : "Done" }, snooze];
}

/** Applies a pressed Done or +1. A Habit's day Task is made first when missing; one already done stays done. */
export async function runReminderAction(action: ReminderAction, reminder: ReminderTarget, deps: ReminderActionDeps): Promise<void> {
  if (reminder.kind !== "habit") {
    await deps.completeTask(action.taskId);
    return;
  }
  if (action.tick === "+1") {
    await deps.addCount(reminder.itemId, reminder.dateKey);
    return;
  }
  const day = await deps.ensureHabitDay(reminder.itemId, reminder.dateKey);
  if (day && day.status !== "completed") await deps.completeTask(day.id);
}

/** This browser's snoozes; none when storage is unavailable. */
export function readDesktopSnoozes(): ReminderSnooze[] {
  try {
    return sanitizeReminderSnoozes(JSON.parse(localStorage.getItem(SNOOZES_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** Stores a Snooze of `reminder` from `now`; ended snoozes are dropped. False when storage failed. */
export function saveDesktopSnooze(reminder: DueReminder, now: number): boolean {
  const next = snoozeReminder(reminder, now);
  const kept = readDesktopSnoozes().filter((s) => s.key !== next.key && s.until > now - 60 * 60_000);
  try {
    localStorage.setItem(SNOOZES_KEY, JSON.stringify([next, ...kept]));
    return true;
  } catch {
    return false;
  }
}

/** The service worker that shows notifications with buttons, or null where there is none (plain http). */
export async function reminderWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return null;
  try {
    await navigator.serviceWorker.register(WORKER_URL);
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/**
 * Listens for pressed buttons; returns the stop function. `onTick` applies a
 * Done or +1, `onSnooze` stores a Snooze.
 */
export function listenForReminderActions(
  onTick: (data: ReminderNotificationData & { action: ReminderAction }) => void,
  onSnooze: (data: ReminderNotificationData) => void
): () => void {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return () => {};
  const onMessage = (event: MessageEvent) => {
    const msg = event.data as { type?: unknown; action?: unknown; data?: ReminderNotificationData } | null;
    if (!msg || msg.type !== REMINDER_ACTION_MESSAGE || !msg.data?.reminder) return;
    const { data } = msg;
    if (msg.action === "snooze") onSnooze(data);
    else if (msg.action === "tick" && data.action) onTick({ ...data, action: data.action });
  };
  navigator.serviceWorker.addEventListener("message", onMessage as EventListener);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage as EventListener);
}
