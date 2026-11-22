"use client";

import React, { useState } from "react";
import { Flame, Sparkles } from "lucide-react";
import type { QuestAccent } from "@/lib/domainTypes";
import {
  formatTelemetryDuration,
  type ActivityHeatmapReport,
  type HeatmapCell,
} from "@/lib/reviewAnalytics";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";

type HeatmapPalette = QuestAccent | "slate";

const LEVEL_CLASSES: Record<HeatmapPalette, readonly [string, string, string, string, string]> = {
  amber: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-amber/20 hover:bg-q-amber/30",
    "bg-q-amber/40 hover:bg-q-amber/55",
    "bg-q-amber/70 hover:bg-q-amber/80",
    "bg-q-amber hover:bg-q-amber-hi",
  ],
  cyan: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-cyan/20 hover:bg-q-cyan/30",
    "bg-q-cyan/40 hover:bg-q-cyan/55",
    "bg-q-cyan/70 hover:bg-q-cyan/80",
    "bg-q-cyan hover:bg-q-cyan-hi",
  ],
  emerald: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-emerald/20 hover:bg-q-emerald/30",
    "bg-q-emerald/40 hover:bg-q-emerald/55",
    "bg-q-emerald/70 hover:bg-q-emerald/80",
    "bg-q-emerald hover:bg-q-emerald-hi",
  ],
  purple: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-purple/20 hover:bg-q-purple/30",
    "bg-q-purple/40 hover:bg-q-purple/55",
    "bg-q-purple/70 hover:bg-q-purple/80",
    "bg-q-purple hover:bg-q-purple-hi",
  ],
  rose: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-rose/20 hover:bg-q-rose/30",
    "bg-q-rose/40 hover:bg-q-rose/55",
    "bg-q-rose/70 hover:bg-q-rose/80",
    "bg-q-rose hover:bg-q-rose-hi",
  ],
  sky: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-sky/20 hover:bg-q-sky/30",
    "bg-q-sky/40 hover:bg-q-sky/55",
    "bg-q-sky/70 hover:bg-q-sky/80",
    "bg-q-sky hover:bg-q-sky-hi",
  ],
  orange: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-orange/20 hover:bg-q-orange/30",
    "bg-q-orange/40 hover:bg-q-orange/55",
    "bg-q-orange/70 hover:bg-q-orange/80",
    "bg-q-orange hover:bg-q-orange-hi",
  ],
  lime: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-q-lime/20 hover:bg-q-lime/30",
    "bg-q-lime/40 hover:bg-q-lime/55",
    "bg-q-lime/70 hover:bg-q-lime/80",
    "bg-q-lime hover:bg-q-lime-hi",
  ],
  slate: [
    "bg-white/[0.04] hover:bg-white/[0.09]",
    "bg-slate-400/20 hover:bg-slate-400/30",
    "bg-slate-400/40 hover:bg-slate-400/55",
    "bg-slate-400/65 hover:bg-slate-400/75",
    "bg-slate-300 hover:bg-slate-200",
  ],
};

function resolvePalette(accent: string | null | undefined): HeatmapPalette {
  if (
    accent &&
    Object.prototype.hasOwnProperty.call(LEVEL_CLASSES, accent)
  ) {
    return accent as HeatmapPalette;
  }
  return "amber";
}

interface ReviewHeatmapCardProps {
  heatmap: ActivityHeatmapReport;
  scopeTitle: string;
  paletteAccent: string | null | undefined;
  /** True until the heatmap logs resolve: counts render "–" instead of real-looking zeros. */
  loading?: boolean;
}

