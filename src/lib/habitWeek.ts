import { dateKeyFromOffset } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { habitFrequencyOn, isPerWeekFrequency, weekdayOfKey } from "./habitFrequency";
import { habitStreakOf, type HabitOutcome } from "./habitOutcome";

/**
 * SHARED Habit Week rules (GLOSSARY: Habit Week, Partial Week). A Habit asked N
 * times per week is judged by its Monday-to-Sunday week, never by the day.
 * Pure; the desktop and the phone page both reach it through habitDay.ts.
 */

type FrequencySource = Readonly<Pick<Partial<Habit>, "frequencyHistory">>;
type WeekDayTask = Pick<Task, "status" | "skipped"> | undefined;

/** The Monday (YYYY-MM-DD) of the Habit Week holding `dayKey`. */
export function habitWeekStart(dayKey: string): string {
  return dateKeyFromOffset(dayKey, -((weekdayOfKey(dayKey) + 6) % 7));
}

/** The seven days of the Habit Week starting `weekStart`, Monday first. */
export function habitWeekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => dateKeyFromOffset(weekStart, i));
}

/** One Habit Week of an N per week Habit. */
export interface HabitWeek {
  /** The week's Monday. */
  start: string;
  /** N: how many Met days the week asks for. */
  target: number;
  /** How many of its days are Met (ticked). */
  met: number;
  /** Whether the week was set aside on purpose: one of its day Tasks is `skipped`. */
  skipped: boolean;
  /** A Partial Week: the Habit began, or changed Frequency, partway through it. */
  partial: boolean;
  /** The week's Outcome, or null for a week after today. */
  outcome: HabitOutcome | null;
}

/**
 * The Habit Week holding `dayKey`, or null when no day of it was asked N times
 * per week. `dayTaskOn` gives each day's Task (a late tick on its scheduled
 * day); `firstDayKey` is the day the Habit began.
 *
 * Outcome: a Partial Week is Skipped; N Met days are Met; a week set aside is
 * Skipped; the current week (or one whose focus still runs) is Open; any other
 * past week is Missed.
 */
export function habitWeekOf(
  habit: FrequencySource,
  dayKey: string,
  dayTaskOn: (dayKey: string) => WeekDayTask,
  todayKey: string,
  firstDayKey: string
): HabitWeek | null {
  const start = habitWeekStart(dayKey);
  const days = habitWeekDays(start);
  const frequencies = days.map((day) => habitFrequencyOn(habit, day));
  const perWeek = frequencies.filter(isPerWeekFrequency);
  if (perWeek.length === 0) return null;
  const inForce = habitFrequencyOn(habit, todayKey < days[6] ? todayKey : days[6]);
  const target = isPerWeekFrequency(inForce) ? inForce.times : perWeek[0].times;
  const partial =
    start < firstDayKey || perWeek.length < 7 || perWeek.some((f) => f.times !== perWeek[0].times);
  const tasks = days.map(dayTaskOn);
  const met = tasks.filter((t) => t?.status === "completed").length;
  const skipped = tasks.some((t) => Boolean(t?.skipped));
  let outcome: HabitOutcome | null;
  if (start > todayKey) outcome = null;
  else if (partial) outcome = "skipped";
  else if (met >= target) outcome = "met";
  else if (skipped) outcome = "skipped";
  else if (days[6] >= todayKey || tasks.some((t) => t?.status === "active")) outcome = "open";
  else outcome = "missed";
  return { start, target, met, skipped, partial, outcome };
}

/**
 * The day the Habit's current run of Streak unit began: the last Frequency
 * change on or before `todayKey` that switched between daily Frequencies (every
 * day, chosen weekdays) and N per week, or "" when it never switched. A Streak
 * never counts across the switch, so days and Habit Weeks are not mixed.
 */
export function frequencyUnitStart(habit: FrequencySource, todayKey: string): string {
  let weekly = false;
  let start = "";
  for (const change of habit.frequencyHistory ?? []) {
    if (change.effectiveFrom > todayKey) break;
    if (isPerWeekFrequency(change.frequency) === weekly) continue;
    weekly = !weekly;
    start = change.effectiveFrom;
  }
  return start;
}

/**
 * SHARED weekly Streak: Met Habit Weeks in a row, the current week first, read
 * back no further than the week of `firstDayKey`. Skipped weeks (Partial Weeks
 * among them) and the current week while Open are passed over (habitStreakOf).
 */
export function habitWeekStreakOn(
  todayKey: string,
  weekOutcomeOn: (dayKey: string) => HabitOutcome | null,
  firstDayKey: string
): number {
  const floor = habitWeekStart(firstDayKey);
  function* weeksBack(): Generator<HabitOutcome | null> {
    for (let week = habitWeekStart(todayKey); week >= floor; week = dateKeyFromOffset(week, -7)) {
      yield weekOutcomeOn(week);
    }
  }
  return habitStreakOf(weeksBack());
}
