import { habitStreakOn, habitTaskId, outcomesBackFrom, toLocalDateKey } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { habitFrequencyOn, isHabitScheduledOn, isPerWeekFrequency } from "./habitFrequency";
import { habitSuccessRate } from "./habitInsight";
import { habitKindOf } from "./habitKind";
import { habitDayOutcome, type HabitOutcome } from "./habitOutcome";
import { frequencyUnitStart, habitWeekOf, habitWeekStreakOn, weekOutcomesBackFrom, type HabitWeek } from "./habitWeek";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isStampValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * SHARED completion-date rule: the local YYYY-MM-DD day a completed task counts
 * for, or null for a task that is not completed.
 *
 * A daily habit instance counts for the day it belongs to (its scheduledDate),
 * so yesterday's habit ticked at 00:30 counts for yesterday in the streak AND
 * on the Review heatmap. Every other task counts for the day it was finished
 * (completedAt), falling back to scheduledDate, then updatedAt, for legacy rows.
 */
export function completionDateKey(
  task: Pick<Task, "status" | "completedAt" | "scheduledDate" | "updatedAt" | "habitId">
): string | null {
  if (task.status !== "completed") return null;
  const scheduled =
    typeof task.scheduledDate === "string" && DATE_KEY_RE.test(task.scheduledDate)
      ? task.scheduledDate
      : null;
  if (task.habitId && scheduled) return scheduled;
  if (isStampValue(task.completedAt)) return toLocalDateKey(task.completedAt);
  if (scheduled) return scheduled;
  if (isStampValue(task.updatedAt)) return toLocalDateKey(task.updatedAt);
  return null;
}

/** One habit's day-level state on `todayKey`. */
export interface HabitDaySummary {
  /** Today's daily instance, or undefined when it is not materialized (yet). */
  todayTask: Task | undefined;
  /** Every day this habit was completed (completionDateKey). */
  completedDates: ReadonlySet<string>;
  /**
   * The Streak in `streakUnit`s: Met days in a row ending today (or yesterday
   * while today is Open), or Met Habit Weeks for an N per week Habit.
   */
  streak: number;
  /** "week" when today's Frequency is N per week (the Streak reads "3w"), else "day". */
  streakUnit: "day" | "week";
  /**
   * Whether today is asked of the user: scheduled by today's Frequency and,
   * for N per week, the Habit Week not yet Met on its other days.
   */
  askedToday: boolean;
  /**
   * The Outcome a Skip acts on: today's for a daily Habit; for N per week the
   * current Habit Week's, "met" once N are Met, "skipped" once set aside on
   * purpose (a Partial Week still reads "open": it can be set aside too).
   */
  skipState: HabitOutcome | null;
  /** The Habit Week holding today, or null when today is not N per week. */
  week: HabitWeek | null;
  /** The Outcome of the Habit Week holding `dayKey`, or null when it was not N per week. */
  weekOutcomeOn: (dayKey: string) => HabitOutcome | null;
  /** Whether today is Met (a Check Habit ticked, a Count Habit at its target). */
  doneToday: boolean;
  /** The Habit's Outcome on `dayKey` (habitDayOutcome), or null for a day after today. */
  outcomeOn: (dayKey: string) => HabitOutcome | null;
  /**
   * The Success Rate (habitSuccessRate) over every day since the Habit began
   * (every Habit Week for an N per week Habit), or null before any was Met or
   * Missed. Worked out on first call only.
   */
  successRate: () => number | null;
}

const EMPTY_DATES: ReadonlySet<string> = new Set<string>();

/**
 * Each day's Task of one habit, keyed by the day it counts for: a completed
 * Task by completionDateKey (so a late tick lands on its scheduled day), any
 * other by scheduledDate. A completed Task wins its day.
 */
function addDayTask(days: Map<string, Task>, task: Task, day: string): void {
  const held = days.get(day);
  if (!held || (held.status !== "completed" && task.status === "completed")) days.set(day, task);
}

/**
 * The first day a Habit could have been Met: the earlier of the day it was
 * created and its first day Task, else today. The Streak walk ends there.
 */
function firstHabitDay(
  habit: Partial<Habit>,
  dayTasks: ReadonlyMap<string, Task> | undefined,
  todayKey: string
): string {
  let first = todayKey;
  if (isStampValue(habit.createdAt)) {
    const created = toLocalDateKey(habit.createdAt);
    if (created < first) first = created;
  }
  for (const day of dayTasks?.keys() ?? []) if (day < first) first = day;
  return first;
}

/**
 * Per-habit day summary from the materialized habit tasks. Today's instance is
 * the row with the deterministic id (habitTaskId) when present, else any row of
 * that habit scheduled for `todayKey`. Pure: `habitTasks` is not modified.
 * Habits without any task still get a summary from `summaryFor`.
 *
 * `habits` gives each Habit's Kind (and a Count Habit's target), its Frequency
 * and the day it began; a Habit missing from it is judged as an old row (a
 * daily Check Habit) from its first day Task on.
 */
