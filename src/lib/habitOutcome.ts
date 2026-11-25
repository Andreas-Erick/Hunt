import type { Habit, Task } from "./domainTypes";

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
  dayTask: Pick<Task, "status" | "skipped"> | undefined;
  /** Today's local YYYY-MM-DD key. */
  todayKey: string;
}

/**
 * SHARED Outcome rule: the Outcome of one Habit day, or null when the day has
 * none (yet): a day after today. A ticked day is Met; a day set aside on
 * purpose (its day Task `skipped`) is Skipped; today, and a past day whose
 * focus is still running across midnight, are Open; any other past day is
 * Missed.
 */
export function habitDayOutcome({ dayKey, dayTask, todayKey }: HabitDay): HabitOutcome | null {
  if (dayKey > todayKey) return null;
  if (dayTask?.status === "completed") return "met";
  if (dayTask?.skipped) return "skipped";
  if (dayKey === todayKey || dayTask?.status === "active") return "open";
  return "missed";
}

/**
 * SHARED Streak rule: how many Met days in a row `outcomes` holds, newest
 * (today) first. Skipped days, and today while Open, are passed over, so a
 * Streak does not drop to 0 each morning or on a day set aside; any other
 * non-Met day ends it. Reads only as far as the day
 * that ends the Streak, so `outcomes` may be an endless walk back in time.
 */
export function habitStreakOf(outcomes: Iterable<HabitOutcome | null>): number {
  let streak = 0;
  let isToday = true;
  for (const outcome of outcomes) {
    if (outcome === "met") streak += 1;
    else if (outcome !== "skipped" && !(isToday && outcome === "open")) break;
    isToday = false;
  }
  return streak;
}
