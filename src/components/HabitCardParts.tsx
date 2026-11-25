"use client";

import React from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";

/**
 * A Habit card's tick for today. Disabled on a day the Habit's Frequency does
 * not ask for (nothing to tick), or once an N per week Habit's Habit Week is
 * Met, with a dashed ring and its own label.
 */
export function HabitTodayCheck({
  title,
  askedToday,
  weekly = false,
  doneToday,
  accentBg,
  onToggle,
}: {
  title: string;
  askedToday: boolean;
  /** An N per week Habit: not asked means its Habit Week is already Met. */
  weekly?: boolean;
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
          ? `${weekly ? "Not asked again this week" : "Not scheduled today"}: ${title}`
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
