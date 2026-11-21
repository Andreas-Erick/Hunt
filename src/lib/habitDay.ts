import { computeHabitStreak, habitTaskId, toLocalDateKey } from "./dateUtils";
import type { Task } from "./domainTypes";

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
  /** Consecutive completed days ending today (or yesterday while today is open). */
  streak: number;
  /** Whether today's instance is completed. */
  doneToday: boolean;
}

const EMPTY_DATES: ReadonlySet<string> = new Set<string>();

/**
 * Per-habit day summary from the materialized habit tasks. Today's instance is
 * the row with the deterministic id (habitTaskId) when present, else any row of
 * that habit scheduled for `todayKey`. Pure: `habitTasks` is not modified.
 * Habits without any task still get a summary from `summaryFor`.
 */
export function summarizeHabitDays(
  habitTasks: readonly Task[],
  todayKey: string
): {
  summaryFor: (habitId: string) => HabitDaySummary;
} {
  const todayByHabit = new Map<string, Task>();
  const datesByHabit = new Map<string, Set<string>>();
  for (const task of habitTasks) {
    const habitId = task.habitId;
    if (!habitId) continue;
    const canonical = task.id === habitTaskId(habitId, todayKey);
    if (canonical || (task.scheduledDate === todayKey && !todayByHabit.has(habitId))) {
      todayByHabit.set(habitId, task);
    }
    const day = completionDateKey(task);
    if (day) {
      let dates = datesByHabit.get(habitId);
      if (!dates) {
        dates = new Set<string>();
        datesByHabit.set(habitId, dates);
      }
      dates.add(day);
    }
  }
  const cache = new Map<string, HabitDaySummary>();
  return {
    summaryFor(habitId) {
      let summary = cache.get(habitId);
      if (!summary) {
        const todayTask = todayByHabit.get(habitId);
        const completedDates = datesByHabit.get(habitId) ?? EMPTY_DATES;
        summary = {
          todayTask,
          completedDates,
          streak: computeHabitStreak(completedDates, todayKey),
          doneToday: todayTask?.status === "completed",
        };
        cache.set(habitId, summary);
      }
      return summary;
    },
  };
}
