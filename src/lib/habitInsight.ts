import { dateFromKey, toLocalDateKey } from "./dateUtils";
import type { HabitOutcome } from "./habitOutcome";

/**
 * SHARED Success Rate rule (GLOSSARY: Success Rate): Met / (Met + Missed) over
 * `outcomes`, a fraction from 0 to 1, or null when none was Met or Missed yet
 * (no history, or only Skipped, Open and unscheduled units). Generic over the
 * unit, so a sequence of Habit Week Outcomes reads the same as days.
 */
export function habitSuccessRate(outcomes: Iterable<HabitOutcome | null>): number | null {
  let met = 0;
  let missed = 0;
  for (const outcome of outcomes) {
    if (outcome === "met") met += 1;
    else if (outcome === "missed") missed += 1;
  }
  return met + missed === 0 ? null : met / (met + missed);
}

/**
 * A Success Rate as the card shows it: a whole percent ("67%"), or null when
 * there is none yet. Only a perfect record reads 100%, only an empty one 0%.
 */
export function habitSuccessRateLabel(rate: number | null): string | null {
  if (rate === null) return null;
  const percent = rate <= 0 ? 0 : rate >= 1 ? 100 : Math.min(99, Math.max(1, Math.round(rate * 100)));
  return `${percent}%`;
}

/** Days the Habit card's week strip shows, ending today. */
export const HABIT_WEEK_STRIP_DAYS = 7;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const OUTCOME_NAME: Record<HabitOutcome, string> = {
  open: "Open",
  met: "Met",
  missed: "Missed",
  skipped: "Skipped",
};

/** One day of the Habit card's week strip. */
export interface HabitStripDay {
  dayKey: string;
  /** The day's Outcome, or null when its Frequency did not ask for it. */
  outcome: HabitOutcome | null;
  /** The weekday's initial ("M"), shown under the day. */
  weekday: string;
  /** The day in plain words, for screen readers and tooltips: "Mon 11 (today): Open". */
  label: string;
}

/**
 * SHARED week strip: the HABIT_WEEK_STRIP_DAYS days ending `lastKey` (today, or
 * an Ended Habit's end date), oldest first, each with its Outcome (`outcomeOn`)
 * and its name, so both apps draw and label the same days.
 */
export function habitWeekStrip(
  lastKey: string,
  outcomeOn: (dayKey: string) => HabitOutcome | null,
  todayKey: string = lastKey
): HabitStripDay[] {
  return Array.from({ length: HABIT_WEEK_STRIP_DAYS }, (_, idx) => {
    const day = dateFromKey(lastKey, idx - (HABIT_WEEK_STRIP_DAYS - 1));
    const dayKey = toLocalDateKey(day.getTime());
    const outcome = outcomeOn(dayKey);
    const short = WEEKDAY_SHORT[day.getDay()];
    const when = `${short} ${day.getDate()}${dayKey === todayKey ? " (today)" : ""}`;
    return {
      dayKey,
      outcome,
      weekday: short[0],
      label: `${when}: ${outcome === null ? "Not scheduled" : OUTCOME_NAME[outcome]}`,
    };
  });
}
