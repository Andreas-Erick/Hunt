import type { Habit, Task } from "./domainTypes";
import { isHabitScheduledOn } from "./habitFrequency";
import { countTargetOf, habitDayAmount, habitKindOf } from "./habitKind";

/**
 * How a scheduled Habit day ended (GLOSSARY: Outcome). Derived, never stored.
 * Later Habit Kinds and Frequencies judge Habit Weeks; every caller already
 * goes through habitDayOutcome and habitStreakOf, so they extend here.
 */
export type HabitOutcome = "open" | "met" | "missed" | "skipped";

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
  dayTask: Pick<Task, "status" | "skipped" | "amount"> | undefined;
  /** Today's local YYYY-MM-DD key. */
  todayKey: string;
}

/**
 * SHARED Outcome rule: the Outcome of one Habit day, or null when the day has
 * none (yet): a day after today, or a day its Frequency did not ask for then. A
 * day is Met when the Habit's Kind says so: a Check Habit's day once ticked, a
 * Count Habit's once its total reaches the target (going over is still Met). A
 * day set aside on purpose (its day Task `skipped`) is Skipped; today, and a
 * past day whose focus is still running across midnight, are Open; any other
 * past day is Missed, a Count day that got only partway included.
 */
export function habitDayOutcome({ habit, dayKey, dayTask, todayKey }: HabitDay): HabitOutcome | null {
  if (dayKey > todayKey || !isHabitScheduledOn(habit, dayKey)) return null;
  const met =
    habitKindOf(habit) === "count"
      ? habitDayAmount(dayTask) >= countTargetOf(habit)
      : dayTask?.status === "completed";
  if (met) return "met";
  if (dayTask?.skipped) return "skipped";
  if (dayKey === todayKey || dayTask?.status === "active") return "open";
  return "missed";
}

/**
 * SHARED Streak rule: how many Met days in a row `outcomes` holds, newest
 * (today) first. Skipped days, days with no Outcome (unscheduled), and today
 * while Open are passed over, so a Streak does not drop to 0 each morning or on
 * a day set aside; any other non-Met day ends it. Reads only as far as the day
 * that ends the Streak, so `outcomes` may be a long walk back in time, but it
 * must end: a walk of only unscheduled or skipped days never ends the Streak.
 */
export function habitStreakOf(outcomes: Iterable<HabitOutcome | null>): number {
  let streak = 0;
  let isToday = true;
  for (const outcome of outcomes) {
    if (outcome === "met") streak += 1;
    else if (outcome !== null && outcome !== "skipped" && !(isToday && outcome === "open")) break;
    isToday = false;
  }
  return streak;
}
