"use client";

import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { useShallow } from "zustand/react/shallow";
import {
  Volume2,
  VolumeX,
  Radio,
  Smartphone,
  Sunrise,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { formatChronoMMSS } from "@/lib/dateUtils";
import { APP_VERSION } from "@/lib/version";
import { useCommandStore, type HudView } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
import {
  LOOK_LABEL,
  applyLook,
  readLook,
  saveLook,
  type Look,
} from "@/lib/lookPreference";
import {
  DesktopWindowControls,
  useIsDesktopLauncher,
} from "./DesktopWindowControls";
import { HuntLogo } from "./HuntLogo";
import { MobileSyncModal } from "./MobileSyncModal";
import { RegionErrorBoundary } from "./RegionErrorBoundary";
import { usePhoneLink, useServerLink } from "./SyncStatus";

const NAV_ITEMS: Array<{ id: HudView; label: string }> = [
  { id: "command", label: "Home" },
  { id: "plan", label: "Plan" },
  { id: "focus", label: "Focus" },
  { id: "quests", label: "Quests" },
  { id: "habits", label: "Habits" },
  { id: "lists", label: "Lists" },
  { id: "telemetry", label: "Review" },
  { id: "guide", label: "Guide" },
];

/**
 * Running-session pill. Its 1 s tick (only while a timer runs) re-renders just
 * this pill, not the whole header.
 */
function ActiveSessionPill() {
  const { activeTaskId, isRunning, sessionStartedAt, setActiveView } =
    useCommandStore(
      useShallow((s) => ({
        activeTaskId: s.activeTaskId,
        isRunning: s.isRunning,
        sessionStartedAt: s.sessionStartedAt,
        setActiveView: s.setActiveView,
      }))
    );

  const activeTask = useLiveQuery(
    () => reads.task(activeTaskId),
    [activeTaskId]
  );

  const [liveSessionDelta, setLiveSessionDelta] = useState(0);

  useEffect(() => {
    if (!isRunning || !sessionStartedAt) {
      setLiveSessionDelta(0);
      return;
    }
    const updateDelta = () =>
      setLiveSessionDelta(
        Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000))
      );
    updateDelta();
    const id = setInterval(updateDelta, 1000);
    return () => clearInterval(id);
  }, [isRunning, sessionStartedAt]);

  if (!activeTask) return null;

  const activeTotalSeconds =
    (activeTask.accumulatedSeconds ?? 0) + liveSessionDelta;

  return (
    <button
      type="button"
      onClick={() => setActiveView("focus")}
      title={`Open Focus: ${activeTask.title}`}
      className="flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 sm:px-4 py-1.5 text-xs font-medium text-success hover:bg-success/20 transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
    >
      <Radio className="h-3.5 w-3.5 animate-pulse" />
      {/* Title only on wide headers, so the nav tabs keep their room at laptop widths. */}
      <span className="max-w-[150px] truncate hidden min-[1440px]:inline text-white/90">
        {activeTask.title}
      </span>
      <span className="font-mono font-semibold tabular-nums">
        {formatChronoMMSS(activeTotalSeconds).formatted}
      </span>
    </button>
  );
}

/**
 * "Phone" button. The dot is green only while the PHONE synced recently
 * (phoneLastSeenAt); the local server's own status shows as a separate warning.
 */
function PhoneSyncButton({ onOpen }: { onOpen: () => void }) {
  const phone = usePhoneLink(30_000);
  const server = useServerLink();

  const description =
    server.state === "error"
      ? `${phone.label} · ${server.label}`
      : phone.label;

  return (
    <button
      onClick={() => {
        hudAudio.playClick();
        onOpen();
      }}
      title={`${description} — open Phone & Cross-Device Sync`}
      aria-label={`Phone sync: ${description}`}
      className="flex items-center gap-2 coarse:min-h-11 coarse:min-w-11 coarse:justify-center rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-neutral-300 hover:border-white/20 hover:text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
    >
      <span
        className={`h-2 w-2 rounded-full transition-colors ${
          phone.live
            ? "bg-success shadow-dot-success"
            : "bg-neutral-500"
        }`}
      />
      <Smartphone className="h-4 w-4 text-accent" />
      <span className="hidden xl:inline">Phone</span>
      {server.state === "error" && (
        <TriangleAlert className="h-3.5 w-3.5 text-warning" />
      )}
    </button>
  );
}

/**
 * Switches this device between the Neon and Dawn looks (ADR-0005). The icon
 * and label name the look you are on; the accessible name says what a press does.
 */
