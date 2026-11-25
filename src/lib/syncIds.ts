/**
 * Id rules of synced rows (re-exported by syncTypes.ts). A module of its own
 * so row helpers such as checklist.ts can check ids without importing the
 * whole sync module (which imports them back).
 */

/** Longest quest/task id, quest/task tombstone, questId or log taskId accepted. */
export const MAX_ENTITY_ID_LENGTH = 128;
/** Longest time-log id or log tombstone accepted (`log-<sessionStartedAt>-<taskId>`). */
export const MAX_LOG_ID_LENGTH = 160;
/** Characters of every generated id (`tsk-<ms>-<4>`, `quest-<ms>-<4>`, `log-<ms>-<taskId>`, seeds). */
export const SAFE_ID_CHARS_RE = /^[A-Za-z0-9_.:-]+$/;
/** A safe quest/task id: same as `isSafeSyncId(value, MAX_ENTITY_ID_LENGTH)`. */
export const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** True for a non-empty id of SAFE_ID_CHARS_RE characters, at most `maxLength` long. */
export function isSafeSyncId(
  value: unknown,
  maxLength: number = MAX_ENTITY_ID_LENGTH
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_ID_CHARS_RE.test(value)
  );
}

/** A synced row's link to another entity (a Quest, a Task): its id when safe, else null. */
export function entityIdOrNull(value: unknown): string | null {
  return isSafeSyncId(value) ? value : null;
}
