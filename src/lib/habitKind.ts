import type { Habit, HabitKind, Task } from "./domainTypes";

/**
 * SHARED Habit Kind rules (GLOSSARY: Habit Kind, Count Habit, Avoid Habit):
 * which Kinds exist, how a stored row reads, and how Count and Avoid fields
 * are validated at the sync boundary (syncTypes) and shown. Pure, and imports
 * no rule module, so syncTypes and the Outcome rule can both use it. Writing a
 * Count day's total is habitCount.ts; logging a Slip is habitAvoid.ts.
 */

/** What a Habit Kind does: its name, how a day of it is logged, and what it allows. */
export type HabitKindRules = {
  /** The Kind as the edit form names it. */
  label: string;
  /** How a day is logged on the Habit card: a tick, +1 / an exact total, or a Slip. */
  logs: "tick" | "count" | "slip";
  /** Whether a day of it can be worked on in a focus session. */
  canFocus: boolean;
  /** Whether it may ask N times per Habit Week (an Avoid Habit is judged day by day). */
  allowsPerWeek: boolean;
};

/** Every Habit Kind this build knows, with its rules. */
const HABIT_KIND_TABLE: Record<HabitKind, HabitKindRules> = {
  check: { label: "Check Habit", logs: "tick", canFocus: true, allowsPerWeek: true },
  count: { label: "Count Habit", logs: "count", canFocus: true, allowsPerWeek: true },
  avoid: { label: "Avoid Habit", logs: "slip", canFocus: false, allowsPerWeek: false },
};

/** Largest Count target or day total kept; larger ones are cut to it. */
export const MAX_COUNT_AMOUNT = 1_000_000;
/** Longest Count unit kept ("miles", "glasses"); longer ones are cut. */
export const MAX_COUNT_UNIT_LENGTH = 40;

/** True for a Habit Kind this build knows (own keys only, so "__proto__" is not one). */
export function isHabitKind(value: unknown): value is HabitKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HABIT_KIND_TABLE, value);
}

/**
 * The Habit's Kind: "check" for an old row without one, or with one this build
 * does not know (the migration rule).
 */
export function habitKindOf(habit: { readonly kind?: unknown } | null | undefined): HabitKind {
  const kind = habit?.kind;
  return isHabitKind(kind) ? kind : "check";
}

/** The rules of the Habit's Kind (HABIT_KIND_TABLE). */
export function habitKindRules(habit: { readonly kind?: unknown } | null | undefined): HabitKindRules {
  return HABIT_KIND_TABLE[habitKindOf(habit)];
}

/** A Count target or day total as stored: a finite number >= 0. */
function isCountAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function clampUnit(text: string): string {
  const max = MAX_COUNT_UNIT_LENGTH;
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Sync boundary: a Habit row's valid Kind fields from `raw`. An unknown Kind,
 * a target that is not a positive number and a unit that is not text are left
 * out (the row then reads as Check, or a target of 1); a huge target and a
 * long unit are cut.
 */
export function sanitizeHabitKindFields(raw: Record<string, unknown>): Partial<Habit> {
  const out: Partial<Habit> = {};
  if (isHabitKind(raw.kind)) out.kind = raw.kind;
  if (isCountAmount(raw.target) && raw.target > 0) out.target = Math.min(raw.target, MAX_COUNT_AMOUNT);
  if (typeof raw.unit === "string") out.unit = clampUnit(raw.unit);
  return out;
}

/** Sync boundary: a day Task row's valid Count fields (total, +1 tick time) from `raw`. */
export function sanitizeCountDayFields(raw: Record<string, unknown>): Partial<Task> {
  const out: Partial<Task> = {};
  if (isCountAmount(raw.amount)) out.amount = Math.min(raw.amount, MAX_COUNT_AMOUNT);
  const tickedAt = raw.countTickedAt;
  if (typeof tickedAt === "number" && tickedAt >= 0 && tickedAt <= Number.MAX_SAFE_INTEGER) {
    out.countTickedAt = tickedAt;
  }
  return out;
}

/** Most Slips kept on one Avoid Habit day; more are cut to it. */
export const MAX_SLIPS = 1000;

/** An Avoid Habit day's Slips: its stored count (a whole number), 0 when none was logged. */
export function habitDaySlips(task: Readonly<Pick<Partial<Task>, "slips">> | undefined): number {
  const slips = task?.slips;
  return typeof slips === "number" && Number.isInteger(slips) && slips > 0 ? Math.min(slips, MAX_SLIPS) : 0;
}

/** Sync boundary: a day Task row's valid Slip count from `raw` (a whole number >= 1; a huge one is cut). */
export function sanitizeSlipFields(raw: Record<string, unknown>): Partial<Task> {
  const slips = typeof raw.slips === "number" ? habitDaySlips({ slips: raw.slips }) : 0;
  return slips > 0 ? { slips } : {};
}

/** An Avoid Habit day as its row shows it: "Kept so far" with no Slip, else "1 Slip", "2 Slips". */
export function avoidDayLabel(slips: number): string {
  if (!(slips > 0)) return "Kept so far";
  return slips === 1 ? "1 Slip" : `${slips} Slips`;
}

/** A Count Habit's target: its stored target when positive, else 1. */
export function countTargetOf(habit: Readonly<Pick<Partial<Habit>, "target">>): number {
  const target = habit.target;
  return typeof target === "number" && Number.isFinite(target) && target > 0
    ? Math.min(target, MAX_COUNT_AMOUNT)
    : 1;
}

/** A Count Habit day's total: its stored amount, 0 when none was logged. */
export function habitDayAmount(task: Readonly<Pick<Partial<Task>, "amount">> | undefined): number {
  const amount = task?.amount;
  return typeof amount === "number" && Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** A total as Hunt stores it: at least 0, at most MAX_COUNT_AMOUNT, to 2 decimals. */
export function cleanCountAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(Math.min(amount, MAX_COUNT_AMOUNT) * 100) / 100;
}

/** A total or target as Hunt shows it: "3", "2.5". */
export function formatCountAmount(amount: number): string {
  return String(cleanCountAmount(amount));
}

/** A Count Habit day's progress as its row shows it: "2 / 3 miles", or "5 / 3" with no unit. */
export function countProgressLabel(
  habit: Readonly<Pick<Partial<Habit>, "target" | "unit">>,
  amount: number
): string {
  const unit = typeof habit.unit === "string" ? habit.unit.trim() : "";
  const label = `${formatCountAmount(amount)} / ${formatCountAmount(countTargetOf(habit))}`;
  return unit ? `${label} ${unit}` : label;
}

/**
 * An amount typed by the user ("2.5", "2,5", " 3 "), or null when it is not a
 * number of at least 0. Used for exact entry and for a new Count target.
 */
export function parseCountAmount(text: string): number | null {
  const trimmed = String(text ?? "").trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? cleanCountAmount(value) : null;
}

/** A usable Count target: a positive number Hunt can store. */
export function isCountTarget(value: unknown): value is number {
  return isCountAmount(value) && value > 0 && value <= MAX_COUNT_AMOUNT;
}
