import type { HabitOutcome } from "./habitOutcome";

/**
 * SHARED Habit Statistics rules (GLOSSARY: Habit Score): the Habit Score over
 * any sequence of Outcomes (days, or Habit Weeks), and a Count Habit's daily
 * amounts per month and totals per month of a year, so both apps draw the
 * Statistics tab from the same numbers. Pure.
 */

/**
 * The Habit Score's weight on the newest unit; each older unit weighs
 * (1 - HABIT_SCORE_WEIGHT) times the one after it. 2 / (30 + 1) makes about
 * the last 30 units dominate. The only place this constant lives.
 */
export const HABIT_SCORE_WEIGHT = 2 / 31;

/** The Statistics tab's one-line explanation of the Habit Score (never the formula). */
export const HABIT_SCORE_EXPLANATION =
  "Recent results count most: each Met one lifts it, each Missed one lowers it, and Skipped ones don't count.";

/**
 * SHARED Habit Score: a 0-100 exponentially weighted average of `outcomes`,
 * newest first, with Met = 1 and Missed = 0; Skipped, Open and unscheduled
 * (null) units are passed over. Null when none was Met or Missed. Only a
 * perfect record reads 100 and only an all-Missed one 0.
 */
export function habitScore(outcomes: Iterable<HabitOutcome | null>): number | null {
  let weight = 1;
  let total = 0;
  let met = 0;
  for (const outcome of outcomes) {
    if (outcome !== "met" && outcome !== "missed") continue;
    total += weight;
    if (outcome === "met") met += weight;
    weight *= 1 - HABIT_SCORE_WEIGHT;
  }
  if (total === 0) return null;
  const share = met / total;
  if (share >= 1) return 100;
  if (share <= 0) return 0;
  return Math.min(99, Math.max(1, Math.round(share * 100)));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A sum of Count amounts, kept to 2 decimals. */
const roundTotal = (n: number) => Math.round(n * 100) / 100;

/** One day of a Count Habit's month chart. */
export interface HabitAmountDay {
  dayKey: string;
  /** Day of the month, 1-31. */
  day: number;
  /** The day's total, or null for a day before the Habit began or after today. */
  amount: number | null;
  /** Whether the total reached the target (at or over it). */
  reached: boolean;
}

/** A Count Habit's month of daily amounts. */
export interface HabitMonthAmounts {
  /** The YYYY-MM month shown. */
  monthKey: string;
  days: HabitAmountDay[];
  /** The chart's top: the largest amount shown, or the target when that is larger. */
  max: number;
  /** The month before, or null when the Habit had not begun yet. */
  prevMonthKey: string | null;
  /** The month after, or null when it would be after today's month. */
  nextMonthKey: string | null;
}

/** `monthKey` clamped to the months from `startKey`'s to `todayKey`'s, with its neighbours. */
function clampMonth(monthKey: string, startKey: string, todayKey: string) {
  const first = startKey.slice(0, 7);
  const last = todayKey.slice(0, 7) < first ? first : todayKey.slice(0, 7);
  const shown = monthKey < first ? first : monthKey > last ? last : monthKey;
  const shift = (offset: number) => {
    const [y, m] = shown.split("-").map(Number);
    const index = y * 12 + (m - 1) + offset;
    return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
  };
  return { shown, prev: shown > first ? shift(-1) : null, next: shown < last ? shift(1) : null };
}

/** The days of a YYYY-MM month, each with its total from `amountOn` while in the Habit's life. */
function monthDays(monthKey: string, startKey: string, todayKey: string, amountOn: (dayKey: string) => number) {
  const [y, m] = monthKey.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => {
    const dayKey = `${monthKey}-${pad(i + 1)}`;
    const inLife = dayKey >= startKey && dayKey <= todayKey;
    return { dayKey, day: i + 1, amount: inLife ? amountOn(dayKey) : null };
  });
}

/**
 * SHARED month chart of a Count Habit: each day's total (`amountOn`) for
 * `monthKey`, clamped to the months from the Habit's first day (`startKey`)
 * to today's, each marked by whether it reached `target`.
 */
export function habitMonthAmounts({
  monthKey,
  todayKey,
  startKey,
  target,
  amountOn,
}: {
  monthKey: string;
  todayKey: string;
  startKey: string;
  target: number;
  amountOn: (dayKey: string) => number;
}): HabitMonthAmounts {
  const { shown, prev, next } = clampMonth(monthKey, startKey, todayKey);
  const days = monthDays(shown, startKey, todayKey, amountOn).map((d) => ({
    ...d,
    reached: d.amount !== null && d.amount >= target,
  }));
  const max = days.reduce((top, d) => Math.max(top, d.amount ?? 0), target);
  return { monthKey: shown, days, max, prevMonthKey: prev, nextMonthKey: next };
}

/** A Count Habit's totals per month of one year. */
export interface HabitYearTotals {
  year: number;
  /** January to December; a month wholly before the Habit began or after today has a null total. */
  months: { monthKey: string; total: number | null }[];
  /** The year's total. */
  total: number;
  /** The year before, or null when the Habit had not begun yet. */
  prevYear: number | null;
  /** The year after, or null when it would be after today's year. */
  nextYear: number | null;
}

/**
 * SHARED yearly totals of a Count Habit: the sum of each month's daily totals
 * (`amountOn`) in `year`, clamped to the years from the Habit's first day
 * (`startKey`) to today's, counting only days from `startKey` to today.
 */
export function habitYearTotals({
  year,
  todayKey,
  startKey,
  amountOn,
}: {
  year: number;
  todayKey: string;
  startKey: string;
  amountOn: (dayKey: string) => number;
}): HabitYearTotals {
  const first = Number(startKey.slice(0, 4));
  const last = Math.max(first, Number(todayKey.slice(0, 4)));
  const shown = Math.min(last, Math.max(first, year));
  let total = 0;
  const months = Array.from({ length: 12 }, (_, i) => {
    const monthKey = `${shown}-${pad(i + 1)}`;
    const days = monthDays(monthKey, startKey, todayKey, amountOn);
    if (days.every((d) => d.amount === null)) return { monthKey, total: null };
    const sum = roundTotal(days.reduce((s, d) => s + (d.amount ?? 0), 0));
    total += sum;
    return { monthKey, total: sum };
  });
  return {
    year: shown,
    months,
    total: roundTotal(total),
    prevYear: shown > first ? shown - 1 : null,
    nextYear: shown < last ? shown + 1 : null,
  };
}

/** A total as the Statistics tab shows it: "1,234.5". */
export function formatCountTotal(total: number): string {
  return roundTotal(total).toLocaleString("en-US", { maximumFractionDigits: 2 });
}