function LookSwitch() {
  const [look, setLook] = useState<Look>("neon");

  useEffect(() => {
    const saved = readLook();
    // Re-applies so theme-color matches; the head script already set data-theme.
    applyLook(saved);
    setLook(saved);
  }, []);

  const next: Look = look === "neon" ? "dawn" : "neon";
  const Icon = look === "dawn" ? Sunrise : Zap;

  return (
    <button
      type="button"
      onClick={() => {
        hudAudio.playClick();
        saveLook(next);
        setLook(next);
      }}
      title={`Look: ${LOOK_LABEL[look]}. Switch to ${LOOK_LABEL[next]}`}
      aria-label={`Switch to the ${LOOK_LABEL[next]} look`}
      data-testid="look-switch"
      className="inline-flex items-center justify-center gap-2 coarse:min-h-11 coarse:min-w-11 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-xs text-neutral-300 hover:border-white/15 hover:text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
    >
      <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
      <span className="hidden xl:inline">{LOOK_LABEL[look]}</span>
    </button>
  );
}

export function TopTelemetryBar() {
  const activeView = useCommandStore((s) => s.activeView);
  const setActiveView = useCommandStore((s) => s.setActiveView);

  const [muted, setMuted] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const isDesktopLauncher = useIsDesktopLauncher();

  useEffect(() => {
    setMuted(hudAudio.syncFromStorage());
  }, []);

  // At narrow widths the nav scrolls sideways: keep the active tab in view
  // (e.g. Review or Guide on a half-screen window).
  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab) return;
    const navBox = nav.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    if (tabBox.left < navBox.left) {
      nav.scrollLeft -= navBox.left - tabBox.left;
    } else if (tabBox.right > navBox.right) {
      nav.scrollLeft += tabBox.right - navBox.right;
    }
  }, [activeView]);

  // Hide the top bar completely when inside Focus view so Focus mode is 100% distraction-free
  if (activeView === "focus") {
    return null;
  }

  const handleToggleMute = () => {
    const next = !muted;
    hudAudio.muted = next;
    setMuted(next);
    if (!next) hudAudio.playClick();
  };

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-base/90 backdrop-blur-md">
        <div className="top-telemetry-shell mx-auto flex h-16 sm:h-20 max-w-[1440px] items-center justify-between gap-2 sm:gap-3 px-3.5 sm:px-6 lg:px-12 xl:px-16">
          {/* Left: HUNT Logo + App Version + Clean Navigation Tabs */}
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-4 lg:gap-7">
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveView("command")}
                aria-label="Hunt, go to Home"
                className="group flex shrink-0 items-center gap-2.5 text-left"
              >
                <HuntLogo
                  size={36}
                  className="transition-transform duration-200 group-hover:scale-105"
                />
                <span className="hidden sm:inline text-lg font-semibold tracking-tight text-white">
                  Hunt
                </span>
              </button>
              <span
                data-testid="app-version"
                title={`Hunt v${APP_VERSION}`}
                className="hidden lg:inline-flex items-center rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 font-mono text-[10px] font-medium tabular-nums text-hud-muted select-none"
              >
                v{APP_VERSION}
              </span>
            </div>

            <nav
              ref={navRef}
              className="scroll-shadow-x -my-1 flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar px-1 py-1 [--scroll-shadow-cover:rgb(var(--c-base))] [--scroll-shadow-cover-clear:rgb(var(--c-base)_/_0)]"
            >
              {NAV_ITEMS.map((item) => {
                const isActive =
                  activeView === item.id ||
                  (item.id === "telemetry" && activeView === "log");
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => {
                      hudAudio.playClick();
                      setActiveView(item.id);
                    }}
                    className={`inline-flex min-h-[40px] coarse:min-h-11 shrink-0 items-center rounded-lg px-3 lg:px-3.5 text-xs lg:text-sm transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:opacity-80 ${
                      isActive
                        ? "bg-white/[0.09] font-medium text-white"
                        : "text-neutral-400 hover:bg-white/[0.04] hover:text-neutral-200"
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Right: Active Running Session Pill + Phone/Tablet Sync + Sound Toggle + Desktop Window Controls */}
          <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
            <RegionErrorBoundary region="Session timer" fallback={null}>
              <ActiveSessionPill />
            </RegionErrorBoundary>

            {/* Mobile & Cross-Device Sync Button */}
            <PhoneSyncButton onOpen={() => setSyncModalOpen(true)} />

            <LookSwitch />

            <button
              type="button"
              onClick={handleToggleMute}
              title={muted ? "Unmute interface audio" : "Mute interface audio"}
              aria-label={muted ? "Unmute interface audio" : "Mute interface audio"}
              className="inline-flex items-center justify-center coarse:min-h-11 coarse:min-w-11 rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-neutral-400 hover:border-white/15 hover:text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>

            {isDesktopLauncher && (
              <span
                aria-hidden="true"
                className="hidden sm:block h-5 w-px bg-white/[0.08] mx-0.5"
              />
            )}

            <DesktopWindowControls />
          </div>
        </div>
      </header>

      <RegionErrorBoundary
        region="Phone & Sync"
        onDismiss={() => setSyncModalOpen(false)}
      >
        <MobileSyncModal
          isOpen={syncModalOpen}
          onClose={() => setSyncModalOpen(false)}
        />
      </RegionErrorBoundary>
    </>
  );
}
