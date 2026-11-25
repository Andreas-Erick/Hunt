/**
 * Value checks and coercions the sync sanitizers (syncTypes.ts) build rows
 * with. Pure, so the phone's bundled core runs the same ones.
 */
import { clampLength } from "./textLimits";

export type UnknownRecord = Record<string, unknown>;

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own-key lookup, so "constructor" or "__proto__" never match a table entry. */
export function isTableKey<K extends string>(table: Record<K, true>, value: unknown): value is K {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value);
}

/** A millisecond timestamp: a finite number in [0, MAX_SAFE_INTEGER]. */
export function isStamp(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY_RE.test(value);
}

export function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Cuts `text` to at most `max` UTF-16 units without splitting a surrogate pair (textLimits). */
export const clampText = clampLength;
