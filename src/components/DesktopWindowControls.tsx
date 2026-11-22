"use client";

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { hudAudio } from "@/lib/hudAudio";
import {
  closeDesktopWindow,
  isDesktopWindowFullscreen,
  minimizeDesktopWindow,
  toggleDesktopFullscreen,
} from "@/lib/desktopWindow";
import { getClientSyncToken } from "@/lib/syncToken";
import { useCommandStore } from "@/store/useCommandStore";

interface DesktopWindowControlsProps {
  className?: string;
}

function subscribeToSyncKey(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

const hasSyncKey = (): boolean => Boolean(getClientSyncToken());
const noSyncKeyOnServer = (): boolean => false;

/**
 * True inside the desktop launcher, which hands this page the pairing key that
 * /api/window requires. A plain browser (e.g. a tablet on the LAN URL) has no
 * key, and Minimize/Exit could not work there. The server snapshot is false, so
 * hydration matches the server markup and the controls appear right after.
 */
export function useIsDesktopLauncher(): boolean {
  return useSyncExternalStore(subscribeToSyncKey, hasSyncKey, noSyncKeyOnServer);
}

/**
 * Native-style desktop window controls (Minimize, Restore/Fullscreen, Exit)
 * so Hunt remains effortless to minimize, un-fullscreen, or close even when
 * running in borderless fullscreen mode with the Windows titlebar/taskbar hidden.
 */
export function DesktopWindowControls({
  className = "",
}: DesktopWindowControlsProps) {
  const isDesktop = useIsDesktopLauncher();
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    const syncFs = () => setIsFullscreen(isDesktopWindowFullscreen());
    syncFs();
    document.addEventListener("fullscreenchange", syncFs);
    window.addEventListener("resize", syncFs);
    return () => {
      document.removeEventListener("fullscreenchange", syncFs);
      window.removeEventListener("resize", syncFs);
    };
  }, []);

  const handleMinimize = () => {
    hudAudio.playClick();
    void minimizeDesktopWindow();
  };

  const handleToggleFullscreen = () => {
    hudAudio.playClick();
    void toggleDesktopFullscreen(isFullscreen);
  };

  const handleClose = () => {
    hudAudio.playClick();
    void closeDesktopWindow(() => useCommandStore.getState().syncNow());
  };

  if (!isDesktop) return null;

  return (
    <div
      role="group"
      aria-label="Window controls"
      className={`hidden sm:inline-flex items-center gap-2 ${className}`.trim()}
    >
      <button
        type="button"
        data-testid="window-minimize-btn"
        onClick={handleMinimize}
        title="Minimize window"
        aria-label="Minimize window"
        className="inline-flex items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-neutral-400 hover:border-white/15 hover:bg-white/[0.06] hover:text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
      >
        <Minus className="h-4 w-4" />
      </button>

      <button
        type="button"
        data-testid="window-fullscreen-btn"
        onClick={handleToggleFullscreen}
        title={
          isFullscreen
            ? "Exit fullscreen (show Windows taskbar)"
            : "Enter fullscreen (hide Windows taskbar)"
        }
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        aria-pressed={isFullscreen}
        className="inline-flex items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-neutral-400 hover:border-white/15 hover:bg-white/[0.06] hover:text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
      >
        {isFullscreen ? (
          <Minimize2 className="h-4 w-4" />
        ) : (
          <Maximize2 className="h-4 w-4" />
        )}
      </button>

      <button
        type="button"
        data-testid="window-close-btn"
        onClick={handleClose}
        title="Exit Hunt"
        aria-label="Exit Hunt"
        className="ml-1 inline-flex items-center justify-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-2 sm:p-2.5 text-neutral-400 hover:border-danger/40 hover:bg-danger/15 hover:text-danger transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-[0.98]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