export function ReviewHeatmapCard({
  heatmap,
  scopeTitle,
  paletteAccent,
  loading = false,
}: ReviewHeatmapCardProps) {
  const count = (value: React.ReactNode) => (loading ? "–" : value);
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const palette = resolvePalette(paletteAccent);
  const shades = LEVEL_CLASSES[palette];

  const selectedCell: HeatmapCell | null = React.useMemo(() => {
    for (const col of heatmap.columns) {
      for (const cell of col.cells) {
        if (selectedDateKey && cell.dateKey === selectedDateKey && !cell.isFuture) {
          return cell;
        }
      }
    }
    for (let i = heatmap.columns.length - 1; i >= 0; i--) {
      for (let j = heatmap.columns[i].cells.length - 1; j >= 0; j--) {
        const cell = heatmap.columns[i].cells[j];
        if (cell.isToday) return cell;
      }
    }
    return null;
  }, [heatmap.columns, selectedDateKey]);

  return (
    <section
      aria-label="Activity heatmap"
      data-testid="activity-heatmap"
      className="cq-card mt-6 rounded-2xl border border-white/[0.08] bg-surface p-4 sm:p-7"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Activity Heatmap · Last 26 Weeks
          </div>
          <p className="mt-1 text-xs text-hud-muted tabular-nums [overflow-wrap:anywhere]">
            {scopeTitle} · {count(heatmap.activeDays)} active{" "}
            {heatmap.activeDays === 1 && !loading ? "day" : "days"} ({count(heatmap.activePct)}%) ·{" "}
            {count(formatTelemetryDuration(heatmap.totalSeconds, { zeroAs: "0.0h" }))} logged ·{" "}
            {count(heatmap.totalCompletedTasks)}{" "}
            {heatmap.totalCompletedTasks === 1 && !loading ? "task" : "tasks"} completed
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-neutral-200 tabular-nums">
            <Flame className="h-3.5 w-3.5 text-now" />
            <span>
              Streak: <strong>{loading ? "–" : `${heatmap.currentStreak}d`}</strong>
            </span>
            <span className="text-hud-muted">
              · Best {loading ? "–" : `${heatmap.longestStreak}d`}
            </span>
          </div>

          {!loading && heatmap.bestWeekday && (
            <div className="flex items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1.5 text-neutral-300 tabular-nums">
              <Sparkles className="h-3.5 w-3.5 text-accent" />
              <span>
                Peak rhythm: <strong>{heatmap.bestWeekday.label}</strong> (
                {heatmap.bestWeekday.avgHours}h avg)
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Scrollable Grid Container */}
      <div className="scroll-shadow-x mt-6 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-full flex-col gap-1.5 coarse:gap-2">
          {/* Month Header Row */}
          <div className="flex items-center gap-1.5 coarse:gap-2 pl-9">
            {heatmap.columns.map((col) => (
              <div
                key={`m-${col.weekKey}`}
                className="w-3.5 max-w-[1.5rem] flex-1 whitespace-nowrap text-[10px] font-medium text-hud-muted"
              >
                {col.monthLabel ?? ""}
              </div>
            ))}
          </div>

          {/* 7 Weekday Rows x 26 Week Columns */}
          <div className="flex items-start gap-2">
            <div className="grid grid-rows-7 gap-1.5 coarse:gap-2 pr-1 text-[10px] leading-3.5 text-hud-muted">
              <span className="flex h-3.5 coarse:h-6 items-center">Mon</span>
              <span className="flex h-3.5 coarse:h-6 items-center" aria-hidden="true" />
              <span className="flex h-3.5 coarse:h-6 items-center">Wed</span>
              <span className="flex h-3.5 coarse:h-6 items-center" aria-hidden="true" />
              <span className="flex h-3.5 coarse:h-6 items-center">Fri</span>
              <span className="flex h-3.5 coarse:h-6 items-center" aria-hidden="true" />
              <span className="flex h-3.5 coarse:h-6 items-center">Sun</span>
            </div>

            <div className="flex flex-1 gap-1.5 coarse:gap-2">
              {heatmap.columns.map((col) => (
                <div key={col.weekKey} className="grid max-w-[1.5rem] flex-1 grid-rows-7 gap-1.5 coarse:gap-2">
                  {col.cells.map((cell) => {
                    if (cell.isFuture) {
                      return (
                        <div
                          key={cell.dateKey}
                          aria-hidden="true"
                          className="h-3.5 coarse:h-6 min-w-[12px] rounded-[3px] bg-transparent"
                        />
                      );
                    }
                    const isSelected = selectedCell?.dateKey === cell.dateKey;
                    const summary = `${cell.shortLabel}: ${cell.hours}h focus, ${cell.completedTasks} ${
                      cell.completedTasks === 1 ? "task" : "tasks"
                    } completed`;
                    return (
                      <button
                        key={cell.dateKey}
                        type="button"
                        data-testid="heatmap-cell"
                        data-date-key={cell.dateKey}
                        data-level={cell.level}
                        aria-label={summary}
                        aria-pressed={isSelected}
                        title={summary}
                        onClick={() => setSelectedDateKey(cell.dateKey)}
                        className={`h-3.5 coarse:h-6 min-w-[12px] rounded-[3px] ${shades[cell.level]} ${
                          isSelected
                            ? "ring-1 ring-white ring-offset-1 ring-offset-surface"
                            : cell.isToday
                            ? "ring-1 ring-white/40"
                            : ""
                        } ${PRESSABLE}`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Selected Day Readout + Intensity Legend */}
      <div className="mt-5 flex flex-col justify-between gap-3 border-t border-white/[0.06] pt-4 text-xs sm:flex-row sm:items-center">
        <div
          data-testid="heatmap-inspector"
          className="flex flex-wrap items-center gap-2 font-mono tabular-nums text-neutral-300"
        >
          {selectedCell ? (
            <>
              <span className="font-sans font-medium text-white">
                {selectedCell.shortLabel}
                {selectedCell.isToday ? " (Today)" : ""}
              </span>
              <span className="text-hud-muted">·</span>
              <span>
                {formatTelemetryDuration(selectedCell.seconds, { zeroAs: "0.0h" })} focus
              </span>
              <span className="text-hud-muted">·</span>
              <span>
                {selectedCell.completedTasks}{" "}
                {selectedCell.completedTasks === 1 ? "task" : "tasks"} done
              </span>
              {selectedCell.sessions > 0 && (
                <>
                  <span className="text-hud-muted">·</span>
                  <span className="text-hud-muted">
                    {selectedCell.sessions}{" "}
                    {selectedCell.sessions === 1 ? "session" : "sessions"}
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="font-sans text-hud-muted">
              Select any day square to inspect logged hours and completed tasks.
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-hud-muted">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((lvl) => (
            <span
              key={lvl}
              aria-hidden="true"
              className={`h-3 w-3 rounded-[3px] ${shades[lvl].split(" ")[0]}`}
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </section>
  );
}
