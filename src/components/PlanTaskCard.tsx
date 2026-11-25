"use client";

import React from "react";
import { ChevronLeft, ChevronRight, Repeat, Trash2 } from "lucide-react";
import { accentStyle } from "@/lib/questAccents";
import { formatChronoMMSS } from "@/lib/dateUtils";
import type { Quest, Task } from "@/lib/domainTypes";
import { hudAudio } from "@/lib/hudAudio";
import { ConfirmDeleteButton, ROW_DELETE_CLASS } from "./ConfirmDeleteButton";
import { RowTick } from "./RowTick";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";
const MOVE_BUTTON = `flex min-h-11 items-center gap-1 rounded-lg px-2 text-xs text-hud-muted hover:text-white ${PRESSABLE}`;

/** A pending task on the Plan board: open it in Focus, tick it, delete it, or move it a day. */
export function PlanTaskCard({
  task,
  quest,
  dateKey,
  isHero,
  isRunningHere,
  isCompleting,
  isDragged,
  onDragStart,
  onDragEnd,
  onKeyDown,
  onOpen,
  onComplete,
  onDelete,
  onMove,
}: {
  task: Task;
  quest: Quest | undefined;
  dateKey: string;
  /** Today's first card (highlighted). */
  isHero: boolean;
  isRunningHere: boolean;
  isCompleting: boolean;
  isDragged: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  /** Alt+Shift+←/→ moves the task a day. */
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
  onOpen: () => void;
  onComplete: () => void;
  onDelete: () => void;
  /** One day earlier (-1) or later (1): the touch equivalent of drag and Alt+Shift+arrows. */
  onMove: (step: -1 | 1) => void;
}) {
  const style = accentStyle(quest?.accentColor);
  const questLabel = quest ? quest.title : "Other";
  return (
    <div
      data-testid="task-row"
      data-task-id={task.id}
      data-date-key={dateKey}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={onKeyDown}
      className={`group relative overflow-hidden rounded-xl border p-4 pl-5 transition-[border-color,background-color,opacity] duration-200 cursor-grab active:cursor-grabbing ${
        isDragged ? "opacity-40 " : ""
      }${isHero ? "border-now/40 bg-raised shadow-card-warning" : "border-white/[0.08] bg-surface hover:border-white/20"}`}
    >
      <div className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${style.bg}`} />

      <button
        type="button"
        data-card-title
        data-task-title="true"
        onClick={() => {
          hudAudio.playLockOn();
          onOpen();
        }}
        aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
        className={`block w-full cursor-pointer break-words [text-wrap:pretty] text-left text-sm font-medium leading-snug text-white hover:text-accent ${PRESSABLE}`}
      >
        {task.title}
      </button>

      {task.notes && (
        <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-hud-muted">{task.notes}</p>
      )}

      {/* One line: the quest pill truncates so time + Delete stay on the right
          edge instead of wrapping under the tick. */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <RowTick
            task={task}
            onComplete={onComplete}
            className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border before:absolute before:-inset-2.5 coarse:before:-inset-3.5 before:content-[''] transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-90 active:opacity-80 ${
              isCompleting
                ? `${style.bg} border-transparent text-black`
                : "border-white/40 text-transparent hover:border-success hover:text-success"
            }`}
          />

          <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-0.5 text-[11px] text-neutral-300">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.bg}`} />
            <span className="min-w-0 truncate" title={questLabel}>
              {questLabel}
            </span>
          </span>
          {task.habitId && (
            <span title="Daily habit" aria-label="Daily habit" className="inline-flex shrink-0 items-center text-hud-muted">
              <Repeat className="h-3 w-3" aria-hidden="true" />
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {task.accumulatedSeconds > 0 && (
            <span className="font-mono text-[11px] tabular-nums text-neutral-400">
              {formatChronoMMSS(task.accumulatedSeconds).formatted}
            </span>
          )}
          {isRunningHere && <span className="h-2 w-2 rounded-full bg-success animate-pulse" />}
          {/* ROW_DELETE_CLASS: revealed on row hover for mice, always visible
              (muted) on touch, padded target. */}
          <ConfirmDeleteButton
            label="Delete task"
            onConfirm={onDelete}
            className={`${ROW_DELETE_CLASS} whitespace-nowrap text-xs`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ConfirmDeleteButton>
        </div>
      </div>

      {/* Touch screens can't drag or press Alt+Shift+arrows: a move row instead. */}
      <div className="mt-3 hidden items-center justify-between gap-2 hoverless:flex">
        <button
          type="button"
          onClick={() => onMove(-1)}
          aria-label={`Move "${task.title}" to the previous day`}
          className={MOVE_BUTTON}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Earlier
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          aria-label={`Move "${task.title}" to the next day`}
          className={MOVE_BUTTON}
        >
          Later
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
