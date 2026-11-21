"use client";

import { getClientSyncToken } from "./syncEngine";
import type { DesktopWindowAction } from "./win32WindowCtl";

const WINDOW_CMD_TIMEOUT_MS = 3500;
const EXIT_SYNC_BUDGET_MS = 300;

/**
 * True when the browser viewport fills the physical monitor (as happens when
 * Hunt Desktop launches with `--app=... --start-fullscreen` or F11, where
 * `document.fullscreenElement` remains `null`).
 */
export function isViewportFullscreen(): boolean {
  if (typeof window === "undefined") return false;
  const scrW = window.screen?.width ?? 0;
  const scrH = window.screen?.height ?? 0;
  if (scrW <= 0 || scrH <= 0) return false;
  return (
    Math.abs(window.innerWidth - scrW) <= 6 &&
    Math.abs(window.innerHeight - scrH) <= 6
  );
}

/** True when in either DOM Fullscreen API mode or OS/Browser borderless fullscreen. */
export function isDesktopWindowFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(document.fullscreenElement) || isViewportFullscreen();
}

export async function sendDesktopWindowAction(
  action: DesktopWindowAction
): Promise<boolean> {
  if (typeof window === "undefined" || typeof fetch === "undefined") {
    return false;
  }
  const token = getClientSyncToken();
  if (!token) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WINDOW_CMD_TIMEOUT_MS);
  try {
    const res = await fetch("/api/window", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hunt-Client": "desktop",
        "X-Hunt-Token": token,
      },
      body: JSON.stringify({ action }),
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; found?: boolean };
    return Boolean(body?.ok && body?.found);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function minimizeDesktopWindow(): Promise<boolean> {
  return sendDesktopWindowAction("minimize");
}

export async function toggleDesktopFullscreen(
  currentlyFullscreen: boolean
): Promise<void> {
  if (typeof document === "undefined") return;

  if (currentlyFullscreen) {
    const hadDomFs = Boolean(document.fullscreenElement);
    if (hadDomFs) {
      try {
        await document.exitFullscreen?.();
      } catch {
        // Ignore restricted environments without Fullscreen API
      }
    }
    if (!hadDomFs || isViewportFullscreen()) {
      await sendDesktopWindowAction("exit-fullscreen");
    }
    return;
  }

  // Entering fullscreen: prefer native Win32 F11 when paired with the local
  // desktop server (no browser "Press Esc" toast, matches --start-fullscreen),
  // falling back to the standard DOM Fullscreen API.
  if (getClientSyncToken()) {
    const ok = await sendDesktopWindowAction("enter-fullscreen");
    if (ok) return;
  }
  try {
    await document.documentElement.requestFullscreen?.();
  } catch {
    // Ignore environments (e.g. restricted iframes or jsdom) without Fullscreen API
  }
}

export async function closeDesktopWindow(
  beforeCloseSync?: () => Promise<unknown>
): Promise<void> {
  if (typeof window === "undefined") return;

  if (beforeCloseSync && getClientSyncToken()) {
    try {
      await Promise.race([
        beforeCloseSync(),
        new Promise<void>((resolve) => setTimeout(resolve, EXIT_SYNC_BUDGET_MS)),
      ]);
    } catch {
      // Never block window exit on sync errors
    }
  }

  const closedByHost = await sendDesktopWindowAction("close");
  if (!closedByHost) {
    try {
      window.close();
    } catch {
      // Ignore browsers that disallow script window.close()
    }
  }
}
