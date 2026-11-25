/**
 * Snooze 10 min (ADR-0007): a notification's Snooze stores, on the device that
 * showed it, which reminder was snoozed and until when. The shared
 * dueReminders rule folds the stored snoozes in, so a snooze re-fires only
 * while the reminder it snoozes would still be due: an item finished
 * meanwhile, here or synced from the other device, stays quiet. Snoozes are
 * device-local and never synced. Pure.
 */

/** How long Snooze waits. */
export const REMINDER_SNOOZE_MS = 10 * 60_000;
/** The most snoozes a device keeps (the latest ends win). */
const MAX_SNOOZES = 64;

/** One stored snooze: the reminder it snoozes (by key and original fire time) and when it fires again. */
export interface ReminderSnooze {
  key: string;
  fireAt: number;
  until: number;
}

/** What a snooze needs of a reminder (a DueReminder, see reminders.ts). */
interface Snoozable {
  key: string;
  fireAt: number;
  /** Set on a snoozed reminder: the original, so a second Snooze moves this snooze rather than snoozing the snooze. */
  snoozeOf?: { key: string; fireAt: number };
}

/** A snoozed reminder as dueReminders answers it: the original, firing at the snooze's end. */
export type SnoozedReminder<R extends Snoozable> = R & { snoozeOf: { key: string; fireAt: number } };

/** The snooze a tap on Snooze at `now` stores for `reminder` (a snoozed one snoozes its original). */
export function snoozeReminder(reminder: Snoozable, now: number): ReminderSnooze {
  const base = reminder.snoozeOf ?? reminder;
  return { key: base.key, fireAt: base.fireAt, until: now + REMINDER_SNOOZE_MS };
}

const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Stored snoozes as the rule reads them: well-formed ones only, one per
 * reminder (the latest end), at most MAX_SNOOZES. Anything else reads as none.
 */
export function sanitizeReminderSnoozes(raw: unknown): ReminderSnooze[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, ReminderSnooze>();
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const { key, fireAt, until } = s as Record<string, unknown>;
    if (typeof key !== "string" || key === "" || !isTime(fireAt) || !isTime(until)) continue;
    const held = byKey.get(key);
    if (!held || held.until < until) byKey.set(key, { key, fireAt, until });
  }
  return [...byKey.values()].sort((a, b) => b.until - a.until).slice(0, MAX_SNOOZES);
}

/**
 * The snoozes ending in `window`, each as the reminder it snoozes. `baseDue`
 * is the rule without snoozes: a snooze counts only while that rule still
 * answers its reminder at the original fire time. Its key is the original
 * key plus `~<until>`, so each snooze is its own notification.
 */
export function snoozedReminders<R extends Snoozable>(
  snoozes: readonly ReminderSnooze[],
  baseDue: (window: { from: number; to: number }) => R[],
  window: { from: number; to: number }
): SnoozedReminder<R>[] {
  const out: SnoozedReminder<R>[] = [];
  for (const s of sanitizeReminderSnoozes(snoozes)) {
    if (s.until < window.from || s.until >= window.to) continue;
    const base = baseDue({ from: s.fireAt, to: s.fireAt + 1 }).find((r) => r.key === s.key);
    if (!base) continue;
    out.push({ ...base, key: `${s.key}~${s.until}`, fireAt: s.until, snoozeOf: { key: s.key, fireAt: s.fireAt } });
  }
  return out;
}
