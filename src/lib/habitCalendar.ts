import { toLocalDateKey } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { completeTaskRow, nextStamp } from "./taskQueue";
import { setHabitDayAmount } from "./habitCount";
import { countTargetOf, habitDayAmount, habitKindOf } from "./habitKind";
import type { HabitOutcome } from "./habitOutcome";
import { habitFrequencyOn, isPerWeekFrequency } from "./habitFrequency";
import type { HabitWeek } from "./habitWeek";

/** One day cell of a Habit's month calendar. */
export interface HabitCalendarDay {
  /** The local YYYY-MM-DD day. */
  dayKey: string;
  /** Day of the month, 1-31. */
  day: number;
  /** The day's Outcome, or null when it has none (after today, before the Habit began, unscheduled). */
  outcome: HabitOutcome | null;
  /** Whether the day can be ticked, unticked or Skipped from the calendar. */
  correctable: boolean;
}

/** A Habit's month of Outcomes, as Monday-first weeks. */
export interface HabitMonth {
  /** The YYYY-MM month shown. */
  monthKey: string;
  /** Monday-to-Sunday rows; a slot outside the month is null. */
  weeks: (HabitCalendarDay | null)[][];
  /** The month before, or null when the Habit had not begun yet. */
  prevMonthKey: string | null;
  /** The month after, or null when it would be after today's month. */
  nextMonthKey: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The YYYY-MM month `offset` months from `monthKey`. */
export function shiftMonthKey(monthKey: string, offset: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const index = y * 12 + (m - 1) + offset;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/**
 * SHARED first calendar day of a Habit: the local day it was made, never after
 * today (a clock that ran ahead), and today for a row without a usable createdAt.
 */
export function habitStartKey(habit: Pick<Habit, "createdAt">, todayKey: string): string {
  const made = Number(habit.createdAt);
  if (!Number.isFinite(made) || made <= 0) return todayKey;
  const key = toLocalDateKey(made);
  return key > todayKey ? todayKey : key;
}

/**
 * SHARED month calendar of one Habit's Outcomes. `monthKey` is clamped to the
 * months from the Habit's first day (`startKey`) to today's. A day before
 * `startKey`, or one `outcomeOn` gives no Outcome, shows no Outcome and cannot
 * be corrected; any other day up to today can. `askedOn` (the Habit's
 * isHabitScheduledOn) also lets a day with no Outcome be corrected: a day of an
 * N per week Habit is never Missed on its own, yet can still be ticked.
 * `weekOn` (the day summary's) shows every day of a Skipped Habit Week up to
 * today as Skipped, except a Met one, since a Skip sets the whole week aside.
 */
export function habitMonth({
  monthKey,
  todayKey,
  startKey,
  outcomeOn,
  askedOn,
  weekOn,
}: {
  monthKey: string;
  todayKey: string;
  /** The Habit's first day (YYYY-MM-DD). */
  startKey: string;
  outcomeOn: (dayKey: string) => HabitOutcome | null;
  askedOn?: (dayKey: string) => boolean;
  weekOn?: (dayKey: string) => Pick<HabitWeek, "skipped"> | null;
}): HabitMonth {
  const firstMonth = startKey.slice(0, 7);
  const lastMonth = todayKey.slice(0, 7) < firstMonth ? firstMonth : todayKey.slice(0, 7);
  const shown = monthKey < firstMonth ? firstMonth : monthKey > lastMonth ? lastMonth : monthKey;
  const [y, m] = shown.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0
  const slots: (HabitCalendarDay | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= daysInMonth; day++) {
    const dayKey = `${shown}-${pad(day)}`;
    const own = dayKey < startKey ? null : outcomeOn(dayKey);
    const weekSkipped = own !== "met" && dayKey >= startKey && dayKey <= todayKey && Boolean(weekOn?.(dayKey)?.skipped);
    const outcome = weekSkipped ? "skipped" : own;
    const asked = outcome !== null || (dayKey >= startKey && Boolean(askedOn?.(dayKey)));
    slots.push({ dayKey, day, outcome, correctable: asked && dayKey <= todayKey });
  }
  while (slots.length % 7 !== 0) slots.push(null);
  const weeks: (HabitCalendarDay | null)[][] = [];
  for (let i = 0; i < slots.length; i += 7) weeks.push(slots.slice(i, i + 7));
  return {
    monthKey: shown,
    weeks,
    prevMonthKey: shown > firstMonth ? shiftMonthKey(shown, -1) : null,
    nextMonthKey: shown < lastMonth ? shiftMonthKey(shown, 1) : null,
  };
}

/** What a habit day is corrected to from the calendar: ticked, set aside, or neither. */
export type HabitDayMark = "met" | "skipped" | "none";

/**
 * SHARED routing of a calendar mark on an N per week Habit's day: Skip (true)
 * and Undo skip (false: "none" on a Skipped day) act on the whole Habit Week
 * through habitSkipRows. Null for any other mark, or a daily Habit's day, which
 * correctHabitDayRow writes.
 */
export function habitWeekSkipMark(
  habit: Readonly<Partial<Habit>>,
  dayKey: string,
  mark: HabitDayMark,
  outcome: HabitOutcome | null
): boolean | null {
  if (!isPerWeekFrequency(habitFrequencyOn(habit, dayKey))) return null;
  if (mark === "skipped") return true;
  return mark === "none" && outcome === "skipped" ? false : null;
}


/**
 * A Count Habit day corrected through the shared Count rule (setHabitDayAmount),
 * so its total and its tick never disagree: Met raises the total to at least
 * the target; Untick and Skip clear it to 0.
 */
function correctCountDayRow(
  task: Task,
  habit: Readonly<Pick<Partial<Habit>, "target">>,
  mark: HabitDayMark,
  at: number
): Task {
  const amount = habitDayAmount(task);
  const target = countTargetOf(habit);
  const skipped = Boolean(task.skipped);
  if (mark === "met" ? amount >= target : amount === 0 && skipped === (mark === "skipped")) return task;
  const row = setHabitDayAmount(task, habit, mark === "met" ? Math.max(amount, target) : 0, at);
  return { ...row, completedAt: row.completedAt, skipped: mark === "skipped" ? true : undefined };
}

/**
 * SHARED "correct a habit day" rule: the day Task `task` ticked (Met), set
 * aside (Skipped) or neither, stamped newer at `at`. Skipping a ticked day
 * unticks it. On a Count Habit's day (pass `habit`) ticking sets the total to
 * at least the target, and unticking or Skipping clears it to 0. Returns
 * `task` itself when the day already reads that way, or while a focus runs on
 * it, so callers write nothing. Pure: `task` is not modified. Cleared fields
 * stay as explicit undefined so a Dexie update drops them.
 */
export function correctHabitDayRow(
  task: Task,
  mark: HabitDayMark,
  at: number,
  habit?: Readonly<Pick<Partial<Habit>, "kind" | "target">>
): Task {
  if (task.status === "active") return task;
  if (habit && habitKindOf(habit) === "count") return correctCountDayRow(task, habit, mark, at);
  const met = task.status === "completed";
  const skipped = !met && Boolean(task.skipped);
  if ((mark === "met" && met) || (mark === "skipped" && skipped) || (mark === "none" && !met && !skipped)) {
    return task;
  }
  if (mark === "met") return completeTaskRow(task, at);
  return {
    ...task,
    status: "queued",
    completedAt: undefined,
    skipped: mark === "skipped" ? true : undefined,
    updatedAt: nextStamp(task, at),
  };
}
