/**
 * The sync scheduler: WHEN this device syncs. It owns the timing policy and
 * nothing else; one pass (what a sync does) is injected as `runOnce`.
 *
 * - syncNow(): single-flight. A call while a pass is in flight schedules ONE
 *   coalesced rerun; a pass that wrote local rows (wroteLocal) also reruns, at
 *   most `maxCoalescedReruns` times before handing over to request().
 * - request(): trailing debounce for local edits. It also lifts an auto-sync
 *   pause (the edit may be what a deterministic failure was waiting for).
 * - autoSync(): the periodic background sync. It resolves false without a pass
 *   while backing off after transient failures (min(max, base · 2^(n-1)) with
 *   50–100 % jitter) or paused after a deterministic one (until request() or a
 *   successful sync).
 *
 * The clock, jitter and timers are injected so the policy is testable without
 * global stubs.
 */

export interface SyncPassResult<E extends string> {
  error: E | null;
  wroteLocal: boolean;
}

export interface SyncSchedulerOptions<E extends string> {
  /** One sync pass. Should not reject; a rejection counts as `loopErrorCode`. */
  runOnce: () => Promise<SyncPassResult<E>>;
  /** Whether a failure is worth retrying on its own (backoff) or pauses auto-sync. */
  isTransient: (error: E) => boolean;
  /** Error code recorded when runOnce rejects. */
  loopErrorCode: E;
  onLoopError?: (err: unknown) => void;
  /**
   * Called for the follow-up sync after a pass (coalesced rerun past the cap,
   * or one attempt for an edit that joined a failed pass). Defaults to request().
   */
  requestFollowUp?: () => void;
  /** What the debounce timer runs. Defaults to syncNow(). */
  syncFromDebounce?: () => Promise<boolean>;
  debounceMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxCoalescedReruns?: number;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface SyncScheduler {
  syncNow: () => Promise<boolean>;
  autoSync: () => Promise<boolean>;
  request: () => void;
  /** Cancels a pending debounced sync and resets backoff (a pass in flight finishes). */
  dispose: () => void;
}

export const DEFAULT_SYNC_DEBOUNCE_MS = 300;
export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_MAX_COALESCED_RERUNS = 3;

export function createSyncScheduler<E extends string>(
  options: SyncSchedulerOptions<E>
): SyncScheduler {
  const {
    runOnce,
    isTransient,
    loopErrorCode,
    onLoopError,
    debounceMs = DEFAULT_SYNC_DEBOUNCE_MS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    maxCoalescedReruns = DEFAULT_MAX_COALESCED_RERUNS,
    now = () => Date.now(),
    random = () => Math.random(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options;

  let inFlight: Promise<boolean> | null = null;
  let again = false;
  let debounceTimer: unknown = null;
  let consecutiveFailures = 0;
  /** autoSync() sends nothing before this time (Infinity: until request() or a success). */
  let pausedUntil = 0;
  /** A debounced edit sync joined a pass already in flight (its coalesced rerun). */
  let editJoinedInFlight = false;

  const cancelDebounce = () => {
    if (debounceTimer !== null) {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }
  };

  const recordOutcome = (failure: E | null) => {
    if (failure === null) {
      consecutiveFailures = 0;
      pausedUntil = 0;
      return;
    }
    consecutiveFailures += 1;
    if (!isTransient(failure)) {
      pausedUntil = Infinity;
      return;
    }
    const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** (consecutiveFailures - 1));
    pausedUntil = now() + backoff * (0.5 + random() / 2);
  };

  const scheduler: SyncScheduler = {
    syncNow() {
      if (inFlight) {
        // Coalesce: the running pass does exactly one more pass afterwards.
        again = true;
        return inFlight;
      }
      cancelDebounce();
      inFlight = (async () => {
        let failure: E | null = null;
        try {
          let passes = 0;
          do {
            again = false;
            passes += 1;
            const result = await runOnce();
            failure = result.error;
            if (failure) {
              // A rerun would fail the same way; autoSync() retries with backoff.
              again = false;
              break;
            }
            if (result.wroteLocal) again = true;
          } while (again && passes <= maxCoalescedReruns);
        } catch (err) {
          onLoopError?.(err);
          failure = loopErrorCode;
        } finally {
          inFlight = null;
        }
        recordOutcome(failure);
        // A failed pass drops the coalesced rerun; an edit that joined it still
        // gets one attempt of its own (it may fix what failed).
        const retryForEdit = failure !== null && editJoinedInFlight;
        editJoinedInFlight = false;
        if (again || retryForEdit) {
          again = false;
          (options.requestFollowUp ?? scheduler.request)();
        }
        return failure === null;
      })();
      return inFlight;
    },

    autoSync() {
      return now() < pausedUntil ? Promise.resolve(false) : scheduler.syncNow();
    },

    request() {
      pausedUntil = 0;
      cancelDebounce();
      debounceTimer = setTimer(() => {
        debounceTimer = null;
        if (inFlight) editJoinedInFlight = true;
        (options.syncFromDebounce ?? scheduler.syncNow)().catch(() => undefined);
      }, debounceMs);
    },

    dispose() {
      cancelDebounce();
      again = false;
      consecutiveFailures = 0;
      pausedUntil = 0;
      editJoinedInFlight = false;
    },
  };
  return scheduler;
}
