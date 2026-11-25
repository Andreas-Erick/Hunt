import type { Quest, Task } from "./domainTypes";
import { habitDaySlips } from "./habitKind";
import { habitDayOutcome, habitStreakOf, type HabitOutcome } from "./habitOutcome";

/**
 * Deterministic Quest sort by slotIndex (0..2), breaking ties by createdAt then id.
 * Coerces missing/non-finite slotIndex values to 0 so a malformed or legacy synced
 * quest row is never dropped (unlike `db.quests.orderBy("slotIndex")`, whose IDB
 * index cursor omits any record with a missing or non-indexable key).
 */
export function compareQuestSlot(
  a: Pick<Quest, "id"> & { slotIndex?: unknown; createdAt?: unknown },
  b: Pick<Quest, "id"> & { slotIndex?: unknown; createdAt?: unknown }
): number {
  const sa = Number.isFinite(Number(a.slotIndex)) ? Number(a.slotIndex) : 0;
  const sb = Number.isFinite(Number(b.slotIndex)) ? Number(b.slotIndex) : 0;
  if (sa !== sb) return sa - sb;
  const ca = Number.isFinite(Number(a.createdAt)) ? Number(a.createdAt) : 0;
  const cb = Number.isFinite(Number(b.createdAt)) ? Number(b.createdAt) : 0;
  if (ca !== cb) return ca - cb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic daily task id for a Habit materialized on `dateKey`.
 * Both laptop and phone produce the exact same id offline, so sync merges
 * them into a single task with zero duplicates.
 */
export function habitTaskId(habitId: string, dateKey: string): string {
  return `habtsk-${dateKey}-${habitId}`;
}

/**
 * Whether an open task belongs in today's Home queue / Focus picker.
 * Regular tasks carry over if overdue (<= todayKey) or unscheduled; daily
 * habit instances show ONLY on their own day so missed habits never pile up,
 * and not at all once Skipped (a day set aside is not asked of the user).
 */
export function isTaskVisibleToday(
  task: Pick<Task, "scheduledDate" | "habitId" | "skipped">,
  todayKey: string
): boolean {
  if (task.habitId) {
    return task.scheduledDate === todayKey && !task.skipped;
  }
  return !task.scheduledDate || task.scheduledDate <= todayKey;
}

/**
 * A queued habit day Task whose day's Outcome is Missed (habitDayOutcome).
 * It stays in the table as history (streaks, Review, its own Plan the week
 * column) but is never an open task on a later day. A dateless habit row is
 * not today's instance, so it counts as past. An 'active' instance (focus
 * still running across midnight) is Open, not Missed.
 */
export function isMissedHabitTask(
  task: Pick<Task, "status" | "scheduledDate" | "habitId">,
  todayKey: string
): boolean {
  return (
    Boolean(task.habitId) &&
    task.status === "queued" &&
    habitDayOutcome({ habit: {}, dayKey: task.scheduledDate ?? "", dayTask: task, todayKey }) ===
      "missed"
  );
}

/**
 * SHARED open-task rule for every list, count and picker of open work on
 * `todayKey`: queued or active, minus missed, Skipped and slipped habit days (a
 * Skipped day is not asked of the user, and an Avoid Habit's day with a Slip is
 * already Missed, so both leave Today and the Day Widget).
 */
export function isOpenTask(
  task: Pick<Task, "status" | "scheduledDate" | "habitId" | "skipped" | "slips">,
  todayKey: string
): boolean {
  return (
    (task.status === "queued" || task.status === "active") &&
    !(task.habitId && (task.skipped || habitDaySlips(task) > 0)) &&
    !isMissedHabitTask(task, todayKey)
  );
}

/**
 * Formats a timestamp (ms) into local YYYY-MM-DD string
 */
export function toLocalDateKey(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local date for a YYYY-MM-DD key, at noon (safe across DST changes). */
export function dateFromKey(dateKey: string, dayOffset = 0): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d + dayOffset, 12);
}

