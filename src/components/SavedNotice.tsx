"use client";

import React from "react";
import { Check } from "lucide-react";

/**
 * A "saved" confirmation that is always mounted: the live region exists before
 * its text (so screen readers announce it) and reserves its line, so the form
 * beside it never jumps when the notice appears or clears.
 */
export function SavedNotice({ text }: { text: string | null | undefined }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={`inline-flex min-h-8 items-center gap-1.5 text-xs font-medium text-hud-emerald ${text ? "" : "invisible"}`}
    >
      {text && (
        <>
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{text}</span>
        </>
      )}
    </span>
  );
}
