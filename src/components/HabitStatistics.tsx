"use client";

import React, { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Habit } from "@/lib/domainTypes";
import { habitStartKey } from "@/lib/habitCalendar";
import { countTargetOf, habitKindOf } from "@/lib/habitKind";
import { formatCountTotal, HABIT_SCORE_EXPLANATION, habitMonthAmounts, habitYearTotals } from "@/lib/habitStats";
import { hudAudio } from "@/lib/hudAudio";
import { HABIT_NAV_BUTTON } from "./HabitCalendar";

const monthName = (monthKey: string, withYear: boolean) => {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", withYear ? { month: "long", year: "numeric" } : { month: "long" });
};

/** Previous / title / next, the same row the Calendar tab uses. */
function PeriodNav({
  title,
  unit,
  prev,
  next,
}: {
  title: string;
  unit: "month" | "year";
  prev: (() => void) | null;
  next: (() => void) | null;
}) {
  const go = (fn: (() => void) | null) => () => {
    if (!fn) return;
    hudAudio.playClick();
    fn();
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <button type="button" onClick={go(prev)} disabled={!prev} aria-label={`Previous ${unit}`} className={HABIT_NAV_BUTTON}>
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="text-sm font-medium text-white" aria-live="polite">
        {title}
      </div>
      <button type="button" onClick={go(next)} disabled={!next} aria-label={`Next ${unit}`} className={HABIT_NAV_BUTTON}>
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * A Count Habit's month of daily amounts as columns: a day at or over the
 * target in the Habit's accent, one under it in a quiet neutral, with the
 * target as a dashed line. Each column names its day and amount (tooltip and
 * screen reader); the summary line under it carries the month without hover.
 */
function AmountChart({ habit, todayKey, amountOn, metClass }: StatsProps) {
  const [monthKey, setMonthKey] = useState(todayKey.slice(0, 7));
  const target = countTargetOf(habit);
  const unit = habit.unit?.trim() ? ` ${habit.unit.trim()}` : "";
  const month = habitMonthAmounts({ monthKey, todayKey, startKey: habitStartKey(habit, todayKey), target, amountOn });
  const name = monthName(month.monthKey, false);
  const logged = month.days.filter((d) => d.amount !== null);
  const reached = logged.filter((d) => d.reached).length;
  const best = logged.reduce((top, d) => Math.max(top, d.amount ?? 0), 0);
  const pct = (v: number) => `${(v / month.max) * 100}%`;
  return (
    <section className="mt-5" aria-label="Daily amounts">
      <PeriodNav
        title={monthName(month.monthKey, true)}
        unit="month"
        prev={month.prevMonthKey ? () => setMonthKey(month.prevMonthKey!) : null}
        next={month.nextMonthKey ? () => setMonthKey(month.nextMonthKey!) : null}
      />
      <div className="relative mt-6 h-32 border-b border-white/[0.15]">
        <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-white/50" style={{ bottom: pct(target) }} aria-hidden="true">
          <span className="absolute -top-4 right-0 text-[10px] tabular-nums text-hud-muted">target {formatCountTotal(target)}</span>
        </div>
        <ol aria-label={`Daily amounts, ${monthName(month.monthKey, true)}`} className="flex h-full items-end gap-[2px]">
          {month.days.map((d) => {
            if (d.amount === null) return <li key={d.dayKey} aria-hidden="true" className="h-full flex-1" />;
            const label = `${d.day} ${name}: ${formatCountTotal(d.amount)}${unit}, ${d.reached ? "target reached" : "under target"}`;
            return (
              <li key={d.dayKey} aria-label={label} title={label} className="flex h-full min-w-0 flex-1 items-end justify-center">
                <span
                  className={`block w-full max-w-6 rounded-t-[4px] ${d.reached ? metClass : "bg-white/25"}`}
                  style={{ height: d.amount > 0 ? `max(2px, ${pct(d.amount)})` : 0 }}
                />
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-hud-muted" aria-hidden="true">
        <span>1</span>
        <span>{month.days.length}</span>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-hud-muted" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <span className={`h-3 w-3 rounded ${metClass}`} aria-hidden="true" />
          At or over target
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-white/25" aria-hidden="true" />
          Under target
        </li>
      </ul>
      <p className="mt-2 break-words text-xs text-neutral-300 [overflow-wrap:anywhere]">
        {logged.length === 0
          ? "No days in this month yet."
          : `Target reached on ${reached} of ${logged.length} days · best day ${formatCountTotal(best)}${unit}`}
      </p>
    </section>
  );
}

/** A Count Habit's totals per month of one year, as a table with a quiet bar per month. */
function YearTotals({ habit, todayKey, amountOn, metClass }: StatsProps) {
  const [year, setYear] = useState(Number(todayKey.slice(0, 4)));
  const totals = habitYearTotals({ year, todayKey, startKey: habitStartKey(habit, todayKey), amountOn });
  const unit = habit.unit?.trim() ? ` ${habit.unit.trim()}` : "";
  const top = Math.max(0, ...totals.months.map((m) => m.total ?? 0));
  return (
    <section className="mt-5" aria-label="Yearly totals">
      <PeriodNav
        title={String(totals.year)}
        unit="year"
        prev={totals.prevYear ? () => setYear(totals.prevYear!) : null}
        next={totals.nextYear ? () => setYear(totals.nextYear!) : null}
      />
      <table aria-label={`Totals per month, ${totals.year}`} className="mt-2 w-full table-fixed text-xs">
        <tbody>
          {totals.months.map((m) => (
            <tr key={m.monthKey}>
              <th scope="row" className="w-24 py-1 text-left font-normal text-hud-muted">
                {monthName(m.monthKey, false)}
              </th>
              <td className="py-1 pr-2" aria-hidden="true">
                <span
                  className={`block h-2 rounded-full ${metClass}`}
                  style={{ width: top > 0 && m.total ? `${(m.total / top) * 100}%` : 0 }}
                />
              </td>
              <td className="w-[45%] break-words py-1 text-right tabular-nums text-neutral-200 [overflow-wrap:anywhere]">
                {m.total === null ? "—" : `${formatCountTotal(m.total)}${unit}`}
              </td>
            </tr>
          ))}
          <tr className="border-t border-white/[0.08]">
            <th scope="row" className="pt-2 text-left font-medium text-white">
              Year
            </th>
            <td aria-hidden="true" />
            <td className="break-words pt-2 text-right font-medium tabular-nums text-white [overflow-wrap:anywhere]">
              {formatCountTotal(totals.total)}
              {unit}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

interface StatsProps {
  habit: Habit;
  todayKey: string;
  amountOn: (dayKey: string) => number;
  /** The Habit's accent background class (a Met day, a column at target). */
  metClass: string;
}

/**
 * The Habit detail's Statistics tab: the Habit Score (0-100) with a one-line
 * explanation, never the formula; a Count Habit adds its month chart of daily
 * amounts and its totals per month of the year.
 */
export function HabitStatistics({ score, ...props }: StatsProps & { score: number | null }) {
  return (
    <div>
      <div className="rounded-xl border border-white/[0.06] bg-sunken px-3 py-3">
        <div className="text-xs text-neutral-400">Habit Score</div>
        {score === null ? (
          <div className="mt-1 text-base font-medium text-neutral-300">No score yet</div>
        ) : (
          <div className="mt-1 flex items-baseline gap-1">
            <span className="font-display text-5xl font-semibold leading-none tabular-nums text-white">{score}</span>
            <span className="text-sm text-hud-muted">/ 100</span>
          </div>
        )}
        <p className="mt-2 text-xs leading-snug text-hud-muted">{HABIT_SCORE_EXPLANATION}</p>
      </div>
      {habitKindOf(props.habit) === "count" && (
        <>
          <AmountChart {...props} />
          <YearTotals {...props} />
        </>
      )}
    </div>
  );
}
