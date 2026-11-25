"use client";

import React, { useEffect, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import type { TimeLog } from "@/lib/domainTypes";
import { accentStyle } from "@/lib/questAccents";
import { formatChronoMMSS } from "@/lib/dateUtils";
import { ConfirmDeleteButton, ROW_DELETE_CLASS } from "./ConfirmDeleteButton";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";
export const SESSION_LOG_PAGE_SIZE = 50;

/**
 * The Review's collapsible session log: the period's sessions in the current
 * scope, a page at a time, each with a two-step Delete. The page resets when
 * `resetKey` (the period and scope) changes.
 */
export function SessionHistoryLog({
  logs,
  loaded,
  sessionUnitLabel,
  resetKey,
  onDeleteLog,
}: {
  /** The period's sessions in scope, in display order. */
  logs: readonly TimeLog[];
  /** False while the period's logs (or the Quests) load: the count shows '–'. */
  loaded: boolean;
  /** The period phrase after "sessions", e.g. "this week". */
  sessionUnitLabel: string;
  resetKey: string;
  onDeleteLog: (id: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [visibleLogLimit, setVisibleLogLimit] = useState(SESSION_LOG_PAGE_SIZE);

  useEffect(() => {
    setVisibleLogLimit(SESSION_LOG_PAGE_SIZE);
  }, [resetKey]);

  return (
    <div className="mt-10">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`-mx-2 flex items-center gap-1.5 coarse:min-h-11 rounded-lg px-2 py-2 text-sm font-medium text-hud-muted hover:bg-white/[0.04] hover:text-neutral-300 ${PRESSABLE}`}
      >
        {open
          ? "Hide session log"
          : `Session log (${loaded ? logs.length : "–"} sessions ${sessionUnitLabel})`}
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 transition-transform duration-200 ease-out ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="mt-4 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.08] bg-surface px-4 sm:px-6 py-2">
          {loaded && logs.length === 0 && (
            <p className="py-3.5 text-sm text-hud-muted">
              No sessions logged {sessionUnitLabel}.
            </p>
          )}
          {logs.slice(0, visibleLogLimit).map((log) => {
            const style = accentStyle(log.accentColorSnapshot);
            return (
              <div
                key={log.id}
                data-testid="session-row"
                data-log-id={log.id}
                className="group flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 sm:gap-4 py-3.5 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
                  <span className="shrink-0 text-xs tabular-nums text-hud-muted">
                    {log.dateKey}
                  </span>
                  <span className="truncate text-neutral-200" title={log.taskTitleSnapshot}>
                    {log.taskTitleSnapshot}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-4 font-mono text-xs tabular-nums text-neutral-400">
                  <span>
                    {formatChronoMMSS(log.durationSeconds).formatted}
                  </span>
                  <ConfirmDeleteButton
                    label="Delete session"
                    onConfirm={() => onDeleteLog(log.id)}
                    className={`whitespace-nowrap font-sans ${ROW_DELETE_CLASS}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </ConfirmDeleteButton>
                </div>
              </div>
            );
          })}
          {logs.length > visibleLogLimit && (
            <div className="py-3 text-center">
              <button
                type="button"
                data-testid="review-logs-show-more"
                onClick={() =>
                  setVisibleLogLimit((cur) => cur + SESSION_LOG_PAGE_SIZE)
                }
                className={`min-h-8 coarse:min-h-11 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-medium text-neutral-200 hover:border-white/25 hover:text-white ${PRESSABLE}`}
              >
                Show more sessions ({logs.length - visibleLogLimit}{" "}
                remaining)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
