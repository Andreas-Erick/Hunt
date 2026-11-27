"use client";

import React, { useRef } from "react";
import { ExternalLink, Smartphone, X } from "lucide-react";
import { RELEASES_URL } from "@/lib/webDemo";
import { useModalDialog } from "./useModalDialog";

/**
 * The browser demo's stand-in for the Phone & Sync sheet (ADR-0010). Pairing, LAN sync,
 * the APK download and snapshot import/export all need the laptop's sync server, which a
 * static demo does not have, so this says so instead of showing controls that cannot work.
 */
export function DemoPhoneSheet({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  if (!isOpen) return null;
  return <DemoPhoneSheetContent onClose={onClose} />;
}

function DemoPhoneSheetContent({ onClose }: { onClose: () => void }) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const pressOnBackdropRef = useRef(false);
  const { dialogRef, onKeyDown } = useModalDialog<HTMLDivElement>({
    onClose,
    initialFocusRef: closeButtonRef,
  });

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-phone-sheet-title"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        pressOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const onBackdrop = e.target === e.currentTarget && pressOnBackdropRef.current;
        pressOnBackdropRef.current = false;
        if (onBackdrop) onClose();
      }}
      className="hunt-backdrop-enter fixed inset-0 z-50 flex items-start justify-center overflow-y-auto overscroll-contain bg-black/75 p-3 sm:p-4 backdrop-blur-sm outline-none sm:items-center"
    >
      <div className="hunt-panel-enter relative my-auto w-full max-w-md rounded-2xl border border-white/[0.1] bg-surface p-4 sm:p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
              <Smartphone className="h-5 w-5" aria-hidden="true" />
            </div>
            <h2 id="demo-phone-sheet-title" className="min-w-0 text-lg font-medium text-white">
              Phone &amp; sync
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex shrink-0 items-center justify-center min-h-8 min-w-8 coarse:min-h-11 coarse:min-w-11 rounded-lg border border-white/[0.08] bg-white/[0.02] text-neutral-400 transition-colors duration-150 ease-out hover:text-white active:opacity-80"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-neutral-300">
          This live demo runs entirely in your browser, so it has no phone to pair with and
          no laptop to sync to.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          The real Hunt runs on a Windows desktop and an Android phone, and syncs the two over
          your own Wi-Fi, with no account or cloud.
        </p>

        <div className="mt-6 flex justify-end">
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 coarse:min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-black transition-[background-color,opacity] duration-150 ease-out hover:bg-accent-hi active:opacity-80"
          >
            Get the real app
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}
