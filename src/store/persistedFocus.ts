import { isSafeSyncId, MAX_ENTITY_ID_LENGTH } from "@/lib/syncIds";

/** The focus fields useCommandStore persists to localStorage, as rehydrated. */
interface PersistedFocusState {
  activeView: "command";
  activeTaskId: string | null;
  isRunning: boolean;
  sessionStartedAt: number | null;
  focusUpdatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A millisecond timestamp: a finite number in [0, MAX_SAFE_INTEGER]. */
function isStamp(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * Zero-trust rehydration: validates the persisted focus fields (an invalid or
 * missing one gets its default), enforces `isRunning ⇒ activeTaskId && sessionStartedAt`,
 * and always lands on the Home screen (`activeView: "command"`) when opening the app.
 * Nothing else is copied, so a corrupted or tampered entry can neither replace an
 * action nor feed NaN into a flush.
 */
function sanitizePersistedFocus(persisted: Record<string, unknown>): PersistedFocusState {
  const { activeTaskId, isRunning, sessionStartedAt, focusUpdatedAt } = persisted;
  const taskId = isSafeSyncId(activeTaskId, MAX_ENTITY_ID_LENGTH) ? activeTaskId : null;
  const startedAt = isStamp(sessionStartedAt) && sessionStartedAt > 0 ? sessionStartedAt : null;
  return {
    activeView: "command",
    activeTaskId: taskId,
    isRunning: isRunning === true && taskId !== null && startedAt !== null,
    sessionStartedAt: startedAt,
    focusUpdatedAt: isStamp(focusUpdatedAt) ? focusUpdatedAt : 0,
  };
}

/**
 * The persist middleware's hand-written merge (the default spreads every
 * stored key over the actions): only the sanitized focus fields are applied.
 */
export function mergePersistedFocus<T extends object>(persisted: unknown, current: T): T {
  return isRecord(persisted) ? { ...current, ...sanitizePersistedFocus(persisted) } : current;
}