/**
 * The YYYY-MM-DD key `dayOffset` calendar days away from `baseKey`. Steps whole
 * calendar days from a noon anchor, so 23- and 25-hour DST days never skip or
 * repeat a key (unlike `now - n * 86_400_000`).
 */
export function dateKeyFromOffset(baseKey: string, dayOffset: number): string {
  return toLocalDateKey(dateFromKey(baseKey, dayOffset).getTime());
}

/**
 * Milliseconds from `nowMs` until shortly after the next local calendar midnight.
 * Anchored via `new Date(y, m, d + 1, 0, 0, 0, 50)` so DST transitions stay exact.
 */
export function msUntilNextLocalMidnight(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const nextMidnight = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    0,
    0,
    0,
    50
  ).getTime();
  return Math.max(50, nextMidnight - nowMs);
}

/** `outcomeOn` for each day from `todayKey` back to `firstDayKey` (inclusive). */
function* outcomesBackFrom(
  todayKey: string,
  firstDayKey: string,
  outcomeOn: (dayKey: string) => HabitOutcome | null
): Generator<HabitOutcome | null> {
  for (let offset = 0; ; offset -= 1) {
    const dayKey = dateKeyFromOffset(todayKey, offset);
    if (dayKey < firstDayKey) return;
    yield outcomeOn(dayKey);
  }
}

/**
 * A Habit's Streak on `todayKey`, from its Outcome on each day (habitStreakOf),
 * reading no further back than `firstDayKey`, the first day the Habit could
 * have been Met. The bound ends the walk when unscheduled days (no Outcome)
 * would otherwise be passed over forever.
 */
export function habitStreakOn(
  todayKey: string,
  outcomeOn: (dayKey: string) => HabitOutcome | null,
  firstDayKey: string
): number {
  return habitStreakOf(outcomesBackFrom(todayKey, firstDayKey, outcomeOn));
}

const TICKED_DAY: Pick<Task, "status"> = { status: "completed" };

/**
 * The Streak of a daily Check Habit from the days it was Met: consecutive Met
 * days ending today, or yesterday while today is Open.
 */
export function computeHabitStreak(
  completedDates: ReadonlySet<string>,
  todayKey: string
): number {
  let firstDayKey = todayKey;
  for (const dayKey of completedDates) if (dayKey < firstDayKey) firstDayKey = dayKey;
  return habitStreakOn(
    todayKey,
    (dayKey) =>
      habitDayOutcome({
        habit: {},
        dayKey,
        dayTask: completedDates.has(dayKey) ? TICKED_DAY : undefined,
        todayKey,
      }),
    firstDayKey
  );
}

/** Whole, non-negative seconds; NaN, ±Infinity and non-numeric input become 0. */
function toSafeWholeSeconds(totalSeconds: number): number {
  const n = Number(totalSeconds);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Formats seconds into MM:SS (or H:MM:SS if >= 60 minutes)
 */
export function formatChronoMMSS(totalSeconds: number): {
  minutes: string;
  seconds: string;
  hoursPrefix: string | null;
  formatted: string;
} {
  const safe = toSafeWholeSeconds(totalSeconds);
  const totalMinutes = Math.floor(safe / 60);
  const secs = safe % 60;
  const minsStr = String(totalMinutes).padStart(2, "0");
  const secsStr = String(secs).padStart(2, "0");

  const h = Math.floor(safe / 3600);
  const mRem = Math.floor((safe % 3600) / 60);
  const hFormatted =
    h > 0
      ? `${h}:${String(mRem).padStart(2, "0")}:${secsStr}`
      : `${minsStr}:${secsStr}`;

  return {
    minutes: minsStr,
    seconds: secsStr,
    hoursPrefix: h > 0 ? String(h) : null,
    formatted: hFormatted,
  };
}

/**
 * Formats duration in compact notation e.g. "1h 24m" or "42m"
 */
export function formatTacticalDuration(totalSeconds: number): string {
  const safe = toSafeWholeSeconds(totalSeconds);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  if (m > 0) {
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  return `${s}s`;
}
