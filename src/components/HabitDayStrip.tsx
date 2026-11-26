"use client";

import React from "react";
import type { Habit } from "@/lib/domainTypes";
import type { HabitOutcome } from "@/lib/habitOutcome";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";
import { StableSlot } from "./StableSlot";

const SKIP_BUTTON =
  "min-h-8 coarse:min-h-11 rounded-lg px-2 text-xs transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80";

/**
 * A Habit card's "Skip today" control: Skip while today's day is Open and no
 * focus runs on it, "Skipped today" with Undo skip once it is set aside,
 * nothing once it is Met. A Skipped day neither breaks nor adds to the Streak.
 * All three share one slot sized for the largest, so ticking, skipping or
 * undoing never moves the strip and stats beside it.
 * For an N per week Habit (`weekly`) it skips the whole Habit Week instead.
 */
export function HabitSkipToday({
  habit,
  todayKey,
  outcome,
  weekly = false,
  focusRunning,
}: {
  habit: Pick<Habit, "id" | "title">;
  todayKey: string;
  /** The Outcome a Skip acts on (HabitDaySummary.skipState). */
  outcome: HabitOutcome | null;
  weekly?: boolean;
  focusRunning: boolean;
}) {
  const period = weekly ? "this week" : "today";
  const setHabitDaySkipped = useCommandStore((s) => s.setHabitDaySkipped);
  const { title } = habit;
  const onSkip = (skipped: boolean) => {
    hudAudio.playClick();
    void setHabitDaySkipped(habit.id, todayKey, skipped);
  };
  // No Outcome to act on (a day not asked for): nothing here changes in place, so no slot either.
  if (outcome === null) return null;
  const active = outcome === "skipped" ? "skipped" : outcome === "open" && !focusRunning ? "skip" : null;
  return (
    <StableSlot
      active={active}
      states={{
        skip: (
          <button
            type="button"
            onClick={() => onSkip(true)}
            aria-label={`Skip ${period}: ${title}`}
            title={`Set ${period} aside: it neither breaks nor adds to the streak`}
            className={`${SKIP_BUTTON} text-hud-muted`}
          >
            Skip {period}
          </button>
        ),
        skipped: (
          <span className="flex items-center gap-1">
            <span className="text-xs text-hud-muted">Skipped {period}</span>
            <button
              type="button"
              onClick={() => onSkip(false)}
              aria-label={`Undo skip: ${title}`}
              className={`${SKIP_BUTTON} text-neutral-300`}
            >
              Undo skip
            </button>
          </span>
        ),
      }}
    />
  );
}
