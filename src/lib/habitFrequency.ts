import type { Habit, HabitFrequency, HabitFrequencyChange, Weekday } from "./domainTypes";
import { isHabitEndedOn } from "./habitEnd";
import { habitKindRules } from "./habitKind";

/**
 * SHARED Frequency rules (GLOSSARY: Frequency). A Habit stores its Frequency
 * as a history of changes, so a change applies from its day forward and every
 * earlier day is still judged under the Frequency in force then. Pure; no
 * imports beyond types, so the Outcome rule and the sync validator can use it.
 */

export const EVERY_DAY: HabitFrequency = { type: "everyDay" };

/** Most Frequency changes a Habit row keeps (the newest). */
export const MAX_FREQUENCY_CHANGES = 100;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Monday first, the order of a Habit Week. */
const WEEK_ORDER: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

type FrequencySource = Readonly<Pick<Partial<Habit>, "frequencyHistory">>;
type ScheduleSource = Readonly<Pick<Partial<Habit>, "frequencyHistory" | "endDate" | "endedSpans">>;

/** The weekday (0 = Sunday) of a local YYYY-MM-DD key. */
export function weekdayOfKey(dateKey: string): Weekday {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getDay() as Weekday;
}

/** The Frequency in force on `dayKey`: the latest change effective by then, else every day. */
export function habitFrequencyOn(habit: FrequencySource, dayKey: string): HabitFrequency {
  let inForce = EVERY_DAY;
  for (const change of habit.frequencyHistory ?? []) {
    if (change.effectiveFrom > dayKey) break;
    inForce = change.frequency;
  }
  return inForce;
}

/**
 * Whether the Habit's Frequency in force on `dayKey` may ask for that day. An N
 * per week Habit may be asked any day of its Habit Week; whether it still is,
 * once N are Met, is the Habit Week rule (habitWeek.ts). A day past its end
 * date, or one it spent Ended before a restart, is never asked for
 * (isHabitEndedOn).
 */
export function isHabitScheduledOn(habit: ScheduleSource, dayKey: string): boolean {
  if (isHabitEndedOn(habit, dayKey)) return false;
  const frequency = habitFrequencyOn(habit, dayKey);
  return frequency.type !== "weekdays" || frequency.weekdays.includes(weekdayOfKey(dayKey));
}

/** Whether two Frequencies ask for the same days (weekday order and repeats ignored). */
export function sameHabitFrequency(a: HabitFrequency, b: HabitFrequency): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "weekdays" && b.type === "weekdays") {
    return normalizedWeekdays(a.weekdays).join() === normalizedWeekdays(b.weekdays).join();
  }
  if (a.type === "perWeek" && b.type === "perWeek") return a.times === b.times;
  return true;
}

function normalizedWeekdays(weekdays: readonly number[]): Weekday[] {
  return Array.from(new Set(weekdays))
    .filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6)
    .sort((a, b) => a - b);
}

/** A copy of `frequency` in stored form (weekdays ascending and unique). */
function normalizedFrequency(frequency: HabitFrequency): HabitFrequency {
  if (frequency.type === "perWeek") return { type: "perWeek", times: frequency.times };
  return frequency.type === "weekdays"
    ? { type: "weekdays", weekdays: normalizedWeekdays(frequency.weekdays) }
    : EVERY_DAY;
}

/** Most times per Habit Week an N per week Frequency can ask for. */
export const MAX_TIMES_PER_WEEK = 7;

/**
 * Whether a Habit of this Kind may use `frequency`: an Avoid Habit is judged
 * day by day, so it asks every day or on chosen weekdays, never N per week.
 */
export function isFrequencyAllowedFor(habit: { readonly kind?: unknown }, frequency: HabitFrequency): boolean {
  return frequency.type !== "perWeek" || habitKindRules(habit).allowsPerWeek;
}

/** Whether a Frequency asks N times per Habit Week (judged by the week, not the day). */
export function isPerWeekFrequency(
  frequency: HabitFrequency
): frequency is Extract<HabitFrequency, { type: "perWeek" }> {
  return frequency.type === "perWeek";
}

