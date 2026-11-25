import type { Habit, Task } from "./domainTypes";
import { cleanCountAmount, countTargetOf, habitDayAmount } from "./habitKind";
import { nextStamp } from "./taskQueue";

/**
 * SHARED "log a Count Habit day" rule: `task` (the Habit's day Task) with its
 * total set to `amount` at `at`, stamped by R6. The day's tick follows the
 * total, so every list that shows done Tasks agrees with the Outcome: reaching
 * the target completes the Task (at `at`, or its earlier completion time),
 * falling below it reopens it. A Task in Focus or archived keeps its status.
 * +1 and exact entry both go through here; the row merges whole (ADR-0001), so
 * two offline +1s on two devices can lose one. Pure.
 */
export function setHabitDayAmount(
  task: Task,
  habit: Readonly<Pick<Partial<Habit>, "target">>,
  amount: number,
  at: number
): Task {
  const total = cleanCountAmount(amount);
  const met = total >= countTargetOf(habit);
  const row: Task = { ...task, amount: total, updatedAt: nextStamp(task, at) };
  if (task.status === "active" || task.status === "archived") return row;
  if (met) {
    row.status = "completed";
    row.completedAt = task.status === "completed" && task.completedAt ? task.completedAt : at;
  } else {
    row.status = "queued";
    delete row.completedAt;
  }
  return row;
}

/** SHARED +1 on a Count Habit day: setHabitDayAmount with one more than its total. */
export function addHabitDayCount(
  task: Task,
  habit: Readonly<Pick<Partial<Habit>, "target">>,
  at: number
): Task {
  return setHabitDayAmount(task, habit, habitDayAmount(task) + 1, at);
}
