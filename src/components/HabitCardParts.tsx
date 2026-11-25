"use client";

import React from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import type { HabitOutcome } from "@/lib/habitOutcome";

/**
 * A Habit card's tick for today. Disabled on a day the Habit's Frequency does
 * not ask for (nothing to tick), with a dashed ring and its own label.
 */
export function HabitTodayCheck({
  title,
  askedToday,
  doneToday,
  accentBg,
  onToggle,
}: {
  title: string;
  askedToday: boolean;
  doneToday: boolean;
  /** The Quest accent's background class, for a ticked ring. */
  accentBg: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!askedToday}
      aria-label={
        !askedToday
          ? `Not scheduled today: ${title}`
          : doneToday
          ? `Reopen today's habit: ${title}`
          : `Complete today's habit: ${title}`
      }
      aria-pressed={askedToday ? doneToday : undefined}
      className={`relative mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border before:absolute before:-inset-3 before:content-[''] transition-[transform,opacity,background-color,border-color,color] duration-150 ease-out active:scale-90 active:opacity-80 ${
        !askedToday
          ? "cursor-not-allowed border-dashed border-white/20 text-transparent"
          : doneToday
          ? `${accentBg} border-transparent text-black`
          : "border-white/40 text-transparent hover:border-success hover:text-success"
      }`}
    >
      {doneToday ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-3 w-3"
        >
          <motion.path
            d="M20 6 9 17l-5-5"
            strokeDasharray={24}
            initial={{ strokeDashoffset: 24 }}
            animate={{ strokeDashoffset: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          />
        </svg>
      ) : (
        <Check className="h-3 w-3 stroke-[2.5]" />
      )}
    </button>
  );
}

/**
 * A Habit card's recent days, oldest first: a dot per scheduled day (filled
 * when Met, ringed for today) and a short dash for a day with no Outcome
 * (the Frequency did not ask for it).
 */
export function HabitRecentDays({
  days,
  todayKey,
  outcomeOn,
  accentBg,
}: {
  days: readonly string[];
  todayKey: string;
  outcomeOn: (dayKey: string) => HabitOutcome | null;
  accentBg: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`${days.filter((d) => outcomeOn(d) === "met").length} of last ${days.length} days completed`}
    >
      {days.map((dKey) => {
        const outcome = outcomeOn(dKey);
        if (outcome === null) {
          return (
            <span key={dKey} title={`${dKey}: Not scheduled`} className="h-0.5 w-2 rounded-full bg-white/[0.12]" />
          );
        }
        const hit = outcome === "met";
        return (
          <span
            key={dKey}
            title={`${dKey}: ${hit ? "Completed" : "Not completed"}`}
            className={`h-2 w-2 rounded-full ${
              hit
                ? accentBg
                : dKey === todayKey
                ? "border border-white/30 bg-transparent"
                : "bg-white/[0.09]"
            }`}
          />
        );
      })}
    </div>
  );
}