/**
 * The Habit's Frequency history after changing it to `frequency` from
 * `todayKey` on. Earlier days keep the Frequency they had; a change made
 * earlier today is replaced; no change is added when `frequency` is already in
 * force. Pure: the Habit is not modified.
 */
export function withHabitFrequency(
  habit: FrequencySource,
  frequency: HabitFrequency,
  todayKey: string
): HabitFrequencyChange[] {
  const kept = (habit.frequencyHistory ?? []).filter((c) => c.effectiveFrom < todayKey);
  const before = habitFrequencyOn({ frequencyHistory: kept }, todayKey);
  if (sameHabitFrequency(before, frequency)) return kept;
  return [...kept, { effectiveFrom: todayKey, frequency: normalizedFrequency(frequency) }];
}

/** Short label of a Frequency for the Habit card: "Every day", "Mon, Wed, Fri" or "3 times a week". */
export function habitFrequencyLabel(frequency: HabitFrequency): string {
  if (frequency.type === "everyDay") return "Every day";
  if (frequency.type === "perWeek") return frequency.times === 1 ? "Once a week" : `${frequency.times} times a week`;
  return WEEK_ORDER.filter((d) => frequency.weekdays.includes(d))
    .map((d) => WEEKDAY_SHORT[d])
    .join(", ");
}

const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** The weekdays a picker lists, Monday first, with their short label and full name. */
export const HABIT_WEEKDAYS: readonly { day: Weekday; label: string; name: string }[] = WEEK_ORDER.map(
  (day) => ({ day, label: WEEKDAY_SHORT[day], name: WEEKDAY_NAME[day] })
);
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A valid Frequency in stored form from untrusted input, or null (unknown type, no weekdays, times not 1-7). */
export function parseHabitFrequency(raw: unknown): HabitFrequency | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "everyDay") return EVERY_DAY;
  if (raw.type === "weekdays" && Array.isArray(raw.weekdays)) {
    const weekdays = normalizedWeekdays(raw.weekdays.filter((d): d is number => typeof d === "number"));
    return weekdays.length > 0 ? { type: "weekdays", weekdays } : null;
  }
  const { times } = raw;
  if (raw.type === "perWeek" && Number.isInteger(times) && Number(times) >= 1 && Number(times) <= MAX_TIMES_PER_WEEK) {
    return { type: "perWeek", times: Number(times) };
  }
  return null;
}

/** A valid Frequency the Habit's Kind may use (isFrequencyAllowedFor) from untrusted input, or null. */
export function parseHabitFrequencyFor(habit: { readonly kind?: unknown }, raw: unknown): HabitFrequency | null {
  const frequency = parseHabitFrequency(raw);
  return frequency && isFrequencyAllowedFor(habit, frequency) ? frequency : null;
}

/**
 * Sync boundary: a new, valid Frequency history from untrusted input, or
 * undefined when nothing valid is left (the row then reads as every day).
 * Changes with a bad date or an unknown or empty Frequency are dropped; a day
 * keeps its last change; the newest MAX_FREQUENCY_CHANGES are kept. A change
 * the Habit's Kind may not use (isFrequencyAllowedFor) is dropped too.
 */
export function sanitizeHabitFrequencyHistory(
  raw: unknown,
  habit: { readonly kind?: unknown } = {}
): HabitFrequencyChange[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const byDay = new Map<string, HabitFrequency>();
  for (const entry of raw.slice(-MAX_FREQUENCY_CHANGES * 4)) {
    if (!isRecord(entry)) continue;
    const { effectiveFrom } = entry;
    const frequency = parseHabitFrequency(entry.frequency);
    if (typeof effectiveFrom !== "string" || !DATE_KEY_RE.test(effectiveFrom) || !frequency) continue;
    if (!isFrequencyAllowedFor(habit, frequency)) continue;
    byDay.set(effectiveFrom, frequency);
  }
  const history = Array.from(byDay, ([effectiveFrom, frequency]) => ({ effectiveFrom, frequency }))
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
    .slice(-MAX_FREQUENCY_CHANGES);
  return history.length > 0 ? history : undefined;
}
