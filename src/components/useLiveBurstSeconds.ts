"use client";

import { useEffect, useState } from "react";

function elapsed(startedAt: number | null): number {
  return startedAt === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

/**
 * Whole seconds since `startedAt` (0 when null), refreshed every `tickMs`
 * while a burst runs and right away when the window becomes visible again.
 */
export function useLiveBurstSeconds(startedAt: number | null, tickMs: number): number {
  const [seconds, setSeconds] = useState(() => elapsed(startedAt));
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      setSeconds(elapsed(startedAt));
    };
    tick();
    if (startedAt === null) return;
    const id = setInterval(tick, tickMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [startedAt, tickMs]);
  return seconds;
}
