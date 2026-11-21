"use client";

import { useEffect, useState } from "react";
import { msUntilNextLocalMidnight, toLocalDateKey } from "@/lib/dateUtils";

const MAX_ROLLOVER_CHECK_MS = 60_000;

/**
 * Reactive local YYYY-MM-DD key that stays current when a view remains open
 * across midnight or wakes from sleep, while causing zero re-renders within
 * the same calendar day.
 */
export function useTodayDateKey(): string {
  const [todayKey, setTodayKey] = useState<string>(() => toLocalDateKey());

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      if (!alive) return;
      setTodayKey((prev) => {
        const next = toLocalDateKey();
        return next === prev ? prev : next;
      });
    };

    const scheduleNext = () => {
      if (!alive) return;
      if (timer !== null) clearTimeout(timer);
      const waitMs = Math.min(MAX_ROLLOVER_CHECK_MS, msUntilNextLocalMidnight());
      timer = setTimeout(() => {
        timer = null;
        refresh();
        scheduleNext();
      }, waitMs);
    };

    const onResume = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
      scheduleNext();
    };

    refresh();
    scheduleNext();
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);

    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
  }, []);

  return todayKey;
}
