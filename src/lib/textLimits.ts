/** Text cuts that match the sync validator's, so a device never writes text the server would shorten. */

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair (not trimmed). */
export function clampLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/**
 * Trimmed `title` cut to at most `max` UTF-16 units without splitting a
 * surrogate pair (the same cut the sync validator applies), so the server
 * never has to change a title saved here.
 */
export function clampTitle(title: string, max: number): string {
  return clampLength(title.trim(), max);
}
