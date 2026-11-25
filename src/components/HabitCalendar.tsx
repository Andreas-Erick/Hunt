"use client";

import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Habit } from "@/lib/domainTypes";
import { habitMonth, habitStartKey, type HabitCalendarDay, type HabitDayMark } from "@/lib/habitCalendar";
import type { HabitOutcome } from "@/lib/habitOutcome";
import { countProgressLabel, formatCountAmount, habitKindOf, parseCountAmount } from "@/lib/habitKind";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const OUTCOME_LABEL: Record<HabitOutcome, string> = {
  met: "Met",
  missed: "Missed",
  skipped: "Skipped",
  open: "Open",
};

const LEGEND: [HabitOutcome | null, string][] = [
  ["met", "Met"],
  ["missed", "Missed"],
  ["skipped", "Skipped"],
  ["open", "Open"],
  [null, "No Outcome"],
];

/** A month / year step button of the Habit detail (Calendar and Statistics tabs). */
export const HABIT_NAV_BUTTON =
  "grid h-9 w-9 place-items-center rounded-lg text-neutral-300 transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80 disabled:opacity-30 coarse:h-11 coarse:w-11";
const ACTION_BUTTON =
  "min-h-9 rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 text-sm text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/[0.07] hover:text-white active:opacity-80 coarse:min-h-11";

function monthDate(monthKey: string): Date {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1);
}

/** A day's look by Outcome; colour is never the only cue (the label carries the Outcome). */
function dayLook(outcome: HabitOutcome | null, metClass: string): string {
  switch (outcome) {
    case "met":
      return `${metClass} border border-transparent font-semibold text-black`;
    case "missed":
      return "border border-danger/40 bg-danger/[0.08] text-neutral-300";
    case "skipped":
      return "border border-dashed border-white/35 text-hud-muted";
    case "open":
      return "border border-white/50 text-white";
    default:
      return "border border-transparent bg-white/[0.03] text-hud-muted/60";
  }
}

/** A Count Habit day's progress and its exact total, set through the shared Count rule. */
function DayTotalForm({
  habit,
  dayName,
  amount,
  onSave,
}: {
  habit: Habit;
  dayName: string;
  amount: number;
  onSave: (amount: number) => void;
}) {
  const [text, setText] = useState(formatCountAmount(amount));
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const value = parseCountAmount(text);
        if (value === null) setInvalid(true);
        else onSave(value);
      }}
      className="mt-2 flex flex-wrap items-center gap-2"
    >
      <span className="min-w-0 break-words font-mono text-xs tabular-nums text-neutral-300 [overflow-wrap:anywhere]">
        {countProgressLabel(habit, amount)}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setInvalid(false);
        }}
        aria-label={`Total for ${dayName}`}
        aria-invalid={invalid}
        className={`min-h-9 w-20 rounded-lg border bg-black/40 px-2 text-sm tabular-nums text-white focus:outline-none coarse:min-h-11 ${
          invalid ? "border-danger" : "border-white/15 focus:border-accent"
        }`}
      />
      <button type="submit" className={ACTION_BUTTON}>
        Set total
      </button>
    </form>
  );
}

/**
 * The Habit detail's Calendar tab: a month of Outcomes with previous and next
 * month buttons, the Habit's notes, and, for a chosen day, Tick / Untick and
 * Skip / Undo skip (the shared correctHabitDayRow rule, so the change syncs).
 * A Count Habit's day also shows its progress and takes an exact total.
 */
