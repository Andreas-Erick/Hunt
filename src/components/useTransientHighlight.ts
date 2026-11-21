"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Holds one id highlighted for `durationMs` after `flash(id)`. A new flash
 * replaces the previous one and restarts the timer; the highlight clears only
 * if it still belongs to the id that started that timer. The pending timer is
 * cleared on unmount.
 */
export function useTransientHighlight(
  durationMs: number
): readonly [highlightedId: string | null, flash: (id: string) => void] {
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const flash = useCallback(
    (id: string) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setHighlightedId(id);
      timerRef.current = setTimeout(() => {
        setHighlightedId((cur) => (cur === id ? null : cur));
        timerRef.current = null;
      }, durationMs);
    },
    [durationMs]
  );

  return [highlightedId, flash] as const;
}
