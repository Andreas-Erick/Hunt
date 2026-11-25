"use client";

import { liveQuery } from "dexie";
import { useCommandStore } from "@/store/useCommandStore";
import { dateKeyFromOffset, toLocalDateKey } from "./dateUtils";
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
import type { Habit } from "./domainTypes";
import { requestOpenTask, revealWhenDrawn } from "./openItemRequest";
import { isSlipCheckIn, reminderAction, SLIP_CHECK_IN_TEXT } from "./reminderActions";
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
 * What the rule reads: the undone Tasks, the Habits, their day Tasks from
 * yesterday on (any status, so a Met or Skipped day stays quiet), and this
 * browser's Snoozes.
 */
async function readReminderSources(): Promise<ReminderSources> {
  const since = dateKeyFromOffset(toLocalDateKey(), -1);
  const [undone, habitTasks, habits] = await Promise.all([reads.undoneTasks(), reads.habitTasks(), reads.habits()]);
  const tasks = new Map(undone.map((t) => [t.id, t]));
  for (const t of habitTasks) if ((t.scheduledDate ?? "") >= since) tasks.set(t.id, t);
  return { tasks: [...tasks.values()], habits, snoozes: readDesktopSnoozes() };
}

/**
 * A click opens Hunt on the item: a Habit opens Habits at its card (where an
 * Avoid Habit's Slip is logged); a Task opens Today with its row's drawer open.
 */
function openReminder(reminder: DueReminder): void {
  window.focus();
  const { setActiveView } = useCommandStore.getState();
  if (reminder.kind === "habit") {
    setActiveView("habits");
    revealWhenDrawn("habitId", reminder.itemId);
    return;
  }
  setActiveView("command");
  requestOpenTask(reminder.itemId);
}

/** A notification's text: the Task or Habit reminder and its time, or an Avoid Habit's Slip check-in. */
function reminderBody(reminder: DueReminder, habits: readonly Habit[]): string {
  const text = isSlipCheckIn(reminder, habits)
    ? SLIP_CHECK_IN_TEXT
    : reminder.kind === "habit"
    ? "Habit reminder"
    : "Reminder";
  return `${text} · ${reminder.time}`;
}

/**
 * Shows one reminder. With a service worker it carries Done (or +1) and Snooze
 * buttons (desktopReminderActions.ts); without one, a plain notification.
 * Either way a click opens the item (openReminder).
 */
async function showReminder(reminder: DueReminder, worker: ServiceWorkerRegistration | null, withActions: boolean): Promise<void> {
  if (notificationAccess() !== "granted") return;
  const habits = reminder.kind === "task" ? [] : await reads.habits();
  const options = {
    body: reminderBody(reminder, habits),
    // The same key in two windows replaces one toast instead of stacking two.
    tag: reminder.key,
    icon: "/icon.svg",
  };
  if (worker) {
    const action = withActions ? reminderAction(reminder, habits) : null;
    const data: ReminderNotificationData = { reminder, action };
    const actions = withActions ? reminderNotificationActions(action) : [];
    // `actions` is not in TypeScript's NotificationOptions yet; Chromium shows them as toast buttons.
    await worker.showNotification(reminder.title, { ...options, data, actions } as NotificationOptions);
    return;
  }
  const note = new window.Notification(reminder.title, options);
  note.onclick = () => {
    openReminder(reminder);
    note.close();
  };
}

/**
 * Starts the alarm and re-plans it whenever the Tasks or Habits change:
 * Dexie's live query fires after every local save and every sync that writes
 * them. With `actions` (the command store's writes), notifications offer Done
 * or +1 and Snooze where a service worker can show them. Returns the stop
 * function.
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
  const alarm = startReminderAlarm({ readSources: readReminderSources, notify, onError });
  const subscription = liveQuery(readReminderSources).subscribe({
    next: () => alarm.replan(),
    error: onError,
  });
  const stopListening = actions
    ? listenForReminderActions(
        ({ reminder, action }) => void runReminderAction(action, reminder, actions).catch(onError),
        ({ reminder }) => {
          if (saveDesktopSnooze(reminder, Date.now())) alarm.replan();
          else onError(new Error("Saving a snooze failed: browser storage is unavailable"));
        },
        ({ reminder }) => openReminder(reminder)
      )
    : () => {};
  return () => {
    stopListening();
    subscription.unsubscribe();
    alarm.stop();
  };
}
