"use client";

import React, { useEffect, useState, type ComponentType } from "react";
import { MotionConfig } from "framer-motion";
import { db } from "@/lib/db";
import { installGlobalFaultTraps, recordBreadcrumb } from "@/lib/diagnostics";
import { bootOnce } from "@/lib/bootSequence";
import { startDesktopReminders } from "@/lib/desktopReminders";
import { currentPlatform } from "@/lib/platform";
import { IS_WEB_DEMO } from "@/lib/webDemo";
import {
  disposeCommandStoreScheduler,
  useCommandStore,
  type HudView,
} from "@/store/useCommandStore";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { ListsView } from "@/components/ListsView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { GuideView } from "@/components/GuideView";
import { RegionErrorBoundary } from "@/components/RegionErrorBoundary";
import { DemoBanner } from "@/components/DemoBanner";

const AUTO_SYNC_INTERVAL_MS = 5000;
/** visibilitychange + focus usually fire together; one sync covers both. */
const RESUME_SYNC_MIN_GAP_MS = 1000;

type BootPhase = "booting" | "ready" | "db_error";

interface ViewEntry {
  /** React key of the view wrapper; a change replays `.hunt-view-enter`. */
  key: string;
  /** Region name shown by the view's error boundary. */
  region: string;
  Component: ComponentType;
}

const REVIEW_VIEW: ViewEntry = {
  key: "view-telemetry",
  region: "Review",
  Component: TelemetryDashboardView,
};

/** Every HudView must map to a view: adding a member without an entry fails tsc. */
const VIEWS: Record<HudView, ViewEntry> = {
  command: { key: "view-command", region: "Home", Component: CommandCenterView },
  plan: { key: "view-plan", region: "Plan", Component: PlanWeekView },
  focus: { key: "view-focus", region: "Focus", Component: FocusHudView },
  quests: { key: "view-quests", region: "Quests", Component: QuestMatrixPanel },
  habits: { key: "view-habits", region: "Habits", Component: HabitsView },
  lists: { key: "view-lists", region: "Lists", Component: ListsView },
  telemetry: REVIEW_VIEW,
  // Legacy alias of the Review view.
  log: REVIEW_VIEW,
  guide: { key: "view-guide", region: "Guide", Component: GuideView },
};

const NOTICE_BUTTON_CLASS =
  "shrink-0 min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/[0.08] hover:text-white active:opacity-80";

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
    <div role="alert" className="border-b border-hud-amber/20 bg-base">
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

  // Task reminders as Windows notifications while this window is open (ADR-0007), with Done (or
  // +1) and Snooze buttons applied through the command store.
  useEffect(() => {
    if (!booted) return;
    const store = () => useCommandStore.getState();
    return startDesktopReminders({
      completeTask: (taskId) => store().completeTaskById(taskId),
      ensureHabitDay: (habitId, dateKey) => store().ensureHabitTaskForDay(habitId, dateKey),
      addCount: async (habitId, dateKey) => void (await store().logHabitAmount(habitId, dateKey, "+1")),
    });
  }, [booted]);

  // Background auto-sync between PC and Phone/Tablet (via the local server). Paused
  // while the window is hidden; catches up as soon as it becomes visible. The
  // interval uses autoSync (backs off after failures); a resume syncs now.
  useEffect(() => {
    // The browser demo has no sync hub to poll (ADR-0010).
    if (!booted || !currentPlatform.sync) return;
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
      <div className="flex min-h-screen min-h-[100dvh] items-center justify-center bg-base text-xs text-hud-muted">
        Loading Hunt...
      </div>
    );
  }

  const view = VIEWS[activeView];

  // Pure CSS `.hunt-view-enter` wrappers guarantee resting DOM opacity is ALWAYS 1
  // (eliminating the Framer Motion inline `style="opacity: 0"` rAF stall on fullscreen launch).
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen min-h-[100dvh] bg-base text-neutral-100">
        {/* Focus is full-height and distraction-free, so it drops the banner like the top bar. */}
        {IS_WEB_DEMO && activeView !== "focus" && <DemoBanner />}
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
          <div key={view.key} className="hunt-view-enter">
            <RegionErrorBoundary region={view.region}>
              <view.Component />
            </RegionErrorBoundary>
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}
