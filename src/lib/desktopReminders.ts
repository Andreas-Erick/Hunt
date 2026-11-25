"use client";

import { liveQuery } from "dexie";
import { logDiagnostic, summarizeError } from "./diagnostics";
import { reads } from "./reads";
import {
  listenForReminderActions,
  readDesktopSnoozes,
  reminderNotificationActions,
  reminderWorker,
  runReminderAction,
  saveDesktopSnooze,
  type ReminderActionDeps,
  type ReminderNotificationData,
} from "./desktopReminderActions";
import { reminderAction } from "./reminderActions";
import { startReminderAlarm } from "./reminderAlarm";
import type { DueReminder } from "./reminders";

/**
 * Windows notifications for Task reminders (ADR-0007), while the launcher's
 * window is open. The launcher's Chromium window turns a Web Notification into
 * a Windows toast. A tablet on the LAN URL has no Notification API (plain http
 * is not a secure context), so it never fires: the phone app covers it.
 */

/** Where notifications stand on this device: the browser's permission, or "unsupported". */
export type NotificationAccess = NotificationPermission | "unsupported";

export function notificationAccess(): NotificationAccess {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }
  return window.Notification.permission;
}

/**
 * Asks for the notification permission when it was never asked (the first
 * time a reminder is set); answers where it stands afterwards.
 */
export async function ensureNotificationAccess(): Promise<NotificationAccess> {
  const access = notificationAccess();
  if (access !== "default") return access;
  try {
    return await window.Notification.requestPermission();
  } catch (err) {
    logDiagnostic({
      level: "WARN",
      domain: "reminders",
      event: "notification_permission_failed",
      context: summarizeError(err),
    });
    return notificationAccess();
  }
}

/**
 * Shows one reminder. With a service worker it carries Done (or +1) and Snooze
 * buttons (desktopReminderActions.ts); without one, a plain notification.
 */
async function showReminder(reminder: DueReminder, worker: ServiceWorkerRegistration | null, withActions: boolean): Promise<void> {
  if (notificationAccess() !== "granted") return;
  const options = {
    body: `Reminder · ${reminder.time}`,
    // The same key in two windows replaces one toast instead of stacking two.
    tag: reminder.key,
    icon: "/icon.svg",
  };
  if (worker) {
    const habits = reminder.kind === "task" ? [] : await reads.habits();
    const action = withActions ? reminderAction(reminder, habits) : null;
    const data: ReminderNotificationData = { reminder, action };
    const actions = withActions ? reminderNotificationActions(action) : [];
    // `actions` is not in TypeScript's NotificationOptions yet; Chromium shows them as toast buttons.
    await worker.showNotification(reminder.title, { ...options, data, actions } as NotificationOptions);
    return;
  }
  const note = new window.Notification(reminder.title, options);
  note.onclick = () => {
    window.focus();
    note.close();
  };
}

/**
 * Starts the alarm and re-plans it whenever the Tasks change: Dexie's live
 * query fires after every local save and every sync that writes Tasks.
 * With `actions` (the command store's writes), notifications offer Done or +1
 * and Snooze where a service worker can show them. Returns the stop function.
 */
export function startDesktopReminders(actions?: ReminderActionDeps): () => void {
  if (notificationAccess() === "unsupported") return () => {};
  const onError = (err: unknown) =>
    logDiagnostic({
      level: "WARN",
      domain: "reminders",
      event: "reminder_alarm_failed",
      context: summarizeError(err),
    });
  const worker = actions ? reminderWorker() : Promise.resolve(null);
  const notify = (reminder: DueReminder) =>
    void worker.then((w) => showReminder(reminder, w, !!actions)).catch(onError);
  const alarm = startReminderAlarm({ readTasks: reads.undoneTasks, readSnoozes: readDesktopSnoozes, notify, onError });
  const subscription = liveQuery(reads.undoneTasks).subscribe({
    next: () => alarm.replan(),
    error: onError,
  });
  const stopListening = actions
    ? listenForReminderActions(
        ({ reminder, action }) => void runReminderAction(action, reminder, actions).catch(onError),
        ({ reminder }) => {
          if (saveDesktopSnooze(reminder, Date.now())) alarm.replan();
          else onError(new Error("Saving a snooze failed: browser storage is unavailable"));
        }
      )
    : () => {};
  return () => {
    stopListening();
    subscription.unsubscribe();
    alarm.stop();
  };
}