export function summarizeHabitDays(
  habitTasks: readonly Task[],
  todayKey: string,
  habits: readonly Partial<Habit>[] = []
): {
  summaryFor: (habitId: string) => HabitDaySummary;
} {
  const todayByHabit = new Map<string, Task>();
  const datesByHabit = new Map<string, Set<string>>();
  const dayTasksByHabit = new Map<string, Map<string, Task>>();
  for (const task of habitTasks) {
    const habitId = task.habitId;
    if (!habitId) continue;
    const canonical = task.id === habitTaskId(habitId, todayKey);
    if (canonical || (task.scheduledDate === todayKey && !todayByHabit.has(habitId))) {
      todayByHabit.set(habitId, task);
    }
    let dayTasks = dayTasksByHabit.get(habitId);
    if (!dayTasks) {
      dayTasks = new Map<string, Task>();
      dayTasksByHabit.set(habitId, dayTasks);
    }
    const day = completionDateKey(task);
    if (day) {
      let dates = datesByHabit.get(habitId);
      if (!dates) {
        dates = new Set<string>();
        datesByHabit.set(habitId, dates);
      }
      dates.add(day);
      addDayTask(dayTasks, task, day);
    } else if (task.scheduledDate) {
      addDayTask(dayTasks, task, task.scheduledDate);
    }
  }
  const habitById = new Map<string, Partial<Habit>>();
  for (const habit of habits) if (habit.id) habitById.set(habit.id, habit);
  const cache = new Map<string, HabitDaySummary>();
  return {
    summaryFor(habitId) {
      let summary = cache.get(habitId);
      if (!summary) {
        const todayTask = todayByHabit.get(habitId);
        const completedDates = datesByHabit.get(habitId) ?? EMPTY_DATES;
        const dayTasks = dayTasksByHabit.get(habitId);
        const habit = habitById.get(habitId) ?? { id: habitId };
        const dayTaskOn = (dayKey: string) => dayTasks?.get(dayKey);
        const outcomeOn = (dayKey: string) => habitDayOutcome({ habit, dayKey, dayTask: dayTaskOn(dayKey), todayKey });
        const firstDay = firstHabitDay(habit, dayTasks, todayKey);
        const weekDays = { dayTaskOn, dayOutcomeOn: outcomeOn, firstDayKey: firstDay };
        const weekOn = (dayKey: string) => habitWeekOf(habit, dayKey, weekDays, todayKey);
        const weekOutcomeOn = (dayKey: string) => weekOn(dayKey)?.outcome ?? null;
        const weekly = isPerWeekFrequency(habitFrequencyOn(habit, todayKey));
        let rate: number | null | undefined;
        const week = weekly ? weekOn(todayKey) : null;
        const doneToday = outcomeOn(todayKey) === "met";
        const unitStart = frequencyUnitStart(habit, todayKey);
        const streakFrom = unitStart > firstDay ? unitStart : firstDay;
        summary = {
          todayTask,
          completedDates,
          streak: weekly
            ? habitWeekStreakOn(todayKey, weekOutcomeOn, streakFrom)
            : habitStreakOn(todayKey, outcomeOn, streakFrom),
          streakUnit: weekly ? "week" : "day",
          doneToday,
          askedToday: week
            ? week.met - (doneToday ? 1 : 0) < week.target
            : isHabitScheduledOn(habit, todayKey),
          skipState: !week
            ? outcomeOn(todayKey)
            : week.met >= week.target
            ? "met"
            : week.skipped
            ? "skipped"
            : "open",
          week,
          weekOutcomeOn,
          outcomeOn,
          successRate: () =>
            rate === undefined
              ? (rate = habitSuccessRate(
                  weekly
                    ? weekOutcomesBackFrom(todayKey, firstDay, weekOutcomeOn)
                    : outcomesBackFrom(todayKey, firstDay, outcomeOn)
                ))
              : rate,
        };
        cache.set(habitId, summary);
      }
      return summary;
    },
  };
}

/**
 * SHARED "asks for a day Task today" rule: asked today (askedToday) and not
 * set aside, so an N per week Habit stops showing in Today once N are Met or
 * its Habit Week is Skipped.
 */
export function habitWantsDayTask(summary: Pick<HabitDaySummary, "askedToday" | "skipState">): boolean {
  return summary.askedToday && summary.skipState !== "skipped";
}

/**
 * SHARED "done today" tally: the Habits asked of today (habitWantsDayTask) and
 * how many of them are done, leaving Avoid Habits out (they ask nothing to be
 * done). Today is the day `summaryFor` was built for; the third argument is
 * kept for existing callers.
 */
export function habitTodayTally(
  habits: readonly Habit[],
  summaryFor: (habitId: string) => HabitDaySummary,
  _todayKey?: string
): { done: number; asked: number } {
  let done = 0;
  let asked = 0;
  for (const habit of habits) {
    // An Avoid Habit asks nothing to be done: it is kept unless a Slip is logged.
    if (habitKindOf(habit) === "avoid") continue;
    const summary = summaryFor(habit.id);
    if (!habitWantsDayTask(summary)) continue;
    asked += 1;
    if (summary.doneToday) done += 1;
  }
  return { done, asked };
}
