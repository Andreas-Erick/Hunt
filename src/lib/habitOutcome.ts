import type { Habit, Task } from "./domainTypes";
import { countTargetOf, habitDayAmount, habitKindOf } from "./habitKind";

/**
 * How a scheduled Habit day ended (GLOSSARY: Outcome). Derived, never stored.
 * Later Habit Kinds and Frequencies add "skipped" and judge Habit Weeks; every
 * caller already goes through habitDayOutcome and habitStreakOf, so they extend
 * here.
 */
export type HabitOutcome = "open" | "met" | "missed";

/** One Habit day to judge. */
export interface HabitDay {
  /**
   * The Habit, as stored. A row without a Kind or Frequency reads as a daily
   * Check Habit (the migration rule), so `{}` judges a day of an old row.
   */
  habit: Readonly<Partial<Habit>>;
  /** The local YYYY-MM-DD day being judged. */
  dayKey: string;
  /**
   * The day's Task, or undefined when it was never materialized. A late tick
   * belongs to its scheduled day (completionDateKey), so a task ticked after
   * midnight is passed as the Task of the day before.
   */
  dayTask: Pick<Task, "status" | "amount"> | undefined;
  /** Today's local YYYY-MM-DD key. */
  todayKey: string;
}

/**
 * SHARED Outcome rule: the Outcome of one Habit day, or null when the day has
 * none (yet): a day after today. A day is Met when the Habit's Kind says so: a
 * Check Habit's day once ticked, a Count Habit's once its total reaches the
 * target (going over is still Met). Otherwise today, and a past day whose focus
 * is still running across midnight, are Open; any other past day is Missed, a
 * Count day that got only partway included.
 */
export function habitDayOutcome({ habit, dayKey, dayTask, todayKey }: HabitDay): HabitOutcome | null {
  if (dayKey > todayKey) return null;
  const met =
    habitKindOf(habit) === "count"
      ? habitDayAmount(dayTask) >= countTargetOf(habit)
      : dayTask?.status === "completed";
  if (met) return "met";
  if (dayKey === todayKey || dayTask?.status === "active") return "open";
  return "missed";
}

/**
 * SHARED Streak rule: how many Met days in a row `outcomes` holds, newest
 * (today) first. Today while Open is passed over, so a Streak does not drop to
 * 0 each morning; any other non-Met day ends it. Reads only as far as the day
 * that ends the Streak, so `outcomes` may be an endless walk back in time.
 */
export function habitStreakOf(outcomes: Iterable<HabitOutcome | null>): number {
  let streak = 0;
  let isToday = true;
  for (const outcome of outcomes) {
    if (outcome === "met") streak += 1;
    else if (!(isToday && outcome === "open")) break;
    isToday = false;
  }
  return streak;
}
