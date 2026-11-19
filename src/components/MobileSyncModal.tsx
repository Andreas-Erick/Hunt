"use client";

import React, { useEffect, useLayoutEffect, useState, useRef } from "react";
import QRCode from "qrcode";
import { useShallow } from "zustand/react/shallow";
import {
  Smartphone,
  RefreshCw,
  Check,
  Copy,
  Download,
  Upload,
  X,
  Server,
  ServerOff,
} from "lucide-react";
import { useCommandStore } from "@/store/useCommandStore";
import {
  buildLocalSyncPayload,
  getClientSyncToken,
  importAndMergeSnapshotJson,
} from "@/lib/syncEngine";
import { hudAudio } from "@/lib/hudAudio";
import { formatAgo, usePhoneLink, useServerLink } from "./SyncStatus";

interface MobileSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** What Tab / Shift+Tab cycle through inside the dialog. */
const FOCUSABLE_SELECTOR = 'button, a[href], input:not([type="hidden"])';
/** How long "Copied" / "Saved" stay on their buttons. */
const ACK_MS = 2000;
/** How long a success message stays in the footer status line. */
const STATUS_OK_MS = 3000;

const COPY_FAILED_TEXT = "Copy failed. Select the link manually.";
/** The visible address has no key, so selecting it would not pair the phone. */
const COPY_FAILED_PAIRED_TEXT = "Copy failed. Scan the QR code with your phone instead.";

interface FooterStatus {
  source: "copy" | "export" | "import";
  tone: "ok" | "error";
  text: string;
}

/** Focus state for snapshot export/import, read at click time (no subscription). */
function currentFocusState() {
  const s = useCommandStore.getState();
  return {
    activeTaskId: s.activeTaskId,
    isRunning: s.isRunning,
    sessionStartedAt: s.sessionStartedAt,
    updatedAt: s.focusUpdatedAt || 0,
  };
}

function displayHost(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * The link the phone opens or pastes: the phone page plus this desktop's
 * pairing key, or just the address while no key is known.
 */
export function buildPairingUrl(baseUrl: string, token: string): string {
  if (!token) return baseUrl;
  const origin = baseUrl.replace(/\/+$/, "");
  return `${origin}/hunt-mobile.html?token=${encodeURIComponent(token)}`;
}

/** A file that is not a Hunt snapshot (as opposed to a failed local save). */
function isBadSnapshotFile(err: unknown): boolean {
  return (
    err instanceof SyntaxError ||
    (err instanceof Error && err.name === "SnapshotFormatError")
  );
}

interface ParsedQrSvg {
  viewBox: string;
  paths: Array<{ d: string; fill?: string; stroke?: string }>;
}

/**
 * Extracts only `viewBox` and `<path d fill stroke>` from QRCode.toString's
 * SVG output so the QR renders as React elements with zero dangerouslySetInnerHTML.
 */
function parseQrSvg(svgText: string): ParsedQrSvg | null {
  const viewBoxMatch = /viewBox="([^"]+)"/.exec(svgText);
  if (!viewBoxMatch) return null;
  const paths: ParsedQrSvg["paths"] = [];
  const pathRe = /<path\b([^>]*)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(svgText)) !== null) {
    const attrs = match[1];
    const d = /\bd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) continue;
    const fill = /\bfill="([^"]+)"/.exec(attrs)?.[1];
    const stroke = /\bstroke="([^"]+)"/.exec(attrs)?.[1];
    paths.push({ d, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) });
  }
  return paths.length > 0 ? { viewBox: viewBoxMatch[1], paths } : null;
}

export function MobileSyncModal({ isOpen, onClose }: MobileSyncModalProps) {
  // Nothing subscribes to the store (or ticks) while the modal is closed.
  if (!isOpen) return null;
  return <MobileSyncModalContent onClose={onClose} />;
}

