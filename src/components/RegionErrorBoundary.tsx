"use client";

import React from "react";
import { recordBreadcrumb, summarizeError } from "@/lib/diagnostics";

interface RegionErrorBoundaryProps {
  /** Names the region in the diagnostic log ("Home", "Session timer", ...). */
  region: string;
  /** Shown instead of the default card after a failure; null renders nothing. */
  fallback?: React.ReactNode | null;
  /** When set, the default card also offers Close (for regions that overlay the page). */
  onDismiss?: () => void;
  children: React.ReactNode;
}

interface RegionErrorBoundaryState {
  failed: boolean;
}

const BUTTON_CLASS =
  "min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/[0.08] hover:text-white active:opacity-80";

/**
 * Isolates one region of the app: a render error there (including a failed
 * IndexedDB read rethrown by useLiveQuery) shows an inline card with Retry
 * instead of unmounting the whole page. Retry remounts the children, which
 * gives their live queries a fresh subscription.
 */
export class RegionErrorBoundary extends React.Component<
  RegionErrorBoundaryProps,
  RegionErrorBoundaryState
> {
  state: RegionErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RegionErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    recordBreadcrumb({
      level: "ERROR",
      domain: "ui",
      event: "render_error",
      context: { region: this.props.region, ...summarizeError(error) },
    });
    console.error("[hunt] render_error", this.props.region, error);
  }

  componentDidUpdate(): void {
    this.syncEscapeListener();
  }

  componentWillUnmount(): void {
    document.removeEventListener("keydown", this.handleKeyDown);
  }

  /** An overlay region's card closes with Escape, like the overlay it replaced. */
  private syncEscapeListener(): void {
    if (typeof document === "undefined") return;
    const listening =
      this.state.failed &&
      this.props.fallback === undefined &&
      Boolean(this.props.onDismiss);
    document.removeEventListener("keydown", this.handleKeyDown);
    if (listening) document.addEventListener("keydown", this.handleKeyDown);
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.handleDismiss();
  };

  private handleRetry = (): void => {
    this.setState({ failed: false });
  };

  private handleDismiss = (): void => {
    this.setState({ failed: false });
    this.props.onDismiss?.();
  };

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        className={
          this.props.onDismiss
            ? "fixed inset-x-0 top-16 z-50 px-4 sm:top-20"
            : "px-4 py-6"
        }
      >
        <div
          role="alert"
          className={`mx-auto flex max-w-xl flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] px-4 py-3 text-sm text-hud-muted ${
            this.props.onDismiss
              ? "bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
              : "bg-white/[0.02]"
          }`}
        >
          <span className="min-w-0">
            Couldn&apos;t load this section from your local Hunt data. Nothing
            was deleted.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={this.handleRetry} className={BUTTON_CLASS}>
              Retry
            </button>
            {this.props.onDismiss && (
              <button type="button" onClick={this.handleDismiss} className={BUTTON_CLASS}>
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
