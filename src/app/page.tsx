"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { db, seedInitialDataIfNeeded } from "@/lib/db";
import {
  installGlobalFaultTraps,
  logDiagnostic,
  recordBreadcrumb,
  summarizeError,
} from "@/lib/diagnostics";
import { getClientSyncToken } from "@/lib/syncEngine";
import { useCommandStore } from "@/store/useCommandStore";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { GuideView } from "@/components/GuideView";
import { restoreMirroredNoteDrafts } from "@/components/TaskNotesField";
import { RegionErrorBoundary } from "@/components/RegionErrorBoundary";

const AUTO_SYNC_INTERVAL_MS = 5000;
/** visibilitychange + focus usually fire together; one sync covers both. */
const RESUME_SYNC_MIN_GAP_MS = 1000;

const NOTICE_BUTTON_CLASS =
  "shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/[0.08] hover:text-white active:opacity-80";

// Boot runs once per page load (React StrictMode double-invokes effects in dev).
let bootPromise: Promise<void> | null = null;
function bootOnce(): Promise<void> {
  if (!bootPromise) {
    // A launcher `?token=` key goes into storage (and out of the address bar)
    // before the seed check below reads it.
    getClientSyncToken();
    // Notes typed just before a reload (inside the save debounce) come back
    // first, so the first sync already carries them.
    bootPromise = restoreMirroredNoteDrafts()
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "notes_draft_restore_failed",
          context: summarizeError(err),
        })
      )
      .then(() => seedInitialDataIfNeeded())
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "idb_init_failed",
          context: summarizeError(err),
        })
      )
      .then(() => useCommandStore.getState().materializeDailyHabits())
      .catch((err) =>
        logDiagnostic({
          level: "ERROR",
          domain: "boot",
          event: "daily_habits_materialize_failed",
          context: summarizeError(err),
        })
      )
      .then(() => {
        recordBreadcrumb({ level: "INFO", domain: "boot", event: "boot_ready" });
        // First sync runs in the background: the UI renders from IndexedDB now.
        void useCommandStore.getState().syncNow();
      });
  }
  return bootPromise;
}

/** A failed local action (store actionError) or an unopenable database, shown in every view. */
function PageNotice({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div role="alert" className="border-b border-hud-amber/20 bg-[#0b0c0e]">
      <div className="bg-hud-amber/[0.06]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-2.5 text-xs text-hud-amber sm:px-10 lg:px-16">
          <span className="min-w-0">{message}</span>
          <button type="button" onClick={onAction} className={NOTICE_BUTTON_CLASS}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const activeView = useCommandStore((s) => s.activeView);
  const syncNow = useCommandStore((s) => s.syncNow);
  const actionError = useCommandStore((s) => s.actionError);
  const clearActionError = useCommandStore((s) => s.clearActionError);
  const [booted, setBooted] = useState(false);
  const [dbError, setDbError] = useState(false);

  useEffect(() => {
    const disposeFaultTraps = installGlobalFaultTraps();
    let alive = true;
    void bootOnce().then(() => {
      if (!alive) return;
      // The seed step has run: a database that could not be opened shows up here.
      setDbError(db.hasFailed());
      setBooted(true);
    });
    return () => {
      alive = false;
      disposeFaultTraps();
    };
  }, []);

  useEffect(() => {
    if (!booted) return;
    recordBreadcrumb({
      level: "DEBUG",
      domain: "navigation",
      event: "view_changed",
      context: { view: activeView },
    });
  }, [booted, activeView]);

  // Background auto-sync between PC and Phone (via the local server). Paused
  // while the window is hidden; catches up as soon as it becomes visible. The
  // interval uses autoSync (backs off after failures); a resume syncs now.
  useEffect(() => {
    if (!booted) return;
    let lastResumeSync = 0;
    const isVisible = () => !document.hidden;
    const syncOnResume = () => {
      if (!isVisible()) return;
      const now = Date.now();
      if (now - lastResumeSync < RESUME_SYNC_MIN_GAP_MS) return;
      lastResumeSync = now;
      void syncNow();
    };

    const id = setInterval(() => {
      if (isVisible()) void useCommandStore.getState().autoSync();
    }, AUTO_SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", syncOnResume);
    window.addEventListener("focus", syncOnResume);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", syncOnResume);
      window.removeEventListener("focus", syncOnResume);
    };
  }, [booted, syncNow]);

  if (!booted) {
    return (
      <div className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-[#0b0c0e] text-xs text-hud-muted">
        Loading Hunt...
      </div>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen min-h-[100dvh] bg-[#0b0c0e] text-neutral-100">
      <TopTelemetryBar />

      {(dbError || actionError) && (
        // Pinned under the header (to the top in Focus, which hides the header).
        <div
          className={`sticky z-20 ${
            activeView === "focus" ? "top-0" : "top-16 sm:top-20"
          }`}
        >
          {dbError && (
            <PageNotice
              message="Couldn't open your local Hunt data in this browser. Nothing was deleted."
              actionLabel="Retry"
              onAction={() => window.location.reload()}
            />
          )}
          {actionError && (
            <PageNotice
              message={actionError}
              actionLabel="Dismiss"
              onAction={clearActionError}
            />
          )}
        </div>
      )}

      <main>
        <AnimatePresence mode="wait">
          {activeView === "command" && (
            <motion.div
              key="view-command"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Home">
                <CommandCenterView />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {activeView === "plan" && (
            <motion.div
              key="view-plan"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Plan">
                <PlanWeekView />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {activeView === "focus" && (
            <motion.div
              key="view-focus"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
            >
              <RegionErrorBoundary region="Focus">
                <FocusHudView />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {activeView === "quests" && (
            <motion.div
              key="view-quests"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Quests">
                <QuestMatrixPanel />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {activeView === "habits" && (
            <motion.div
              key="view-habits"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Habits">
                <HabitsView />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {(activeView === "telemetry" || activeView === "log") && (
            <motion.div
              key="view-telemetry"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Review">
                <TelemetryDashboardView />
              </RegionErrorBoundary>
            </motion.div>
          )}

          {activeView === "guide" && (
            <motion.div
              key="view-guide"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <RegionErrorBoundary region="Guide">
                <GuideView />
              </RegionErrorBoundary>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
    </MotionConfig>
  );
}
