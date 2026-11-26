"use client";

import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { formatChronoMMSS } from "@/lib/dateUtils";
import { useCommandStore } from "@/store/useCommandStore";

/** How long the completion toast stays up before closing itself. */
export const COMPLETION_TOAST_MS = 5000;

/**
 * Home's "Completed <task> · logged" toast. It floats over the page, so it
 * never pushes the layout, and it closes itself because it can cover tasks.
 * The live region stays mounted so the message is announced when it appears.
 * z-40 sits above the sticky top bar (z-30) and under dialogs (z-50).
 */
export function CompletionToast() {
  const { lastCompletedFeedback, clearFeedback } = useCommandStore(
    useShallow((s) => ({
      lastCompletedFeedback: s.lastCompletedFeedback,
      clearFeedback: s.clearFeedback,
    }))
  );

  useEffect(() => {
    if (!lastCompletedFeedback) return;
    const timer = setTimeout(clearFeedback, COMPLETION_TOAST_MS);
    return () => clearTimeout(timer);
  }, [lastCompletedFeedback, clearFeedback]);

  return (
    <div
      data-testid="completion-toast"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-4"
    >
      <AnimatePresence initial={false}>
        {lastCompletedFeedback && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto flex w-full max-w-lg items-center justify-between gap-3 rounded-xl border border-success/30 bg-raised px-5 py-3.5 text-sm text-success shadow-2xl"
          >
            <span className="min-w-0 break-words">
              Completed{" "}
              <strong className="font-semibold text-white">
                {lastCompletedFeedback.taskTitle}
              </strong>{" "}
              · {formatChronoMMSS(lastCompletedFeedback.loggedSeconds).formatted}{" "}
              logged
            </span>
            <button
              type="button"
              onClick={clearFeedback}
              aria-label="Dismiss"
              className="-my-1.5 -mr-2 min-h-8 min-w-8 coarse:min-h-11 coarse:min-w-11 shrink-0 rounded-lg px-2.5 py-1.5 text-base leading-none text-neutral-400 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-white active:opacity-80"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
