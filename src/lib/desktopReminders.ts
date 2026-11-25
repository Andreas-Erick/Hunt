"use client";

import { liveQuery } from "dexie";
import { logDiagnostic, summarizeError } from "./diagnostics";
import { reads } from "./reads";
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

function showReminder(reminder: DueReminder): void {
  if (notificationAccess() !== "granted") return;
  const note = new window.Notification(reminder.title, {
    body: `Reminder · ${reminder.time}`,
    // The same key in two windows replaces one toast instead of stacking two.
    tag: reminder.key,
    icon: "/icon.svg",
  });
  note.onclick = () => {
    window.focus();
    note.close();
  };
}

/**
 * Starts the alarm and re-plans it whenever the Tasks change: Dexie's live
 * query fires after every local save and every sync that writes Tasks.
 * Returns the stop function.
 */
export function startDesktopReminders(): () => void {
  if (notificationAccess() === "unsupported") return () => {};
  const onError = (err: unknown) =>
    logDiagnostic({
      level: "WARN",
      domain: "reminders",
      event: "reminder_alarm_failed",
      context: summarizeError(err),
    });
  const alarm = startReminderAlarm({ readTasks: reads.undoneTasks, notify: showReminder, onError });
  const subscription = liveQuery(reads.undoneTasks).subscribe({
    next: () => alarm.replan(),
    error: onError,
  });
  return () => {
    subscription.unsubscribe();
    alarm.stop();
  };
}
