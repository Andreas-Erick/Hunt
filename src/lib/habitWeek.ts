import { dateKeyFromOffset } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { habitFrequencyOn, isHabitScheduledOn, isPerWeekFrequency, weekdayOfKey } from "./habitFrequency";
import { habitStreakOf, type HabitOutcome } from "./habitOutcome";

/**
 * SHARED Habit Week rules (GLOSSARY: Habit Week, Partial Week). A Habit asked N
 * times per week is judged by its Monday-to-Sunday week, never by the day.
 * Pure; the desktop and the phone page both reach it through habitDay.ts.
 */

type FrequencySource = Readonly<Pick<Partial<Habit>, "frequencyHistory" | "endDate" | "endedSpans">>;
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

/** One Habit's days, as the Habit Week rule reads them. */
export interface HabitWeekDays {
  /** Each day's Task (a late tick on its scheduled day), or undefined. */
  dayTaskOn: (dayKey: string) => WeekDayTask;
  /** Each day's own Outcome (habitDayOutcome): "met" counts toward N, by the Habit's Kind. */
  dayOutcomeOn: (dayKey: string) => HabitOutcome | null;
  /** The day the Habit began. */
  firstDayKey: string;
}

/**
 * The Habit Week holding `dayKey`, or null when no day of it was asked N times
 * per week.
 *
 * Outcome: a Partial Week (one the Habit did not fully cover: it began, ended
 * or changed Frequency partway through, so some day is not asked N per week)
 * is Skipped; N Met days are Met; a week set aside is Skipped; the current week
 * (or one whose focus still runs) is Open; any other past week is Missed.
 */
export function habitWeekOf(
  habit: FrequencySource,
  dayKey: string,
  { dayTaskOn, dayOutcomeOn, firstDayKey }: HabitWeekDays,
  todayKey: string
): HabitWeek | null {
  const start = habitWeekStart(dayKey);
  const days = habitWeekDays(start);
  const asked = days.filter((day) => isHabitScheduledOn(habit, day));
  const perWeek = asked.map((day) => habitFrequencyOn(habit, day)).filter(isPerWeekFrequency);
  if (perWeek.length === 0) return null;
  const inForce = habitFrequencyOn(habit, todayKey < days[6] ? todayKey : days[6]);
  const target = isPerWeekFrequency(inForce) ? inForce.times : perWeek[0].times;
  const partial =
    start < firstDayKey || perWeek.length < 7 || perWeek.some((f) => f.times !== perWeek[0].times);
  const tasks = days.map(dayTaskOn);
  const met = days.filter((day) => dayOutcomeOn(day) === "met").length;
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
  return habitStreakOf(weekOutcomesBackFrom(todayKey, firstDayKey, weekOutcomeOn));
}

/** Each Habit Week's Outcome from the week of `todayKey` back to the week of `firstDayKey`. */
export function* weekOutcomesBackFrom(
  todayKey: string,
  firstDayKey: string,
  weekOutcomeOn: (dayKey: string) => HabitOutcome | null
): Generator<HabitOutcome | null> {
  const floor = habitWeekStart(firstDayKey);
  for (let week = habitWeekStart(todayKey); week >= floor; week = dateKeyFromOffset(week, -7)) {
    yield weekOutcomeOn(week);
  }
}

/**
 * SHARED unit walk of the Success Rate and the Habit Score: one Outcome per
 * unit from `todayKey` back to `firstDayKey`, newest first, where a day under a
 * daily Frequency (every day, chosen weekdays) is a unit and a Habit Week under
 * N per week is one. So all history counts across a switch between the two;
 * the Partial Week at a switch reads Skipped (habitWeekOf), and the days in it
 * still under a daily Frequency are judged one by one.
 */
export function* habitUnitOutcomesBackFrom(
  habit: FrequencySource,
  todayKey: string,
  firstDayKey: string,
  { dayOutcomeOn, weekOutcomeOn }: {
    dayOutcomeOn: (dayKey: string) => HabitOutcome | null;
    weekOutcomeOn: (dayKey: string) => HabitOutcome | null;
  }
): Generator<HabitOutcome | null> {
  let lastWeek = "";
  for (let day = todayKey; day >= firstDayKey; day = dateKeyFromOffset(day, -1)) {
    if (!isPerWeekFrequency(habitFrequencyOn(habit, day))) yield dayOutcomeOn(day);
    else if (habitWeekStart(day) !== lastWeek) {
      lastWeek = habitWeekStart(day);
      yield weekOutcomeOn(day);
    }
  }
}
