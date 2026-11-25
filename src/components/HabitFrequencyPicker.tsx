"use client";

import React from "react";
import type { HabitFrequency, Weekday } from "@/lib/domainTypes";
import { HABIT_WEEKDAYS, habitFrequencyLabel, MAX_TIMES_PER_WEEK } from "@/lib/habitFrequency";
import { hudAudio } from "@/lib/hudAudio";

/** Whether a draft can be saved: chosen weekdays need at least one day. */
export function isHabitFrequencyValid(draft: HabitFrequency): boolean {
  return draft.type !== "weekdays" || draft.weekdays.length > 0;
}

const CHIP =
  "min-h-8 coarse:min-h-11 rounded-full border py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80";
const CHIP_ON = "border-white/25 bg-white/10 text-white font-medium";
const CHIP_OFF = "border-white/[0.07] text-hud-muted hover:text-neutral-300";

/** The N a fresh "Times a week" choice starts at. */
const DEFAULT_TIMES_PER_WEEK = 3;
const TIMES = Array.from({ length: MAX_TIMES_PER_WEEK }, (_, i) => i + 1);

/**
 * Frequency editor for a Habit: every day, chosen weekdays (Monday first), or
 * N times per Habit Week (1-7). Touch-sized chips; the weekday chips show only
 * for chosen weekdays, the 1-7 chips only for times a week. "Times a week" is
 * left out when the Habit's Kind may not use it (isFrequencyAllowedFor).
 */
export function HabitFrequencyPicker({
  value,
  onChange,
  label,
  allowPerWeek = true,
}: {
  value: HabitFrequency;
  onChange: (next: HabitFrequency) => void;
  /** Accessible name of the group. */
  label: string;
  /** Whether "Times a week" is offered (an Avoid Habit is judged day by day). */
  allowPerWeek?: boolean;
}) {
  const chosen = value.type === "weekdays" ? value.weekdays : null;
  const times = value.type === "perWeek" ? value.times : null;
  const pick = (next: HabitFrequency) => {
    hudAudio.playClick();
    onChange(next);
  };
  const toggleDay = (day: Weekday) => {
    if (!chosen) return;
    const weekdays = chosen.includes(day)
      ? chosen.filter((d) => d !== day)
      : [...chosen, day].sort((a, b) => a - b);
    pick({ type: "weekdays", weekdays });
  };

  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={value.type === "everyDay"}
        onClick={() => pick({ type: "everyDay" })}
        className={`${CHIP} px-3 ${value.type === "everyDay" ? CHIP_ON : CHIP_OFF}`}
      >
        Every day
      </button>
      <button
        type="button"
        aria-pressed={chosen !== null}
        onClick={() => {
          if (!chosen) pick({ type: "weekdays", weekdays: [] });
        }}
        className={`${CHIP} px-3 ${chosen ? CHIP_ON : CHIP_OFF}`}
      >
        Chosen days
      </button>
      {allowPerWeek && (
        <button
          type="button"
          aria-pressed={times !== null}
          onClick={() => {
            if (times === null) pick({ type: "perWeek", times: DEFAULT_TIMES_PER_WEEK });
          }}
          className={`${CHIP} px-3 ${times !== null ? CHIP_ON : CHIP_OFF}`}
        >
          Times a week
        </button>
      )}
      {times !== null && (
        <div className="flex flex-wrap items-center gap-1.5">
          {TIMES.map((n) => (
            <button
              key={n}
              type="button"
              aria-label={habitFrequencyLabel({ type: "perWeek", times: n })}
              aria-pressed={n === times}
              onClick={() => pick({ type: "perWeek", times: n })}
              className={`min-w-9 coarse:min-w-11 ${CHIP} px-2 tabular-nums ${n === times ? CHIP_ON : CHIP_OFF}`}
            >
              {n}
            </button>
          ))}
          <span className="text-xs text-hud-muted">per week, Monday to Sunday</span>
        </div>
      )}
      {chosen && (
        <div className="flex flex-wrap items-center gap-1.5">
          {HABIT_WEEKDAYS.map(({ day, label: short, name }) => {
            const on = chosen.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-label={name}
                aria-pressed={on}
                onClick={() => toggleDay(day)}
                className={`min-w-9 coarse:min-w-11 ${CHIP} px-2 ${on ? CHIP_ON : CHIP_OFF}`}
              >
                {short}
              </button>
            );
          })}
          {chosen.length === 0 && (
            <span className="text-xs text-hud-muted">Pick at least one day</span>
          )}
        </div>
      )}
    </div>
  );
}