function MobileSyncModalContent({ onClose }: { onClose: () => void }) {
  const { lastSyncedAt, lanUrls, syncNow } = useCommandStore(
    useShallow((s) => ({
      lastSyncedAt: s.lastSyncedAt,
      lanUrls: s.lanUrls,
      syncNow: s.syncNow,
    }))
  );

  // Relative times refresh every second while the modal is open.
  const phone = usePhoneLink(1000);
  const server = useServerLink();

  const [token] = useState(getClientSyncToken);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<ParsedQrSvg | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<"ok" | "error" | null>(null);
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<FooterStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Export / import in flight (a ref, so a second click in the same tick is refused too). */
  const busyRef = useRef(false);
  /** False once unmounted: async handlers stop updating state. */
  const aliveRef = useRef(true);
  /** The current click started on the backdrop (a drag out of the card must not close). */
  const pressOnBackdropRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const activeUrl =
    (selectedUrl && lanUrls.includes(selectedUrl) ? selectedUrl : null) ??
    lanUrls[0] ??
    (typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000");
  const pairingUrl = buildPairingUrl(activeUrl, token);
  const busy = exporting || importing;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Focus moves into the dialog and returns to the opener (the Phone button) on
  // close. A layout effect, so focus is back on the opener before the dialog's
  // nodes are removed (focus never drops to <body> in between).
  useLayoutEffect(() => {
    const active = document.activeElement;
    const opener =
      active instanceof HTMLElement && active !== document.body ? active : null;
    closeButtonRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Fresh status as soon as the modal opens.
  useEffect(() => {
    void syncNow();
  }, [syncNow]);

  // Escape closes the modal.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Acknowledgements revert after a moment; each timer is cleared on unmount.
  useEffect(() => {
    if (!syncResult) return;
    const id = setTimeout(() => setSyncResult(null), 2500);
    return () => clearTimeout(id);
  }, [syncResult]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), ACK_MS);
    return () => clearTimeout(id);
  }, [copied]);

  useEffect(() => {
    if (!exported) return;
    const id = setTimeout(() => setExported(false), ACK_MS);
    return () => clearTimeout(id);
  }, [exported]);

  useEffect(() => {
    if (status?.tone !== "ok") return;
    const id = setTimeout(() => setStatus(null), STATUS_OK_MS);
    return () => clearTimeout(id);
  }, [status]);

  useEffect(() => {
    if (!pairingUrl) return;
    let alive = true;
    // Dark modules on white with the standard 4-module quiet zone: phone cameras
    // (Samsung's included) do not read inverted codes or codes with a thin margin.
    QRCode.toString(pairingUrl, {
      type: "svg",
      margin: 4,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    })
      .then((svg) => {
        if (alive) setQrSvg(parseQrSvg(svg));
      })
      .catch(() => {
        if (alive) setQrSvg(null);
      });
    return () => {
      alive = false;
    };
  }, [pairingUrl]);

  /** Tab / Shift+Tab wrap between the first and last controls of the dialog. */
  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const items = Array.from(
      root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled"));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey ? active === first || active === root : active === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  const handleManualSync = async () => {
    if (syncing) return;
    hudAudio.playClick();
    setSyncing(true);
    setSyncResult(null);
    let ok = false;
    try {
      // syncNow is single-flight: this awaits the real result even when an
      // automatic sync is already running.
      ok = await syncNow();
    } catch {
      ok = false;
    }
    if (!aliveRef.current) return;
    setSyncing(false);
    setSyncResult(ok ? "ok" : "error");
  };

  const handleCopyUrl = async () => {
    hudAudio.playClick();
    try {
      await navigator.clipboard.writeText(pairingUrl);
      if (!aliveRef.current) return;
      setCopied(true);
      setStatus((s) => (s?.source === "copy" ? null : s));
    } catch (err) {
      console.error("[hunt] clipboard_write_failed", err);
      if (!aliveRef.current) return;
      setCopied(false);
      setStatus({
        source: "copy",
        tone: "error",
        text: token ? COPY_FAILED_PAIRED_TEXT : COPY_FAILED_TEXT,
      });
    }
  };

  const handleExportJson = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    hudAudio.playClick();
    setExporting(true);
    setExported(false);
    setStatus(null);
    try {
      const payload = await buildLocalSyncPayload(currentFocusState());
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = `hunt-sync-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
      if (aliveRef.current) setExported(true);
    } catch (err) {
      console.error("[hunt] snapshot_export_failed", err);
      if (aliveRef.current) {
        setStatus({
          source: "export",
          tone: "error",
          text: "Could not export the snapshot.",
        });
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Cleared right away, so picking the same file again fires a change.
    input.value = "";
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setImporting(true);
    setStatus(null);
    try {
      const text = await file.text();
      await importAndMergeSnapshotJson(text, currentFocusState());
      hudAudio.playComplete();
      if (aliveRef.current) {
        setStatus({
          source: "import",
          tone: "ok",
          text: "Snapshot merged successfully!",
        });
      }
      // Push the merged rows to the server in the background (never rejects).
      void syncNow();
    } catch (err) {
      const badFile = isBadSnapshotFile(err);
      if (!badFile) console.error("[hunt] snapshot_import_failed", err);
      if (aliveRef.current) {
        setStatus({
          source: "import",
          tone: "error",
          text: badFile
            ? "Invalid snapshot file."
            : "Could not save the snapshot locally.",
        });
      }
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setImporting(false);
    }
  };

  const lastSyncedStr = lastSyncedAt
    ? `${new Date(lastSyncedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })} · ${formatAgo(Date.now() - lastSyncedAt)}`
    : "Never";

  const serverTone =
    server.state === "error"
      ? "text-[#ffb800]"
      : server.state === "ok"
      ? "text-neutral-200"
      : "text-neutral-400";

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Phone & Cross-Device Sync"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      onMouseDown={(e) => {
        pressOnBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const onBackdrop =
          e.target === e.currentTarget && pressOnBackdropRef.current;
        pressOnBackdropRef.current = false;
        if (onBackdrop) onClose();
      }}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/75 p-4 backdrop-blur-sm outline-none sm:items-center"
    >
      <div className="relative my-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-white/[0.1] bg-[#111318] p-6 sm:p-8 shadow-2xl">
        {/* Top Modal Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#00f0ff]/30 bg-[#00f0ff]/10 text-[#00f0ff]">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-medium text-white">
                Phone &amp; Cross-Device Sync
              </h2>
              <p className="text-xs text-neutral-400">
                Use Hunt on your phone and keep Quests, tasks, and timers in
                sync.
              </p>
            </div>
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="rounded-lg p-2 text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main 2-Column Body */}
        <div className="mt-7 grid grid-cols-1 gap-6 sm:grid-cols-12 items-center">
          {/* Left: Scannable QR Code */}
          <div className="sm:col-span-5 flex flex-col items-center rounded-2xl border border-white/[0.08] bg-[#0b0c0e] p-5 text-center">
            {qrSvg ? (
              <div
                data-testid="pairing-qr"
                className="h-44 w-44 overflow-hidden rounded-xl bg-white"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox={qrSvg.viewBox}
                  shapeRendering="crispEdges"
                  role="img"
                  aria-label="Phone pairing QR code"
                  className="h-full w-full"
                >
                  {qrSvg.paths.map((p, idx) => (
                    <path key={idx} d={p.d} fill={p.fill} stroke={p.stroke} />
                  ))}
                </svg>
              </div>
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-xs text-hud-muted">
                Generating QR...
              </div>
            )}

            <p className="mt-3 text-xs font-medium text-neutral-300">
              Scan with your phone camera
            </p>
            <p className="mt-1 text-[11px] text-hud-muted">
              Make sure your phone is on the same Wi-Fi
            </p>
            {!token && (
              <p className="mt-2 text-[11px] text-hud-amber">
                Open Hunt with the desktop launcher to load the pairing key.
              </p>
            )}

            {lanUrls.length > 1 && (
              <div className="mt-3 flex flex-wrap justify-center gap-1">
                {lanUrls.map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setSelectedUrl(u)}
                    title={u}
                    className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                      u === activeUrl
                        ? "bg-[#00f0ff]/20 text-[#00f0ff]"
                        : "text-hud-muted hover:text-neutral-300"
                    }`}
                  >
                    {displayHost(u)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Right: Sync Status + Install Instructions */}
          <div className="sm:col-span-7 space-y-4">
            {/* Live Sync Status Card: the phone and this laptop's server, separately */}
            <div className="rounded-xl border border-white/[0.08] bg-[#0d0f14] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-3">
                  {/* Phone */}
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <span
                        className={`h-2 w-2 rounded-full transition-colors ${
                          phone.live
                            ? "bg-[#00ff9d] shadow-[0_0_6px_#00ff9d]"
                            : "bg-neutral-500"
                        }`}
                      />
                    </span>
                    <div className="min-w-0">
                      <div
                        className={`text-xs font-medium ${
                          phone.live ? "text-[#00ff9d]" : "text-neutral-200"
                        }`}
                      >
                        {phone.label}
                      </div>
                      <div className="mt-0.5 text-[11px] leading-relaxed text-hud-muted">
                        {phone.detail}
                      </div>
                    </div>
                  </div>

                  {/* Local sync server (this laptop) */}
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                      {server.state === "error" ? (
                        <ServerOff className="h-3.5 w-3.5 text-[#ffb800]" />
                      ) : (
                        <Server
                          className={`h-3.5 w-3.5 ${
                            server.state === "ok"
                              ? "text-[#00ff9d]"
                              : "text-hud-muted"
                          }`}
                        />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className={`text-xs font-medium ${serverTone}`}>
                        {server.label}
                      </div>
                      <div className="mt-0.5 text-[11px] text-hud-muted">
                        Last synced:{" "}
                        <span className="text-neutral-300">{lastSyncedStr}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleManualSync}
                  disabled={syncing}
                  aria-busy={syncing}
                  className="flex min-w-[108px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10 disabled:cursor-wait disabled:opacity-80 transition-colors"
                >
                  {syncing ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Syncing…</span>
                    </>
                  ) : syncResult === "ok" ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-[#00ff9d]" />
                      <span>Synced</span>
                    </>
                  ) : syncResult === "error" ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 text-[#ffb800]" />
                      <span>Retry</span>
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Sync Now</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Laptop address + Copy (copies the pairing link; the key is never shown) */}
            <div className="flex items-center justify-between gap-2 rounded-xl border border-white/[0.08] bg-[#0b0c0e] px-3.5 py-2.5">
              <span className="truncate font-mono text-xs text-[#00f0ff]">
                {activeUrl}
              </span>
              <button
                type="button"
                onClick={handleCopyUrl}
                title={token ? "Copy the pairing link" : "Copy the address"}
                className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-neutral-300 hover:text-white"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-[#00ff9d]" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            {/* How to connect the phone */}
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs leading-relaxed text-neutral-300 space-y-1.5">
              <div className="font-medium text-white">
                How to connect your phone:
              </div>
              <p className="text-neutral-400">
                1. In the phone browser: scan the QR code above to open Hunt.
                To keep it, tap <strong>Share → Add to Home Screen</strong> (iOS
                Safari) or <strong>Add to Home screen</strong> (Android Chrome).
              </p>
              <p className="text-neutral-400">
                2. In the Android app: open <strong>Sync</strong> and paste the
                pairing link (Copy above, or the link your camera reads from the
                QR code) into <strong>Laptop address</strong>.
              </p>
              <p className="text-neutral-400">
                3. Tasks &amp; timers sync automatically over Wi-Fi, continue
                working offline while you&apos;re away, and merge back when you
                reconnect.
              </p>
            </div>
          </div>
        </div>

        {/* Footer: Offline Snapshot Export / Import */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-4 text-xs">
          <span
            role="status"
            aria-live="polite"
            className={
              status?.tone === "error" ? "text-hud-amber" : "text-hud-muted"
            }
          >
            {status?.text ?? "Away from home Wi-Fi? Sync via snapshot file:"}
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/Hunt-Mobile.apk"
              download="Hunt-Mobile.apk"
              className="flex items-center gap-1.5 rounded-lg border border-[#00f0ff]/35 bg-[#00f0ff]/10 px-3 py-1.5 font-medium text-[#00f0ff] hover:bg-[#00f0ff]/20 transition-colors"
            >
              <Smartphone className="h-3.5 w-3.5" />
              <span>Download Android APK</span>
            </a>

            <button
              type="button"
              onClick={handleExportJson}
              disabled={busy}
              aria-busy={exporting}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-neutral-300 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-60 transition-colors"
            >
              {exported ? (
                <>
                  <Check className="h-3.5 w-3.5 text-[#00ff9d]" />
                  <span>Saved</span>
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" />
                  <span>Export Snapshot</span>
                </>
              )}
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleImportFile}
              tabIndex={-1}
              aria-hidden="true"
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              aria-busy={importing}
              className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-neutral-300 hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-60 transition-colors"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Merge Snapshot</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
