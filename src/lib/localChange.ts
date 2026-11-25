/**
 * The Local Store's local-change signal: every operation that wrote anything
 * emits it once, and the sync scheduler turns it into a debounced sync.
 */

/** Options for operations that the sync path also runs. */
export interface LocalWriteOptions {
  /**
   * Emit the local-change signal (default true). The sync path passes false:
   * its own rerun pushes what it wrote, so a debounced extra sync is not needed.
   */
  notify?: boolean;
}

type LocalChangeListener = () => void;
const listeners = new Set<LocalChangeListener>();

/** Subscribes to local writes; returns the unsubscribe function. */
export function onLocalChange(listener: LocalChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitChange(options?: LocalWriteOptions): void {
  if (options?.notify === false) return;
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch {
      // A listener must not turn a successful write into a failed action.
    }
  }
}

/** Emits the signal when `wrote` is truthy; returns `wrote`. */
export function changed<T>(wrote: T, options?: LocalWriteOptions): T {
  if (wrote) emitChange(options);
  return wrote;
}
