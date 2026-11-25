"use client";

import React from "react";
import type { Habit } from "@/lib/domainTypes";
import type { HabitOutcome } from "@/lib/habitOutcome";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";

const SKIP_BUTTON =
  "min-h-8 coarse:min-h-11 rounded-lg px-2 text-xs transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80";

/**
 * A Habit card's "Skip today" control: Skip while today's day is Open and no
 * focus runs on it, "Skipped today" with Undo skip once it is set aside,
 * nothing once it is Met. A Skipped day neither breaks nor adds to the Streak.
 */
export function HabitSkipToday({
  habit,
  todayKey,
  outcome,
  focusRunning,
}: {
  habit: Pick<Habit, "id" | "title">;
  todayKey: string;
  /** Today's Outcome for this Habit. */
  outcome: HabitOutcome | null;
  focusRunning: boolean;
}) {
  const setHabitDaySkipped = useCommandStore((s) => s.setHabitDaySkipped);
  const { title } = habit;
  const onSkip = (skipped: boolean) => {
    hudAudio.playClick();
    void setHabitDaySkipped(habit.id, todayKey, skipped);
  };
  if (outcome === "skipped") {
    return (
      <span className="flex items-center gap-1">
        <span className="text-xs text-hud-muted">Skipped today</span>
        <button
          type="button"
          onClick={() => onSkip(false)}
          aria-label={`Undo skip: ${title}`}
          className={`${SKIP_BUTTON} text-neutral-300`}
        >
          Undo skip
        </button>
      </span>
    );
  }
  if (outcome !== "open" || focusRunning) return null;
  return (
    <button
      type="button"
      onClick={() => onSkip(true)}
      aria-label={`Skip today: ${title}`}
      title="Set today aside: it neither breaks nor adds to the streak"
      className={`${SKIP_BUTTON} text-hud-muted`}
    >
      Skip today
    </button>
  );
}
