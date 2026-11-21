"use client";

import React, { useEffect, useState } from "react";
import { MotionConfig } from "framer-motion";
import { db } from "@/lib/db";
import {
  installGlobalFaultTraps,
  logDiagnostic,
  recordBreadcrumb,
  summarizeError,
} from "@/lib/diagnostics";
import { bootOnce } from "@/lib/bootSequence";
import { hudAudio } from "@/lib/hudAudio";
import {
  disposeCommandStoreScheduler,
  useCommandStore,
} from "@/store/useCommandStore";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { GuideView } from "@/components/GuideView";
import { RegionErrorBoundary } from "@/components/RegionErrorBoundary";

const AUTO_SYNC_INTERVAL_MS = 5000;
/** visibilitychange + focus usually fire together; one sync covers both. */
const RESUME_SYNC_MIN_GAP_MS = 1000;

type BootPhase = "booting" | "ready" | "db_error";

const NOTICE_BUTTON_CLASS =
  "shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/[0.08] hover:text-white active:opacity-80";

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
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-2.5 text-xs text-hud-amber sm:px-6 lg:px-12 xl:px-16">
          <span className="min-w-0 break-words">{message}</span>
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
  const [bootPhase, setBootPhase] = useState<BootPhase>("booting");
  const booted = bootPhase !== "booting";
  const dbError = bootPhase === "db_error";

  useEffect(() => {
    const disposeFaultTraps = installGlobalFaultTraps();
    let alive = true;
    void bootOnce().then(() => {
      if (!alive) return;
      // The seed step has run: a database that could not be opened shows up here.
      setBootPhase(db.hasFailed() ? "db_error" : "ready");
    });
    return () => {
      alive = false;
      disposeFaultTraps();
      disposeCommandStoreScheduler();
      void hudAudio.dispose();
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

  // Background auto-sync between PC and Phone/Tablet (via the local server). Paused
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

  // Pure CSS `.hunt-view-enter` wrappers guarantee resting DOM opacity is ALWAYS 1
  // (eliminating the Framer Motion inline `style="opacity: 0"` rAF stall on fullscreen launch).
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen min-h-[100dvh] bg-[#0b0c0e] text-neutral-100">
        <TopTelemetryBar />

        {(dbError || actionError) && (
          // Pinned under the header (to the top in Focus, which hides the header).
          <div
            className={`sticky z-20 ${
              activeView === "focus"
                ? "top-0"
                : "sticky-page-notice top-16 sm:top-20"
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
          {activeView === "command" && (
            <div key="view-command" className="hunt-view-enter">
              <RegionErrorBoundary region="Home">
                <CommandCenterView />
              </RegionErrorBoundary>
            </div>
          )}

          {activeView === "plan" && (
            <div key="view-plan" className="hunt-view-enter">
              <RegionErrorBoundary region="Plan">
                <PlanWeekView />
              </RegionErrorBoundary>
            </div>
          )}

          {activeView === "focus" && (
            <div key="view-focus" className="hunt-view-enter">
              <RegionErrorBoundary region="Focus">
                <FocusHudView />
              </RegionErrorBoundary>
            </div>
          )}

          {activeView === "quests" && (
            <div key="view-quests" className="hunt-view-enter">
              <RegionErrorBoundary region="Quests">
                <QuestMatrixPanel />
              </RegionErrorBoundary>
            </div>
          )}

          {activeView === "habits" && (
            <div key="view-habits" className="hunt-view-enter">
              <RegionErrorBoundary region="Habits">
                <HabitsView />
              </RegionErrorBoundary>
            </div>
          )}

          {(activeView === "telemetry" || activeView === "log") && (
            <div key="view-telemetry" className="hunt-view-enter">
              <RegionErrorBoundary region="Review">
                <TelemetryDashboardView />
              </RegionErrorBoundary>
            </div>
          )}

          {activeView === "guide" && (
            <div key="view-guide" className="hunt-view-enter">
              <RegionErrorBoundary region="Guide">
                <GuideView />
              </RegionErrorBoundary>
            </div>
          )}
        </main>
      </div>
    </MotionConfig>
  );
}
