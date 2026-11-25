import type { Task } from "@/lib/domainTypes";
import type { HabitDayMark } from "@/lib/habitCalendar";
import type { SlipEdit } from "@/lib/localHabitAvoid";
import { localStore } from "@/lib/localStore";

/** Runs a Local Store write as a named store action; false when it failed (actionError is set). */
export type RunAction = (name: string, action: () => Promise<unknown>) => Promise<boolean>;

/** The command store's actions on one Habit day. */
export interface HabitDayActions {
  /**
   * Today's (or `dateKey`'s) daily instance of one habit, materializing it first
   * when missing. Undefined when the habit is gone, the instance is tombstoned,
   * or the local write failed (actionError is then set).
   */
  ensureHabitTaskForDay: (habitId: string, dateKey: string) => Promise<Task | undefined>;
  /** Marks one habit day Skipped, or un-Skips it (the shared skipHabitDayRow row). */
  setHabitDaySkipped: (habitId: string, dateKey: string, skipped: boolean) => Promise<void>;
  /** Logs a Slip on an Avoid Habit's day, or undoes the newest one (the shared Slip rule). */
  editHabitSlip: (habitId: string, dateKey: string, edit: SlipEdit) => Promise<void>;
  /** Ticks, unticks or Skips one habit day from its calendar (the shared correctHabitDayRow row). */
  correctHabitDay: (habitId: string, dateKey: string, mark: HabitDayMark) => Promise<void>;
}

export function habitDayActions(run: RunAction): HabitDayActions {
  return {
    ensureHabitTaskForDay: async (habitId, dateKey) => {
      let task: Task | undefined;
      await run("ensureHabitTaskForDay", async () => {
        task = await localStore.ensureHabitTaskForDay(habitId, dateKey);
      });
      return task;
    },

    setHabitDaySkipped: async (habitId, dateKey, skipped) => {
      await run("setHabitDaySkipped", () => localStore.setHabitDaySkipped(habitId, dateKey, skipped));
    },

    editHabitSlip: async (habitId, dateKey, edit) => {
      await run("editHabitSlip", () => localStore.editHabitSlip(habitId, dateKey, edit));
    },

    correctHabitDay: async (habitId, dateKey, mark) => {
      await run("correctHabitDay", () => localStore.correctHabitDay(habitId, dateKey, mark));
    },
  };
}
