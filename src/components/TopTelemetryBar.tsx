"use client";

import React, { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useShallow } from "zustand/react/shallow";
import {
  Volume2,
  VolumeX,
  Radio,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { db, formatChronoMMSS } from "@/lib/db";
import { useCommandStore, type HudView } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
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
    () => (activeTaskId ? db.tasks.get(activeTaskId) : undefined),
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
      onClick={() => setActiveView("focus")}
      className="flex items-center gap-2 rounded-full border border-[#00ff9d]/30 bg-[#00ff9d]/10 px-3 sm:px-4 py-1.5 text-xs font-medium text-[#00ff9d] hover:bg-[#00ff9d]/20 transition-colors"
    >
      <Radio className="h-3.5 w-3.5 animate-pulse" />
      <span className="max-w-[150px] truncate hidden md:inline text-white/90">
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
      className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-neutral-300 hover:border-white/20 hover:text-white transition-colors"
    >
      <span
        className={`h-2 w-2 rounded-full transition-colors ${
          phone.live
            ? "bg-[#00ff9d] shadow-[0_0_6px_#00ff9d]"
            : "bg-neutral-500"
        }`}
      />
      <Smartphone className="h-4 w-4 text-[#00f0ff]" />
      <span className="hidden sm:inline">Phone</span>
      {server.state === "error" && (
        <TriangleAlert className="h-3.5 w-3.5 text-[#ffb800]" />
      )}
    </button>
  );
}

export function TopTelemetryBar() {
  const activeView = useCommandStore((s) => s.activeView);
  const setActiveView = useCommandStore((s) => s.setActiveView);

  const [muted, setMuted] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);

  useEffect(() => {
    setMuted(hudAudio.syncFromStorage());
  }, []);

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
      <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-[#0b0c0e]/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 sm:h-20 max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-10 lg:px-16">
          {/* Left: HUNT Logo + Clean Navigation Tabs */}
          <div className="flex min-w-0 items-center gap-4 sm:gap-10">
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

            <nav className="flex items-center gap-1 overflow-x-auto no-scrollbar">
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
                    className={`shrink-0 rounded-lg px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm transition-all ${
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

          {/* Right: Active Running Session Pill + Phone Sync Button + Sound Toggle */}
          <div className="flex shrink-0 items-center gap-2.5 sm:gap-3.5">
            <RegionErrorBoundary region="Session timer" fallback={null}>
              <ActiveSessionPill />
            </RegionErrorBoundary>

            {/* Mobile & Cross-Device Sync Button */}
            <PhoneSyncButton onOpen={() => setSyncModalOpen(true)} />

            <button
              onClick={handleToggleMute}
              title={muted ? "Unmute interface audio" : "Mute interface audio"}
              aria-label={muted ? "Unmute interface audio" : "Mute interface audio"}
              className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-neutral-400 hover:border-white/15 hover:text-white transition-colors"
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
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
