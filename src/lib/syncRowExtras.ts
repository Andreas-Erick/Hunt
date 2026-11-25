import { clampLength } from "./textLimits";

/**
 * Sync validation of the fields a row's validator does not know (fields a
 * newer device added): kept when scalar, so an older server never strips
 * them. A module of its own so row validators outside syncTypes.ts (lists.ts)
 * share it without importing the whole sync module.
 */

const MAX_EXTRA_TEXT_LENGTH = 10_000; // string values of fields not listed by the row
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Copies the fields `known` does not list (e.g. a log's questCodeSnapshot, a
 * quest's code/archived) when the value is a scalar: a string (cut to 10,000),
 * a finite number, a boolean or null. Objects and arrays are dropped, which
 * also bounds nesting for canonicalString; __proto__/constructor/prototype are
 * never copied.
 */
export function copyScalarExtras(
  target: object,
  raw: Record<string, unknown>,
  known: ReadonlySet<string>
): void {
  const extras: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (known.has(key) || FORBIDDEN_KEYS.has(key)) continue;
    const value = raw[key];
    if (typeof value === "string") {
      extras[key] = clampLength(value, MAX_EXTRA_TEXT_LENGTH);
    } else if (
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      extras[key] = value;
    }
  }
  Object.assign(target, extras);
}
