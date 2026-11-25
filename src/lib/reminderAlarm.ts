import type { Task } from "./domainTypes";
import { dueReminders, type DueReminder, type ReminderSources } from "./reminders";
import type { ReminderSnooze } from "./reminderSnooze";

/**
 * The desktop's reminder alarm (ADR-0007): one timer, always set for the next
 * due reminder. When it rings it re-reads the Tasks and asks the shared
 * dueReminders rule what is due since it last looked, so a Task finished
 * meanwhile (here, or on the phone and then synced) stays quiet. Each save and
 * each sync calls replan(), which also catches a reminder set or moved while
 * the alarm runs.
 *
 * Framework-free: storage and the notification are injected (see
 * desktopReminders.ts for the wiring), so the timing is tested with fake timers.
 */

/** A reminder missed by more than this (a PC asleep at the time) is dropped, not fired late. */
export const REMINDER_LATE_LIMIT_MS = 10 * 60_000;
/** The timer never sleeps longer, so a clock change or a wake from sleep is noticed within it. */
const MAX_WAIT_MS = 60 * 60_000;
/** How long to wait before reading again after a failed read. */
const RETRY_MS = 60_000;

export interface ReminderAlarmDeps {
  /** Every undone Task (done ones may be included; the rule skips them). */
  readTasks: () => Promise<readonly Task[]>;
  /** This device's Snoozes (reminderSnooze.ts), read with the Tasks. */
  readSnoozes?: () => readonly ReminderSnooze[];
  notify: (reminder: DueReminder) => void;
  /** A failed read or notification; the alarm keeps running. */
  onError?: (error: unknown) => void;
}

export interface ReminderAlarm {
  /** Re-read the Tasks now: call after every save and every sync. */
  replan: () => void;
  stop: () => void;
}

export function startReminderAlarm(deps: ReminderAlarmDeps): ReminderAlarm {
  /** Reminders before this instant have been handled (or predate the launch). */
  let checkedUpTo = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let stopped = false;

  const arm = (delayMs: number) => {
    if (timer !== null) clearTimeout(timer);
    timer = stopped ? null : setTimeout(run, Math.max(0, Math.min(delayMs, MAX_WAIT_MS)));
  };

  const fireDue = (sources: ReminderSources, now: number) => {
    const from = Math.max(checkedUpTo, now - REMINDER_LATE_LIMIT_MS);
    checkedUpTo = now + 1;
    for (const reminder of dueReminders(sources, { from, to: now + 1 })) {
      try {
        deps.notify(reminder);
      } catch (err) {
        deps.onError?.(err);
      }
    }
  };

  async function run(): Promise<void> {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const sources: ReminderSources = { tasks: await deps.readTasks(), snoozes: deps.readSnoozes?.() };
      if (stopped) return;
      const now = Date.now();
      fireDue(sources, now);
      const [next] = dueReminders(sources, { from: now + 1, to: now + 1 + MAX_WAIT_MS });
      arm(next ? next.fireAt - now : MAX_WAIT_MS);
    } catch (err) {
      deps.onError?.(err);
      arm(RETRY_MS);
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        void run();
      }
    }
  }

  void run();
  return {
    replan: () => void run(),
    stop: () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
