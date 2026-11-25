import type { Task } from "./domainTypes";
import { habitDaySlips, MAX_SLIPS } from "./habitKind";
import { nextStamp } from "./taskQueue";

/**
 * SHARED "log a Slip" rule (GLOSSARY: Avoid Habit, Slip): `task` (an Avoid
 * Habit's day Task) with one more Slip at `at`, stamped by R6. The Task's
 * status is left alone: an Avoid day is judged by its Slips (habitDayOutcome),
 * and a slipped day leaves open work (isOpenTask). The row merges whole
 * (ADR-0001), like a Count total. Pure.
 */
export function logHabitSlip(task: Task, at: number): Task {
  return { ...task, slips: Math.min(habitDaySlips(task) + 1, MAX_SLIPS), updatedAt: nextStamp(task, at) };
}

/**
 * SHARED "undo a Slip" rule: `task` with one Slip fewer at `at`. With none
 * left the field is removed, so the day reads as it did before any Slip. Pure.
 */
export function undoHabitSlip(task: Task, at: number): Task {
  const row: Task = { ...task, updatedAt: nextStamp(task, at) };
  const left = habitDaySlips(task) - 1;
  if (left > 0) row.slips = left;
  else delete row.slips;
  return row;
}
