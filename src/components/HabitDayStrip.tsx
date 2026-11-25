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
  if (outcome === "skipped") {
    return (
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
    );
  }
  if (outcome !== "open" || focusRunning) return null;
  return (
    <button
      type="button"
      onClick={() => onSkip(true)}
      aria-label={`Skip ${period}: ${title}`}
      title={`Set ${period} aside: it neither breaks nor adds to the streak`}
      className={`${SKIP_BUTTON} text-hud-muted`}
    >
      Skip {period}
    </button>
  );
}

/**
 * A Habit card's recent days, oldest first: a dot per scheduled day (filled
 * when Met, dashed when Skipped, ringed for today while Open, dim when Missed)
 * and a short dash for a day with no Outcome (the Frequency did not ask for it).
 */
export function HabitRecentDays({
  days,
  todayKey,
  outcomeOn,
  metClass,
}: {
  days: readonly string[];
  todayKey: string;
  outcomeOn: (dayKey: string) => HabitOutcome | null;
  /** The Habit's accent background class for a Met dot. */
  metClass: string;
}) {
  const metCount = days.filter((d) => outcomeOn(d) === "met").length;
  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`${metCount} of last ${days.length} days completed`}
    >
      {days.map((dKey) => {
        const outcome = outcomeOn(dKey);
        if (outcome === null) {
          return (
            <span key={dKey} title={`${dKey}: Not scheduled`} className="h-0.5 w-2 rounded-full bg-white/[0.12]" />
          );
        }
        const label =
          outcome === "met" ? "Completed" : outcome === "skipped" ? "Skipped" : "Not completed";
        const look =
          outcome === "met"
            ? metClass
            : outcome === "skipped"
            ? "border border-dashed border-white/30 bg-transparent"
            : dKey === todayKey
            ? "border border-white/30 bg-transparent"
            : "bg-white/[0.09]";
        return <span key={dKey} title={`${dKey}: ${label}`} className={`h-2 w-2 rounded-full ${look}`} />;
      })}
    </div>
  );
}
