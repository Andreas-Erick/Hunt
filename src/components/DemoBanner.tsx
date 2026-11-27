"use client";

import React, { useState } from "react";
import { RotateCcw } from "lucide-react";
import { resetDemoData } from "@/lib/demoStore";
import { logDiagnostic, summarizeError } from "@/lib/diagnostics";
import { RELEASES_URL } from "@/lib/webDemo";
import { StableSlot } from "./StableSlot";

/**
 * The browser demo's strip above the app (ADR-0010): says the data stays in this browser,
 * links to the real app, and restores the sample data. Rendered only by the demo build.
 */
export function DemoBanner({
  reset = resetDemoData,
  reload = () => window.location.reload(),
}: {
  /** Injected in tests; the demo writes the sample data again. */
  reset?: () => Promise<void>;
  reload?: () => void;
}) {
  const [state, setState] = useState<"idle" | "resetting" | "failed">("idle");

  const onReset = async () => {
    if (state === "resetting") return;
    setState("resetting");
    try {
      await reset();
      reload();
    } catch (err) {
      logDiagnostic({ level: "ERROR", domain: "boot", event: "demo_reset_failed", context: summarizeError(err) });
      setState("failed");
    }
  };

  return (
    <div
      role="region"
      aria-label="Live demo"
      data-testid="demo-banner"
      className="border-b border-white/[0.06] bg-surface text-xs text-neutral-400"
    >
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 py-1.5 sm:px-6 lg:px-12 xl:px-16">
        <p className="min-w-0 break-words">
          <span className="font-medium text-neutral-200">Live demo:</span> data stays in your
          browser.{" "}
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 coarse:min-h-11 items-center font-medium text-accent underline-offset-2 hover:underline"
          >
            Get the real app
          </a>
        </p>
        <button
          type="button"
          onClick={() => void onReset()}
          disabled={state === "resetting"}
          className="inline-flex min-h-8 coarse:min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 text-neutral-300 transition-colors duration-150 ease-out hover:border-white/20 hover:text-white active:opacity-80 disabled:opacity-60"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {/* One slot for every label, so the button never changes width in place. */}
          <StableSlot
            active={state}
            states={{ idle: "Reset demo", resetting: "Resetting…", failed: "Reset failed, retry" }}
          />
        </button>
      </div>
    </div>
  );
}
