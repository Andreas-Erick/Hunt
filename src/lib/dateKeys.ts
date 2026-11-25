/**
 * Local YYYY-MM-DD date keys: the leaf helpers every date rule builds on.
 * No imports, so any shared rule (the Ended Habit rule, the Frequency rule)
 * can use them without an import cycle; dateUtils re-exports them.
 */

/** Short weekday names, Sunday first (Date#getDay order). */
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Formats a timestamp (ms) into local YYYY-MM-DD string
 */
export function toLocalDateKey(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local date for a YYYY-MM-DD key, at noon (safe across DST changes). */
export function dateFromKey(dateKey: string, dayOffset = 0): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d + dayOffset, 12);
}

/**
 * The YYYY-MM-DD key `dayOffset` calendar days away from `baseKey`. Steps whole
 * calendar days from a noon anchor, so 23- and 25-hour DST days never skip or
 * repeat a key (unlike `now - n * 86_400_000`).
 */
export function dateKeyFromOffset(baseKey: string, dayOffset: number): string {
  return toLocalDateKey(dateFromKey(baseKey, dayOffset).getTime());
}
