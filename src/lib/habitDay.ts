import { habitStreakOn, habitTaskId, toLocalDateKey } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { isHabitScheduledOn } from "./habitFrequency";
import { habitKindOf } from "./habitKind";
import { habitDayOutcome, type HabitOutcome } from "./habitOutcome";

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
  /** Met days in a row ending today, or yesterday while today is Open. */
  streak: number;
  /** Whether today is Met (a Check Habit ticked, a Count Habit at its target). */
  doneToday: boolean;
  /** The Habit's Outcome on `dayKey` (habitDayOutcome), or null for a day after today. */
  outcomeOn: (dayKey: string) => HabitOutcome | null;
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
        const outcomeOn = (dayKey: string) =>
          habitDayOutcome({ habit, dayKey, dayTask: dayTasks?.get(dayKey), todayKey });
        summary = {
          todayTask,
          completedDates,
          streak: habitStreakOn(todayKey, outcomeOn, firstHabitDay(habit, dayTasks, todayKey)),
          doneToday: outcomeOn(todayKey) === "met",
          outcomeOn,
        };
        cache.set(habitId, summary);
      }
      return summary;
    },
  };
}

/**
 * SHARED "done today" tally: the Habits asked of `todayKey` (scheduled by
 * their Frequency, not Skipped, and not Avoid Habits) and how many of them
 * are done.
 */
export function habitTodayTally(
  habits: readonly Habit[],
  summaryFor: (habitId: string) => HabitDaySummary,
  todayKey: string
): { done: number; asked: number } {
  let done = 0;
  let asked = 0;
  for (const habit of habits) {
    // An Avoid Habit asks nothing to be done: it is kept unless a Slip is logged.
    if (!isHabitScheduledOn(habit, todayKey) || habitKindOf(habit) === "avoid") continue;
    const summary = summaryFor(habit.id);
    if (summary.outcomeOn(todayKey) === "skipped") continue;
    asked += 1;
    if (summary.doneToday) done += 1;
  }
  return { done, asked };
}
