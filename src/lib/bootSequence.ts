import { seedInitialDataIfNeeded } from "@/lib/db";
import {
  logDiagnostic,
  recordBreadcrumb,
  summarizeError,
} from "@/lib/diagnostics";
import { restoreMirroredNoteDrafts } from "@/lib/noteDraftStore";
import { currentPlatform } from "@/lib/platform";
import { getClientSyncToken } from "@/lib/syncToken";
import { useCommandStore } from "@/store/useCommandStore";

/** Upper bound on initial boot checks so a stalled IDB lock never hangs on "Loading Hunt...". */
export const BOOT_SAFETY_TIMEOUT_MS = 4000;

// Boot runs once per page load (React StrictMode double-invokes effects in dev).
let bootPromise: Promise<void> | null = null;
let bootGeneration = 0;

/** Resets cached boot promise in unit tests simulating multiple page boots. */
export function resetBootOnceForTests(): void {
  bootGeneration += 1;
  bootPromise = null;
}

export function bootOnce(): Promise<void> {
  if (!bootPromise) {
    const generation = ++bootGeneration;
    // A launcher `?token=` key goes into storage (and out of the address bar)
    // before the seed check below reads it.
    getClientSyncToken();
    // Notes typed just before a reload (inside the save debounce) come back
    // first, so the first sync already carries them.
    const sequence = restoreMirroredNoteDrafts()
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "notes_draft_restore_failed",
          context: summarizeError(err),
        })
      )
      .then(() => {
        if (generation !== bootGeneration) return;
        // db.ts stays Dexie-only; the sync-side "data exists" check is injected here.
        return seedInitialDataIfNeeded(
          currentPlatform.sync?.dataExistsElsewhere ?? (async () => false)
        );
      })
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "idb_init_failed",
          context: summarizeError(err),
        })
      )
      .then(() => {
        if (generation !== bootGeneration) return;
        return useCommandStore.getState().materializeDailyHabits();
      })
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "daily_habits_materialize_failed",
          context: summarizeError(err),
        })
      )
      .then(() => {
        if (generation !== bootGeneration) return;
        recordBreadcrumb({ level: "INFO", domain: "boot", event: "boot_ready" });
        // First sync runs in the background: the UI renders from IndexedDB now.
        void useCommandStore.getState().syncNow();
      });

    let safetyTimer: ReturnType<typeof setTimeout> | null = null;
    const timeoutGuard = new Promise<void>((resolve) => {
      safetyTimer = setTimeout(() => {
        safetyTimer = null;
        if (generation === bootGeneration) {
          logDiagnostic({
            level: "WARN",
            domain: "boot",
            event: "boot_safety_timeout_elapsed",
            context: { timeoutMs: BOOT_SAFETY_TIMEOUT_MS },
          });
        }
        resolve();
      }, BOOT_SAFETY_TIMEOUT_MS);
    });

    bootPromise = Promise.race([sequence, timeoutGuard]).finally(() => {
      if (safetyTimer !== null) clearTimeout(safetyTimer);
    });
  }
  return bootPromise;
}