export function HabitCalendar({
  habit,
  todayKey,
  outcomeOn,
  amountOn,
  metClass,
}: {
  habit: Habit;
  todayKey: string;
  outcomeOn: (dayKey: string) => HabitOutcome | null;
  /** A Count Habit's total on a day. */
  amountOn: (dayKey: string) => number;
  metClass: string;
}) {
  const correctHabitDay = useCommandStore((s) => s.correctHabitDay);
  const logHabitAmount = useCommandStore((s) => s.logHabitAmount);
  const isCount = habitKindOf(habit) === "count";
  const [monthKey, setMonthKey] = useState(todayKey.slice(0, 7));
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const month = habitMonth({ monthKey, todayKey, startKey: habitStartKey(habit, todayKey), outcomeOn });
  const monthName = monthDate(month.monthKey).toLocaleDateString("en-US", { month: "long" });
  const dayName = (d: HabitCalendarDay) => `${d.day} ${monthName}`;
  const chosen = month.weeks.flat().find((d) => d?.dayKey === chosenKey && d.correctable) ?? null;

  const goTo = (key: string | null) => {
    if (!key) return;
    hudAudio.playClick();
    setMonthKey(key);
    setChosenKey(null);
  };
  const mark = (day: HabitCalendarDay, to: HabitDayMark) => {
    hudAudio.playClick();
    void correctHabitDay(habit.id, day.dayKey, to);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => goTo(month.prevMonthKey)} disabled={!month.prevMonthKey} aria-label="Previous month" className={HABIT_NAV_BUTTON}>
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="text-sm font-medium text-white" aria-live="polite">
          {monthDate(month.monthKey).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
        </div>
        <button type="button" onClick={() => goTo(month.nextMonthKey)} disabled={!month.nextMonthKey} aria-label="Next month" className={HABIT_NAV_BUTTON}>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[11px] text-hud-muted" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {month.weeks.flat().map((d, i) => {
          if (!d) return <span key={`blank-${i}`} />;
          const label = `${dayName(d)}: ${d.outcome ? OUTCOME_LABEL[d.outcome] : "no Outcome"}`;
          const look = `flex h-9 w-full items-center justify-center rounded-lg text-xs tabular-nums coarse:h-11 ${dayLook(d.outcome, metClass)}`;
          if (!d.correctable) {
            return (
              <span key={d.dayKey} aria-label={label} title={label} className={look}>
                {d.day}
              </span>
            );
          }
          return (
            <button
              key={d.dayKey}
              type="button"
              onClick={() => setChosenKey(d.dayKey === chosenKey ? null : d.dayKey)}
              aria-label={label}
              aria-pressed={d.dayKey === chosen?.dayKey}
              title={label}
              className={`${look} transition-[transform,opacity] duration-150 ease-out active:scale-95 ${
                d.dayKey === chosen?.dayKey ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""
              }`}
            >
              {d.day}
            </button>
          );
        })}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-hud-muted" aria-label="Legend">
        {LEGEND.map(([outcome, text]) => (
          <li key={text} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded ${dayLook(outcome, metClass)}`} aria-hidden="true" />
            {text}
          </li>
        ))}
      </ul>

      <div className={`mt-3 ${isCount ? "min-h-[8.5rem] coarse:min-h-[9.5rem]" : "min-h-[5.5rem]"} rounded-xl border border-white/[0.06] bg-sunken px-3 py-2.5`}>
        {chosen ? (
          <div>
            <div className="text-sm text-white">
              {dayName(chosen)} · <span className="text-hud-muted">{chosen.outcome ? OUTCOME_LABEL[chosen.outcome] : ""}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {chosen.outcome === "met" ? (
                <button type="button" onClick={() => mark(chosen, "none")} aria-label={`Untick ${dayName(chosen)}`} className={ACTION_BUTTON}>
                  Untick
                </button>
              ) : (
                <button type="button" onClick={() => mark(chosen, "met")} aria-label={`Tick ${dayName(chosen)}`} className={ACTION_BUTTON}>
                  Tick
                </button>
              )}
              {chosen.outcome === "skipped" ? (
                <button type="button" onClick={() => mark(chosen, "none")} aria-label={`Undo skip ${dayName(chosen)}`} className={ACTION_BUTTON}>
                  Undo skip
                </button>
              ) : (
                <button type="button" onClick={() => mark(chosen, "skipped")} aria-label={`Skip ${dayName(chosen)}`} className={ACTION_BUTTON}>
                  Skip
                </button>
              )}
            </div>
            {isCount && (
              <DayTotalForm
                key={`${chosen.dayKey}:${amountOn(chosen.dayKey)}`}
                habit={habit}
                dayName={dayName(chosen)}
                amount={amountOn(chosen.dayKey)}
                onSave={(amount) => {
                  hudAudio.playClick();
                  void logHabitAmount(habit.id, chosen.dayKey, amount);
                }}
              />
            )}
          </div>
        ) : (
          <p className="text-xs text-hud-muted">Choose a day to tick, untick or Skip it. A Skipped day neither breaks nor adds to the streak.</p>
        )}
      </div>

      <div className="mt-4">
        <div className="text-xs text-neutral-400">Notes</div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-200 [overflow-wrap:anywhere]">
          {habit.notes || <span className="text-hud-muted">No notes.</span>}
        </p>
      </div>
    </div>
  );
}
