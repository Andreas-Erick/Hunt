"use client";

import { useEffect, useReducer } from "react";
import { useShallow } from "zustand/react/shallow";
import { useCommandStore } from "@/store/useCommandStore";
import { describeSyncError } from "@/lib/syncEngine";

/**
 * The phone counts as connected while the sync server heard from it this
 * recently (a healthy phone syncs every ~5 s; the desktop learns about it on its
 * own 5 s sync, so a live phone is never seen as older than ~10 s).
 */
export const PHONE_LIVE_WINDOW_MS = 20_000;

/** "just now", "12 s ago", "5 m ago", "3 h ago", "2 d ago". */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export interface PhoneLinkStatus {
  /** The phone synced within PHONE_LIVE_WINDOW_MS. */
  live: boolean;
  lastSeenAt: number | null;
  /** "Phone connected" / "Phone last synced 5 m ago" / "Phone hasn't synced yet". */
  label: string;
  /** One line of supporting detail for the label. */
  detail: string;
}

export function describePhoneLink(
  lastSeenAt: number | null,
  now: number
): PhoneLinkStatus {
  if (lastSeenAt === null) {
    return {
      live: false,
      lastSeenAt,
      label: "Phone hasn't synced yet",
      detail:
        "No phone sync since the laptop server started. Open Hunt on your phone on the same Wi-Fi.",
    };
  }
  const age = Math.max(0, now - lastSeenAt);
  if (age < PHONE_LIVE_WINDOW_MS) {
    return {
      live: true,
      lastSeenAt,
      label: "Phone connected",
      detail: `Last phone sync ${formatAgo(age)}`,
    };
  }
  return {
    live: false,
    lastSeenAt,
    label: `Phone last synced ${formatAgo(age)}`,
    detail:
      "Changes from either device merge the next time the phone reaches this laptop.",
  };
}

/**
 * Phone link status from the store's `phoneLastSeenAt`.
 *
 * Re-renders exactly when the live window runs out (so the dot turns neutral
 * without polling) and, when `refreshMs` is given, periodically while the page
 * is visible so relative times stay current.
 */
export function usePhoneLink(refreshMs: number | null = null): PhoneLinkStatus {
  const lastSeenAt = useCommandStore((s) => s.phoneLastSeenAt);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (lastSeenAt === null) return;
    const remaining = lastSeenAt + PHONE_LIVE_WINDOW_MS - Date.now();
    if (remaining <= 0) return;
    const id = setTimeout(rerender, remaining + 50);
    return () => clearTimeout(id);
  }, [lastSeenAt]);

  useEffect(() => {
    if (refreshMs === null) return;
    const tick = () => {
      if (!document.hidden) rerender();
    };
    const id = setInterval(tick, refreshMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshMs]);

  return describePhoneLink(lastSeenAt, Date.now());
}

export type ServerLinkState = "ok" | "error" | "connecting";

export interface ServerLinkStatus {
  state: ServerLinkState;
  label: string;
}

export function describeServerLink(
  isSyncOnline: boolean,
  syncError: string | null
): ServerLinkStatus {
  if (syncError) return { state: "error", label: describeSyncError(syncError) };
  if (isSyncOnline) return { state: "ok", label: "Local sync server running" };
  return { state: "connecting", label: "Connecting to the local sync server…" };
}

/** Status of THIS browser's link to the local /api/sync server (not the phone). */
export function useServerLink(): ServerLinkStatus {
  const { isSyncOnline, syncError } = useCommandStore(
    useShallow((s) => ({ isSyncOnline: s.isSyncOnline, syncError: s.syncError }))
  );
  return describeServerLink(isSyncOnline, syncError);
}
