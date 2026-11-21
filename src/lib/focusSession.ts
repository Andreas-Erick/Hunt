import { toFocusSession, type ActiveFocusState, type FocusSession, type TimeLog } from "./domainTypes";
import { losingSessionEndAt } from "./syncTypes";

/**
 * A local write a focus transition needs. The caller applies them in order
 * (through the Local Store); the transition itself is pure.
 */
export type FocusEffect =
  /** Log the running burst (idempotent, R3). `endAt` defaults to now (R4 passes an earlier end). */
  | { readonly kind: "flush"; readonly taskId: string; readonly sessionStartedAt: number; readonly endAt?: number }
  /** Give an 'active' task back to the queue (no write when it is not active). */
  | { readonly kind: "requeueIfActive"; readonly taskId: string }
  /** Put the task back in the queue whatever its status. */
  | { readonly kind: "markQueued"; readonly taskId: string }
  /** Mark the task as the one being worked on. */
  | { readonly kind: "markActive"; readonly taskId: string };

export interface FocusTransition {
  readonly session: FocusSession;
  readonly effects: readonly FocusEffect[];
}

export type FocusEvent =
  /** Focus `taskId`, starting a new running burst now. */
  | { readonly type: "start"; readonly taskId: string }
  /** End the current session's claim on its task (flush + requeue) and go idle. */
  | { readonly type: "leave" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  /** Return the task to the queue (flush + queued) and go idle. */
  | { readonly type: "stop" }
  /** Go idle with no writes (the task was completed or deleted). */
  | { readonly type: "clear" }
  /** A newer focus from another device won the merge (R4 for our losing burst). */
  | {
      readonly type: "remote";
      readonly remote: ActiveFocusState;
      readonly timeLogs: readonly TimeLog[];
    };

/** R6 for the focus state: a local focus change is always newer than the focus it replaces. */
export function nextFocusStamp(session: Pick<FocusSession, "updatedAt">, now: number): number {
  return Math.max(now, (session.updatedAt || 0) + 1);
}

function flushIfRunning(session: FocusSession, endAt?: number): FocusEffect[] {
  if (session.status !== "running") return [];
  return [
    endAt === undefined
      ? { kind: "flush", taskId: session.taskId, sessionStartedAt: session.sessionStartedAt }
      : { kind: "flush", taskId: session.taskId, sessionStartedAt: session.sessionStartedAt, endAt },
  ];
}

const UNCHANGED = (session: FocusSession): FocusTransition => ({ session, effects: [] });

/**
 * The SHARED focus state machine: the next session and the local writes it
 * needs, for one event at time `now`. Pure. An event that does not apply to
 * the current state (pause while idle, resume while running, ...) returns the
 * same session object with no effects.
 */
export function transitionFocus(
  session: FocusSession,
  event: FocusEvent,
  now: number
): FocusTransition {
  const stamp = () => nextFocusStamp(session, now);
  switch (event.type) {
    case "start": {
      // Already running on this task: keep the session (restarting it would
      // silently drop the time since sessionStartedAt).
      if (session.status === "running" && session.taskId === event.taskId) {
        return UNCHANGED(session);
      }
      const leaving: FocusEffect[] =
        session.status !== "idle" && session.taskId !== event.taskId
          ? [...flushIfRunning(session), { kind: "requeueIfActive", taskId: session.taskId }]
          : [];
      return {
        session: { status: "running", taskId: event.taskId, sessionStartedAt: now, updatedAt: stamp() },
        effects: [...leaving, { kind: "markActive", taskId: event.taskId }],
      };
    }
    case "leave":
      if (session.status === "idle") return UNCHANGED(session);
      return {
        session: { status: "idle", updatedAt: stamp() },
        effects: [...flushIfRunning(session), { kind: "requeueIfActive", taskId: session.taskId }],
      };
    case "pause":
      if (session.status !== "running") return UNCHANGED(session);
      return {
        session: { status: "paused", taskId: session.taskId, updatedAt: stamp() },
        effects: flushIfRunning(session),
      };
    case "resume":
      if (session.status !== "paused") return UNCHANGED(session);
      return {
        session: { status: "running", taskId: session.taskId, sessionStartedAt: now, updatedAt: stamp() },
        effects: [],
      };
    case "stop":
      return {
        session: { status: "idle", updatedAt: stamp() },
        effects:
          session.status === "idle"
            ? []
            : [...flushIfRunning(session), { kind: "markQueued", taskId: session.taskId }],
      };
    case "clear":
      return { session: { status: "idle", updatedAt: stamp() }, effects: [] };
    case "remote": {
      const { remote, timeLogs } = event;
      if ((remote.updatedAt || 0) <= (session.updatedAt || 0)) return UNCHANGED(session);
      const remoteSession = toFocusSession(remote);
      const sameSession =
        session.status !== "idle" &&
        remote.activeTaskId === session.taskId &&
        remote.sessionStartedAt === (session.status === "running" ? session.sessionStartedAt : null);
      if (sameSession || session.status === "idle") {
        return { session: remoteSession, effects: [] };
      }
      // A newer focus from a DIFFERENT session replaces ours: log our own
      // running burst, ending when the other device moved on rather than now
      // (R4: we may learn about it hours late), and give our task back.
      const endAt =
        session.status === "running"
          ? losingSessionEndAt(session.taskId, session.sessionStartedAt, remote, timeLogs, now)
          : undefined;
      const effects: FocusEffect[] = [...flushIfRunning(session, endAt)];
      if (remote.activeTaskId !== session.taskId) {
        effects.push({ kind: "requeueIfActive", taskId: session.taskId });
      }
      return { session: remoteSession, effects };
    }
  }
}
