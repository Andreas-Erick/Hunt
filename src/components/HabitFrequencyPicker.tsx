"use client";

import React from "react";
import type { HabitFrequency, Weekday } from "@/lib/domainTypes";
import { HABIT_WEEKDAYS } from "@/lib/habitFrequency";
import { hudAudio } from "@/lib/hudAudio";

/** Whether a draft can be saved: chosen weekdays need at least one day. */
export function isHabitFrequencyValid(draft: HabitFrequency): boolean {
  return draft.type !== "weekdays" || draft.weekdays.length > 0;
}

const CHIP =
  "min-h-8 coarse:min-h-11 rounded-full border py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80";
const CHIP_ON = "border-white/25 bg-white/10 text-white font-medium";
const CHIP_OFF = "border-white/[0.07] text-hud-muted hover:text-neutral-300";

/**
 * Frequency editor for a Habit: every day, or chosen weekdays (Monday first).
 * Touch-sized chips; the weekday chips show only for chosen weekdays.
 */
export function HabitFrequencyPicker({
  value,
  onChange,
  label,
}: {
  value: HabitFrequency;
  onChange: (next: HabitFrequency) => void;
  /** Accessible name of the group. */
  label: string;
}) {
  const chosen = value.type === "weekdays" ? value.weekdays : null;
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
