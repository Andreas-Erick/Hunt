"use client";

import React from "react";
import { accentStyle, type Quest, type Task, type TimeLog } from "@/lib/db";
import { layoutTimelineBlocks } from "@/lib/reviewAnalytics";

const HOUR_HEIGHT_PX = 52;

interface DayTimelineProps {
  /** Logs of the rolling quest week (undefined while loading); today's are drawn. */
  weekLogs: TimeLog[] | undefined;
  todayKey: string;
  /** The task that owns the focus session, if any. */
  activeTask: Task | undefined;
  isRunning: boolean;
  sessionStartedAt: number | null;
  /** Seconds of the running session so far. */
  liveSeconds: number;
  /** Current time (drives the "now" line). */
  nowMs: number;
  questMap: Map<string, Quest>;
}

/**
 * Home's right column: today's logged sessions and the running one on an
 * hourly grid (default 08:00–22:00, widened for early or late sessions).
 */
export function DayTimeline({
  weekLogs,
  todayKey,
  activeTask,
  isRunning,
  sessionStartedAt,
  liveSeconds,
  nowMs,
  questMap,
}: DayTimelineProps) {
  const todayLogs = React.useMemo(() => {
    return (weekLogs ?? [])
      .filter((l) => l.dateKey === todayKey)
      .sort((a, b) => a.startTime - b.startTime);
  }, [weekLogs, todayKey]);

  const timelineLayout = React.useMemo(() => {
    const items = todayLogs.map((l) => ({
      id: l.id,
      startTime: l.startTime,
      durationSeconds: l.durationSeconds,
    }));
    if (activeTask && isRunning && sessionStartedAt) {
      items.push({
        id: "__live_running__",
        startTime: sessionStartedAt,
        durationSeconds: Math.max(60, liveSeconds),
      });
    }
    return layoutTimelineBlocks(items, 8, 22);
  }, [todayLogs, activeTask, isRunning, sessionStartedAt, liveSeconds]);

  const timelineHours = timelineLayout.hours;
  const TIMELINE_START_HOUR = timelineLayout.windowStartHour;
  const TIMELINE_END_HOUR = timelineLayout.windowEndHour;

  const currentHourFloat = React.useMemo(() => {
    const d = new Date(nowMs);
    return d.getHours() + d.getMinutes() / 60;
  }, [nowMs]);

  return (
    <div className="min-w-0 lg:col-span-5">
      <div className="mb-6 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">
          Today&apos;s Timeline
        </span>
        <span className="text-xs tabular-nums text-hud-muted">
          {todayLogs.length} session{todayLogs.length === 1 ? "" : "s"}{" "}
          logged
        </span>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111318] p-5">
        <div
          className="relative"
          style={{
            height: `${
              (TIMELINE_END_HOUR - TIMELINE_START_HOUR) * HOUR_HEIGHT_PX
            }px`,
          }}
        >
          {/* Hourly Grid Lines */}
          {timelineHours.map((hr) => {
            const topPx = (hr - TIMELINE_START_HOUR) * HOUR_HEIGHT_PX;
            return (
              <div
                key={hr}
                style={{ top: `${topPx}px` }}
                className="absolute left-0 right-0 flex items-start"
              >
                <span className="w-12 -translate-y-2 font-mono text-[11px] tabular-nums text-hud-muted">
                  {String(hr).padStart(2, "0")}:00
                </span>
                <div className="flex-1 border-t border-white/[0.05]" />
              </div>
            );
          })}

          {/* Logged Session Blocks (non-overlapping multi-lane layout) */}
          {todayLogs.map((log) => {
            const startD = new Date(log.startTime);
            const endD = new Date(log.endTime);
            const placement = timelineLayout.placements.get(log.id);
            const startHr =
              placement?.startHour ??
              startD.getHours() + startD.getMinutes() / 60;
            const durationHr = Math.max(0.35, log.durationSeconds / 3600);

            const clampedStart = Math.max(
              TIMELINE_START_HOUR,
              Math.min(TIMELINE_END_HOUR - 0.4, startHr)
            );
            const topPx =
              (clampedStart - TIMELINE_START_HOUR) * HOUR_HEIGHT_PX;
            const heightPx = Math.max(
              34,
              Math.min(
                (TIMELINE_END_HOUR - clampedStart) * HOUR_HEIGHT_PX,
                durationHr * HOUR_HEIGHT_PX
              )
            );

            const colIndex = placement?.colIndex ?? 0;
            const totalCols = placement?.totalCols ?? 1;
            const leftExpr = `calc(3.5rem + (100% - 3.75rem) * ${colIndex} / ${totalCols})`;
            const widthExpr = `calc((100% - 3.75rem) / ${totalCols} - ${
              totalCols > 1 ? 4 : 0
            }px)`;

            const style = accentStyle(log.accentColorSnapshot);
            const startStr = `${String(startD.getHours()).padStart(
              2,
              "0"
            )}:${String(startD.getMinutes()).padStart(2, "0")}`;
            const endStr = `${String(endD.getHours()).padStart(
              2,
              "0"
            )}:${String(endD.getMinutes()).padStart(2, "0")}`;

            return (
              <div
                key={log.id}
                data-testid="timeline-block"
                data-col-index={colIndex}
                data-total-cols={totalCols}
                title={`${log.taskTitleSnapshot} (${startStr} – ${endStr})`}
                style={{
                  top: `${topPx}px`,
                  height: `${heightPx}px`,
                  left: leftExpr,
                  width: widthExpr,
                  backgroundImage: `repeating-linear-gradient(-45deg, ${style.hex}18, ${style.hex}18 6px, ${style.hex}08 6px, ${style.hex}08 12px)`,
                  borderColor: `${style.hex}45`,
                }}
                className="absolute overflow-hidden rounded-xl border px-3 py-2"
              >
                <div
                  className="bottom-0 left-0 top-0 w-1 absolute"
                  style={{ backgroundColor: style.hex }}
                />
                {/* Two title lines once the block also fits its time row
                    (py-2 + 2 x 16px + ~17px time row); touch has no tooltip. */}
                <div
                  className={`break-words text-xs font-medium text-white ${
                    heightPx >= 68 ? "line-clamp-2" : "truncate"
                  }`}
                >
                  {log.taskTitleSnapshot}
                </div>
                {heightPx >= 46 && (
                  <div className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-neutral-400">
                    {startStr} – {endStr}
                  </div>
                )}
              </div>
            );
          })}

          {/* Currently Running Session Live Block */}
          {activeTask && isRunning && sessionStartedAt && (
            (() => {
              const startD = new Date(sessionStartedAt);
              const placement =
                timelineLayout.placements.get("__live_running__");
              const startHr =
                placement?.startHour ??
                startD.getHours() + startD.getMinutes() / 60;
              const clampedStart = Math.max(
                TIMELINE_START_HOUR,
                Math.min(TIMELINE_END_HOUR - 0.4, startHr)
              );
              const topPx =
                (clampedStart - TIMELINE_START_HOUR) * HOUR_HEIGHT_PX;
              const heightPx = Math.max(
                36,
                (liveSeconds / 3600) * HOUR_HEIGHT_PX
              );
              const colIndex = placement?.colIndex ?? 0;
              const totalCols = placement?.totalCols ?? 1;
              const leftExpr = `calc(3.5rem + (100% - 3.75rem) * ${colIndex} / ${totalCols})`;
              const widthExpr = `calc((100% - 3.75rem) / ${totalCols} - ${
                totalCols > 1 ? 4 : 0
              }px)`;
              const q = activeTask.questId
                ? questMap.get(activeTask.questId)
                : undefined;
              const style = accentStyle(q?.accentColor ?? "cyan");

              return (
                <div
                  style={{
                    top: `${topPx}px`,
                    height: `${heightPx}px`,
                    left: leftExpr,
                    width: widthExpr,
                    backgroundColor: `${style.hex}1a`,
                    borderColor: `${style.hex}80`,
                  }}
                  className="absolute overflow-hidden rounded-xl border px-3 py-2"
                >
                  <div className="truncate text-xs font-medium text-white">
                    {activeTask.title}
                  </div>
                </div>
              );
            })()
          )}

          {/* Current Time Indicator Line */}
          {currentHourFloat >= TIMELINE_START_HOUR &&
            currentHourFloat <= TIMELINE_END_HOUR && (
              <div
                style={{
                  top: `${
                    (currentHourFloat - TIMELINE_START_HOUR) *
                    HOUR_HEIGHT_PX
                  }px`,
                }}
                className="pointer-events-none absolute left-12 right-0 flex items-center"
              >
                <span className="h-2.5 w-2.5 -translate-x-1 rounded-full bg-[#ffb800] shadow-[0_0_8px_#ffb800]" />
                <div className="h-[1.5px] flex-1 bg-[#ffb800]/80" />
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
