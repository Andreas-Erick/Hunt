"use client";

import React from "react";
import type { HabitDaySummary } from "@/lib/habitDay";
import { habitSuccessRateLabel, habitWeekStrip, type HabitStripDay } from "@/lib/habitInsight";

const GLYPH = "h-2.5 w-2.5";

/**
 * One week-strip day. Each Outcome has its own shape, so the strip reads
 * without colour: Met is a filled disc with a tick, Missed a ring with a cross,
 * Skipped a dashed ring, Open (today) a plain ring, and a day the Frequency did
 * not ask for a short dash.
 */
function StripDay({ day, isToday, metClass }: { day: HabitStripDay; isToday: boolean; metClass: string }) {
  const { outcome } = day;
  let mark: React.ReactNode;
  if (outcome === "met") {
    mark = (
      <span className={`grid h-3.5 w-3.5 place-items-center rounded-full text-black ${metClass}`}>
        <svg data-testid="strip-glyph-met" viewBox="0 0 24 24" aria-hidden="true" className={GLYPH} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  } else if (outcome === "missed") {
    mark = (
      <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-white/25 text-white/50">
        <svg data-testid="strip-glyph-missed" viewBox="0 0 24 24" aria-hidden="true" className="h-2 w-2" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </span>
    );
  } else if (outcome === "skipped") {
    mark = <span className="h-3.5 w-3.5 rounded-full border border-dashed border-white/40" />;
  } else if (outcome === "open") {
    mark = <span className="h-3.5 w-3.5 rounded-full border border-white/50" />;
  } else {
    mark = (
      <span className="grid h-3.5 w-3.5 place-items-center">
        <span className="h-0.5 w-2 rounded-full bg-white/[0.14]" />
      </span>
    );
  }
  return (
    <li
      aria-label={day.label}
      title={day.label}
      data-outcome={outcome ?? "none"}
      className="flex flex-col items-center gap-0.5"
    >
      {mark}
      <span
        aria-hidden="true"
        className={`text-[9px] leading-none ${isToday ? "font-semibold text-neutral-300" : "text-hud-muted"}`}
      >
        {day.weekday}
      </span>
    </li>
  );
}

/**
 * A Habit card's insight row: the week strip of the last 7 days' Outcomes,
 * oldest first, then the Streak and the Success Rate (shared rules).
 */
export function HabitCardStats({
  summary,
  todayKey,
  metClass,
}: {
  summary: Pick<HabitDaySummary, "outcomeOn" | "streak" | "successRate">;
  todayKey: string;
  /** The Habit's accent background class for a Met day. */
  metClass: string;
}) {
  const strip = habitWeekStrip(todayKey, summary.outcomeOn);
  const rate = habitSuccessRateLabel(summary.successRate());
  return (
    <>
      <ul aria-label="Last 7 days" className="flex items-end gap-1">
        {strip.map((day) => (
          <StripDay key={day.dayKey} day={day} isToday={day.dayKey === todayKey} metClass={metClass} />
        ))}
      </ul>
      {summary.streak > 0 && (
        <span className="font-mono text-xs tabular-nums text-neutral-300">{summary.streak}d streak</span>
      )}
      {rate !== null && (
        <span
          aria-label={`Success Rate ${rate}`}
          title="Success Rate: Met days out of Met and Missed ones since the habit began"
          className="font-mono text-xs tabular-nums text-hud-muted"
        >
          {rate}
        </span>
      )}
    </>
  );
}
