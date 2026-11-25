"use client";

import React, { useId } from "react";
import { hudAudio } from "@/lib/hudAudio";

/**
 * The Habit editor's optional end date (GLOSSARY: Ended Habit). `value` is a
 * YYYY-MM-DD key, or "" for none. After the end date the Habit leaves Today
 * and moves to the Ended section; clearing or moving it restarts the Habit.
 */
export function HabitEndDateField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-neutral-400">
        End date
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="date"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
          className="min-h-8 coarse:min-h-11 rounded-xl border border-white/15 bg-black/40 px-3 py-1.5 text-xs text-neutral-200 focus:border-accent focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              hudAudio.playClick();
              onChange("");
            }}
            aria-label="Clear end date"
            className="min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
          >
            Clear
          </button>
        )}
        <span id={`${id}-hint`} className="text-xs text-hud-muted">
          Optional. After it, the habit moves to Ended with its history.
        </span>
      </div>
    </div>
  );
}
