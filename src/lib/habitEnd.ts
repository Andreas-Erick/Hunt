import type { Habit, HabitEndedSpan } from "./domainTypes";
import { isDateKey } from "./syncValues";

/**
 * SHARED Ended Habit rules (GLOSSARY: Ended Habit). A Habit with an `endDate`
 * asks for days up to and including it; after it the Habit is Ended and those
 * days have no Outcome. Restarting it (clearing or moving the end date) keeps
 * the stretch it spent Ended as an `endedSpans` entry, so those days still have
 * no Outcome and never count against its Streak or Success Rate. Pure, so the
 * Frequency rule, the sync validator and the phone's bundled core all use it.
 */

/** Most Ended stretches a Habit row keeps (the newest). */
export const MAX_ENDED_SPANS = 100;

type EndSource = Readonly<Pick<Partial<Habit>, "endDate" | "endedSpans">>;

/** The local YYYY-MM-DD key `days` days after `dateKey` (negative: before). */
function shiftDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, m - 1, d + days, 12);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/** Whether `dayKey` is past the Habit's end date or inside a stretch it spent Ended. */
export function isHabitEndedOn(habit: EndSource, dayKey: string): boolean {
  if (habit.endDate && dayKey > habit.endDate) return true;
  return (habit.endedSpans ?? []).some((span) => span.from <= dayKey && dayKey <= span.to);
}

/** Whether the Habit is an Ended Habit on `todayKey`: its end date is before today. */
export function isEndedHabit(habit: EndSource, todayKey: string): boolean {
  return Boolean(habit.endDate) && (habit.endDate as string) < todayKey;
}

/**
 * The Habit's end fields after setting its end date to `endDate` (null clears
 * it) on `todayKey`. Restarting an Ended Habit (end date cleared, or moved to
 * today or later) keeps the days from the day after the old end date to
 * yesterday as an Ended stretch, so the gap never counts against it. Both
 * fields are always present (undefined when empty) so a Dexie update drops a
 * cleared one. Pure: the Habit is not modified.
 */
export function withHabitEndDate(
  habit: EndSource,
  endDate: string | null,
  todayKey: string
): { endDate: string | undefined; endedSpans: HabitEndedSpan[] | undefined } {
  const spans = [...(habit.endedSpans ?? [])];
  const restarts = isEndedHabit(habit, todayKey) && (endDate === null || endDate >= todayKey);
  if (restarts) {
    const from = shiftDateKey(habit.endDate as string, 1);
    const to = shiftDateKey(todayKey, -1);
    if (from <= to) spans.push({ from, to });
  }
  const kept = spans.slice(-MAX_ENDED_SPANS);
  return { endDate: endDate ?? undefined, endedSpans: kept.length > 0 ? kept : undefined };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An end date as both apps show it: "15 May", with the year when it is not `todayKey`'s year. */
export function habitEndDateLabel(dateKey: string, todayKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const year = dateKey.slice(0, 4) === todayKey.slice(0, 4) ? "" : ` ${y}`;
  return `${d} ${MONTHS[m - 1]}${year}`;
}

/**
 * Sync boundary: the valid end fields of an untrusted Habit row, with only the
 * keys that hold a value. A bad end date is dropped (the row then never ends);
 * Ended stretches with a bad or reversed date are dropped, the rest kept
 * ascending, the newest MAX_ENDED_SPANS.
 */
export function sanitizeHabitEnd(raw: { endDate?: unknown; endedSpans?: unknown }): Partial<EndSource> {
  const out: { endDate?: string; endedSpans?: HabitEndedSpan[] } = {};
  if (isDateKey(raw.endDate)) out.endDate = raw.endDate;
  if (Array.isArray(raw.endedSpans)) {
    const spans = raw.endedSpans
      .slice(-MAX_ENDED_SPANS * 4)
      .filter((s): s is HabitEndedSpan => {
        const span = s as Partial<HabitEndedSpan> | null;
        return typeof span === "object" && span !== null && isDateKey(span.from) && isDateKey(span.to) && span.from <= span.to;
      })
      .map(({ from, to }) => ({ from, to }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
      .slice(-MAX_ENDED_SPANS);
    if (spans.length > 0) out.endedSpans = spans;
  }
  return out;
}
