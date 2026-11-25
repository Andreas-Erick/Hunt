"use client";

import { liveQuery } from "dexie";
import { useCommandStore } from "@/store/useCommandStore";
import { dateKeyFromOffset, toLocalDateKey } from "./dateUtils";
import { logDiagnostic, summarizeError } from "./diagnostics";
import { reads } from "./reads";
import { startReminderAlarm } from "./reminderAlarm";
import type { DueReminder, ReminderSources } from "./reminders";

/**
 * Windows notifications for Task and Habit reminders (ADR-0007), while the launcher's
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
 * What the rule reads: the undone Tasks, the Habits, and their day Tasks from
 * yesterday on (any status, so a Met or Skipped day stays quiet).
 */
async function readReminderSources(): Promise<ReminderSources> {
  const since = dateKeyFromOffset(toLocalDateKey(), -1);
  const [undone, habitTasks, habits] = await Promise.all([reads.undoneTasks(), reads.habitTasks(), reads.habits()]);
  const tasks = new Map(undone.map((t) => [t.id, t]));
  for (const t of habitTasks) if ((t.scheduledDate ?? "") >= since) tasks.set(t.id, t);
  return { tasks: [...tasks.values()], habits };
}

/** How long a click keeps looking for the Habit's card while the Habits view renders. */
const REVEAL_TRIES = 20;
const REVEAL_STEP_MS = 100;

/** Scrolls the Habit's card into view once the Habits view has drawn it. */
function revealHabitCard(habitId: string, triesLeft = REVEAL_TRIES): void {
  const card = Array.from(document.querySelectorAll<HTMLElement>("[data-habit-id]")).find(
    (el) => el.dataset.habitId === habitId
  );
  if (card) card.scrollIntoView?.({ block: "center" });
  else if (triesLeft > 0) setTimeout(() => revealHabitCard(habitId, triesLeft - 1), REVEAL_STEP_MS);
}

/** A click opens Hunt on the item: a Habit opens Habits at its card; a Task just focuses Hunt. */
function openReminder(reminder: DueReminder): void {
  window.focus();
  if (reminder.kind !== "habit") return;
  useCommandStore.getState().setActiveView("habits");
  revealHabitCard(reminder.itemId);
}

function showReminder(reminder: DueReminder): void {
  if (notificationAccess() !== "granted") return;
  const note = new window.Notification(reminder.title, {
    body: `${reminder.kind === "habit" ? "Habit reminder" : "Reminder"} · ${reminder.time}`,
    // The same key in two windows replaces one toast instead of stacking two.
    tag: reminder.key,
    icon: "/icon.svg",
  });
  note.onclick = () => {
    openReminder(reminder);
    note.close();
  };
}

/**
 * Starts the alarm and re-plans it whenever the Tasks or Habits change:
 * Dexie's live query fires after every local save and every sync that writes
 * them. Returns the stop function.
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
  const alarm = startReminderAlarm({ readSources: readReminderSources, notify: showReminder, onError });
  const subscription = liveQuery(readReminderSources).subscribe({
    next: () => alarm.replan(),
    error: onError,
  });
  return () => {
    subscription.unsubscribe();
    alarm.stop();
  };
}
