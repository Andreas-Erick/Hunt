"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { recordBreadcrumb, summarizeError } from "@/lib/diagnostics";

/** How long an armed button waits for the confirming activation. */
export const CONFIRM_DELETE_DISARM_MS = 4000;

const BASE_CLASS =
  "transition-colors duration-150 ease-out active:opacity-80 focus-visible:opacity-100";
/**
 * Row-level icon delete: revealed on row hover for mice, always visible (muted)
 * on touch, with a padded 30px+ target that does not shift the row's layout.
 */
export const ROW_DELETE_CLASS =
  "-m-2 coarse:-m-3 shrink-0 rounded-md p-2 coarse:p-3 text-hud-muted opacity-0 hoverless:opacity-60 hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus-visible:opacity-100 data-[state=armed]:opacity-100 [transition-property:color,opacity,background-color]";
/** Keeps the caller's flex gap between an icon and its label inside the live span. */
const LABEL_CLASS = "flex items-center gap-[inherit]";

export interface ConfirmDeleteButtonProps {
  /**
   * Runs once per confirmed delete. Activations are ignored until it returns or
   * its promise settles; a throw or rejection is logged and the button recovers.
   */
  onConfirm: () => void | Promise<void>;
  /** Accessible name (and tooltip) while idle, e.g. "Delete task". */
  label: string;
  /** Accessible name and visible text while armed. */
  confirmLabel?: string;
  /** Idle content, e.g. a trash icon and/or "Delete". */
  children: React.ReactNode;
  /**
   * Classes for the button in both states. For state-specific button styles use
   * the `data-[state=armed]:` / `data-[state=idle]:` variants, e.g.
   * `opacity-0 hoverless:opacity-60 group-hover:opacity-100 data-[state=armed]:opacity-100`
   * (never hover-only: touch has no hover). Row icon deletes use ROW_DELETE_CLASS.
   * Keep a long `confirmLabel` out of `shrink-0` parents so it can wrap.
   */
  className?: string;
  /**
   * Classes for the visible label while armed. They sit on the inner label, so
   * they win over a text colour the button gets from `className`.
   */
  armedClassName?: string;
  /** Disarms on its own after this long without a confirming activation. */
  disarmAfterMs?: number;
}

/**
 * Two-step inline delete: the first activation arms the button ("Confirm
 * delete?"), the next separate activation calls `onConfirm`. The second click
 * of a double-click, Escape, blur and `disarmAfterMs` of inactivity all leave
 * the data untouched.
 */
export function ConfirmDeleteButton({
  onConfirm,
  label,
  confirmLabel = "Confirm delete?",
  children,
  className = "",
  armedClassName = "text-hud-crimson font-medium",
  disarmAfterMs = CONFIRM_DELETE_DISARM_MS,
}: ConfirmDeleteButtonProps) {
  const [armed, setArmed] = useState(false);
  // Refs, not state, decide what an activation does: several events can arrive
  // before React re-renders.
  const armedRef = useRef(false);
  const confirmingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const disarm = useCallback(() => {
    clearTimer();
    armedRef.current = false;
    setArmed(false);
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const arm = () => {
    clearTimer();
    armedRef.current = true;
    setArmed(true);
    const delay =
      Number.isFinite(disarmAfterMs) && disarmAfterMs > 0
        ? disarmAfterMs
        : CONFIRM_DELETE_DISARM_MS;
    timerRef.current = setTimeout(disarm, delay);
  };

  const confirm = () => {
    confirmingRef.current = true;
    disarm();
    let result: void | Promise<void>;
    try {
      result = onConfirm();
    } catch (err) {
      result = Promise.reject(err);
    }
    Promise.resolve(result)
      .catch((err: unknown) => {
        recordBreadcrumb({
          level: "ERROR",
          domain: "ui",
          event: "confirmed_delete_failed",
          context: summarizeError(err),
        });
        console.error("Confirmed delete failed:", err);
      })
      .finally(() => {
        confirmingRef.current = false;
      });
  };

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (confirmingRef.current) return;
    if (!armedRef.current) {
      arm();
      return;
    }
    // detail > 1: the second click of a double-click, not a separate decision.
    if (e.detail > 1) return;
    confirm();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // A held Enter repeats clicks; it must not arm and confirm in one press.
    if (e.key === "Enter" && e.repeat) {
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && armedRef.current) {
      e.stopPropagation();
      disarm();
    }
  };

  const handleBlur = () => {
    if (armedRef.current) disarm();
  };

  return (
    <button
      type="button"
      aria-label={armed ? confirmLabel : label}
      title={armed ? undefined : label}
      data-state={armed ? "armed" : "idle"}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={className ? `${BASE_CLASS} ${className}` : BASE_CLASS}
    >
      <span
        aria-live="polite"
        className={armed && armedClassName ? `${LABEL_CLASS} ${armedClassName}` : LABEL_CLASS}
      >
        {armed ? confirmLabel : children}
      </span>
    </button>
  );
}
