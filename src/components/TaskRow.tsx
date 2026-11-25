"use client";

import React from "react";
import { motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { AlignLeft, Check, Pause, Play, Repeat, Trash2 } from "lucide-react";
import { accentStyle } from "@/lib/questAccents";
import { formatChronoMMSS } from "@/lib/dateUtils";
import type { Quest, Task } from "@/lib/domainTypes";
import { hudAudio } from "@/lib/hudAudio";
import {
  SETTLING_COMPLETED_CARD_CLASS,
  reopenDotBgClass,
} from "@/lib/taskCompletionMotion";
import { useCommandStore } from "@/store/useCommandStore";
import { TaskNotesField } from "./TaskNotesField";
import { ConfirmDeleteButton, ROW_DELETE_CLASS } from "./ConfirmDeleteButton";
import type { QueueRowReorderHandlers } from "./useQueueReorder";
import { HeightReveal } from "./HeightReveal";
import { ReminderBadge, TaskReminderField } from "./TaskReminderField";

interface QueueTaskRowProps {
  variant: "queue";
  task: Task;
  /** The task's quest, if it still exists. */
  quest: Quest | undefined;
  /** First row of the queue (highlighted card). */
  isTopTask: boolean;
  /** This task owns the focus session (running or paused). */
  isCurrentlyActive: boolean;
  /** Seconds of the running session not yet in `accumulatedSeconds`. */
  liveSeconds: number;
  /** Arrival highlight while the completion animation plays. */
  isCompleting: boolean;
  /** Notes & options drawer open. */
  isExpanded: boolean;
  /** A dragged row hovers this one. */
  isDragOver: boolean;
  /** Quests offered in the drawer's "move to quest" pills. */
  activeQuests: Quest[];
  /** Bound to the notes toggle while the drawer is open (Escape returns focus). */
  expandedToggleRef: React.RefObject<HTMLButtonElement | null>;
  reorderHandlers: QueueRowReorderHandlers;
  onComplete: (taskId: string) => void;
  onToggleExpanded: () => void;
  /** Escape inside the drawer. */
  onCloseDrawer: () => void;
}

interface MaintenanceTaskRowProps {
  variant: "maintenance";
  task: Task;
  isCompleting: boolean;
  onComplete: (taskId: string) => void;
}

interface CompletedTaskRowProps {
  variant: "completed";
  task: Task;
  quest: Quest | undefined;
  /** Settling-in highlight right after completion. */
  isJustCompleted: boolean;
}

export type TaskRowProps =
  | QueueTaskRowProps
  | MaintenanceTaskRowProps
  | CompletedTaskRowProps;

/** Small "Daily" badge of a task materialized from a habit. */
function DailyHabitBadge() {
  return (
    <span
      title="Daily habit"
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] text-hud-muted"
    >
      <Repeat className="h-3 w-3" aria-hidden="true" />
      <span>Daily</span>
    </span>
  );
}

/** A dated Task that is not a habit day can carry one reminder time (habit reminders live on the Habit). */
function hasReminderSlot(task: Task): boolean {
  return Boolean(task.scheduledDate) && !task.habitId;
}

/** Icon-only row delete (two-step) shared by Other work and Completed rows. */
function RowDeleteButton({ onConfirm }: { onConfirm: () => void }) {
  return (
    <ConfirmDeleteButton
      label="Delete task"
      onConfirm={onConfirm}
      className={ROW_DELETE_CLASS}
    >
      <Trash2 className="h-4 w-4" />
    </ConfirmDeleteButton>
  );
}

function TaskNotesPreview({ notes }: { notes: string }) {
  return (
    <p className="mt-1.5 max-w-[70ch] line-clamp-2 break-words text-xs leading-relaxed text-hud-muted">
      {notes}
    </p>
  );
}

/**
 * One task card on Home. `variant` picks the list it sits in:
 * - `queue`: a quest task (draggable, play/pause timer, notes & options drawer)
 * - `maintenance`: an Other work task
 * - `completed`: a recently completed task (reopen, settling highlight)
 */
export function TaskRow(props: TaskRowProps) {
  switch (props.variant) {
    case "queue":
      return <QueueTaskRow {...props} />;
    case "maintenance":
      return <MaintenanceTaskRow {...props} />;
    case "completed":
      return <CompletedTaskRow {...props} />;
  }
}

/** Store actions every row variant uses, bound to one task. */
function useTaskRowActions(taskId: string) {
  const { initializeFocus, deleteTask } = useCommandStore(
    useShallow((s) => ({
      initializeFocus: s.initializeFocus,
      deleteTask: s.deleteTask,
    }))
  );
  return {
    startFocus: () => {
      hudAudio.playLockOn();
      initializeFocus(taskId);
    },
    deleteThisTask: () => deleteTask(taskId),
  };
}

function MaintenanceTaskRow({
  task,
  isCompleting,
  onComplete,
}: MaintenanceTaskRowProps) {
  const { startFocus, deleteThisTask } = useTaskRowActions(task.id);
  const taskTotalSec = task.accumulatedSeconds || 0;
  return (
    <div
      data-testid="task-row"
      data-task-id={task.id}
      className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-surface p-5 pl-6 hover:border-white/15 transition-colors duration-200"
    >
      <div className="absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full bg-neutral-600" />

      <button
        type="button"
        data-task-title="true"
        onClick={startFocus}
        className="block w-full cursor-pointer break-words text-left text-base font-medium text-neutral-200 hover:text-white transition-colors duration-150 ease-out active:opacity-80"
      >
        {task.title}
      </button>

      {task.notes && <TaskNotesPreview notes={task.notes} />}

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 sm:gap-3">
          <button
            type="button"
            onClick={(e) => {
              // Ignore the second click of a double-click.
              if (e.detail > 1) return;
              onComplete(task.id);
            }}
            title="Mark complete"
            aria-label="Mark complete"
            className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border before:absolute before:-inset-3 before:content-[''] transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-90 active:opacity-80 ${
              isCompleting
                ? "border-transparent bg-slate-400 text-black"
                : "border-white/40 text-transparent hover:border-white hover:text-white"
            }`}
          >
            <Check className="h-3 w-3" />
          </button>

          <span className="flex items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1 text-xs text-neutral-400">
            <span className="h-2 w-2 rounded-full bg-neutral-500" />
            <span>Other work</span>
          </span>

          {task.habitId && <DailyHabitBadge />}
          {hasReminderSlot(task) && task.reminderTime && <ReminderBadge time={task.reminderTime} />}

          <button
            type="button"
            onClick={startFocus}
            aria-label={`Start focus: ${task.title}`}
            className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-full px-2 py-1 font-mono text-xs tabular-nums text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
          >
            {taskTotalSec > 0 && (
              <span>{formatChronoMMSS(taskTotalSec).formatted}</span>
            )}
            <Play className="h-3.5 w-3.5 fill-current" />
          </button>
        </div>

        <RowDeleteButton onConfirm={deleteThisTask} />
      </div>
    </div>
  );
}

function QueueTaskRow({
  task,
  quest,
  isTopTask,
  isCurrentlyActive,
  liveSeconds,
  isCompleting,
  isExpanded,
  isDragOver,
  activeQuests,
  expandedToggleRef,
  reorderHandlers,
  onComplete,
  onToggleExpanded,
  onCloseDrawer,
}: QueueTaskRowProps) {
  const { startFocus, deleteThisTask } = useTaskRowActions(task.id);
  const { isRunning, suspendTimer, updateTask } = useCommandStore(
    useShallow((s) => ({
      isRunning: s.isRunning,
      suspendTimer: s.suspendTimer,
      updateTask: s.updateTask,
    }))
  );
  const style = accentStyle(quest?.accentColor ?? "cyan");
  const taskTotalSec =
    (task.accumulatedSeconds || 0) + (isCurrentlyActive ? liveSeconds : 0);

  return (
    <div
      data-testid="task-row"
      data-task-id={task.id}
      {...reorderHandlers}
      // Not draggable while the notes drawer is open, so selecting
      // text or placing the caret in the notes field never starts a drag.
      draggable={!isExpanded}
      className={`group relative overflow-hidden rounded-2xl border transition-colors duration-200 ${
        isExpanded ? "" : "cursor-grab active:cursor-grabbing "
      }${
        isDragOver
          ? "border-white/40 bg-raised"
          : isTopTask
          ? "border-accent/35 bg-surface shadow-card-accent"
          : "border-white/[0.08] bg-surface hover:border-white/[0.15]"
      }`}
    >
      {/* Left Rounded Vertical Accent Bar (Quest.app signature detail) */}
      <div
        className={`absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full ${style.bg}`}
      />

      <div className="p-5 pl-6">
        {/* Task Title */}
        <button
          type="button"
          data-task-title="true"
          onClick={startFocus}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          className="block w-full cursor-pointer break-words [text-wrap:pretty] text-left text-base font-medium leading-snug text-white hover:text-accent transition-colors duration-150 ease-out active:opacity-80"
        >
          {task.title}
        </button>

        {!isExpanded && task.notes && <TaskNotesPreview notes={task.notes} />}

        {/* Bottom Metadata & Action Row */}
        <div className="mt-3.5 flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {/* Circular Complete Check Button */}
            <button
              type="button"
              onClick={(e) => {
                // The second click of a double-click would hit
                // the next row, which slides up under the cursor.
                if (e.detail > 1) return;
                onComplete(task.id);
              }}
              title="Mark complete"
              aria-label="Mark complete"
              className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border before:absolute before:-inset-3 before:content-[''] transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-90 active:opacity-80 ${
                isCompleting
                  ? `${style.bg} border-transparent text-black`
                  : "border-white/40 text-transparent hover:border-success hover:text-success"
              }`}
            >
              <Check className="h-3 w-3" />
            </button>

            {/* Rounded Quest Pill */}
            {quest && (
              <span className="flex min-w-0 max-w-full sm:max-w-[250px] items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-neutral-300">
                <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
                <span className="truncate" title={quest.title}>
                  {quest.title}
                </span>
              </span>
            )}

            {task.habitId && <DailyHabitBadge />}
            {hasReminderSlot(task) && task.reminderTime && <ReminderBadge time={task.reminderTime} />}

            {/* Timer / Play Button */}
            {isCurrentlyActive && isRunning ? (
              <button
                type="button"
                onClick={() => {
                  hudAudio.playClick();
                  suspendTimer();
                }}
                aria-label={`Pause focus: ${task.title}`}
                className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full px-2.5 py-1 font-mono text-xs tabular-nums text-success hover:bg-white/[0.05] transition-colors duration-150 ease-out active:opacity-80"
              >
                <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
                <span>{formatChronoMMSS(taskTotalSec).formatted}</span>
                <Pause className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={startFocus}
                aria-label={`Start focus: ${task.title}`}
                className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full px-2.5 py-1 font-mono text-xs tabular-nums text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
              >
                {taskTotalSec > 0 && (
                  <span>{formatChronoMMSS(taskTotalSec).formatted}</span>
                )}
                <Play className="h-3.5 w-3.5 fill-current" />
              </button>
            )}
          </div>

          {/* Right Side Notes / Options Icon */}
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              ref={isExpanded ? expandedToggleRef : undefined}
              onClick={onToggleExpanded}
              title="Task notes & options"
              aria-expanded={isExpanded}
              className={`-m-0.5 rounded-lg p-2 coarse:p-3 transition-colors duration-150 ease-out active:opacity-80 ${
                task.notes || isExpanded
                  ? "text-neutral-300 hover:text-white"
                  : "text-hud-muted opacity-0 hoverless:opacity-60 group-hover:opacity-100 focus-visible:opacity-100 hover:text-neutral-300"
              }`}
            >
              <AlignLeft className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Inline Notes & Options Drawer */}
      <HeightReveal show={isExpanded}>
        <div
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onCloseDrawer();
            }
          }}
          // cursor-auto: the row's grab cursor is inherited, and
          // the notes field should keep its text cursor.
          className="cursor-auto border-t border-white/[0.06] bg-sunken px-6 py-4 space-y-3"
        >
          <TaskNotesField
            key={task.id}
            taskId={task.id}
            notes={task.notes}
            rows={2}
            placeholder="Add session notes..."
            aria-label={`Notes for ${task.title}`}
            className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-accent/50 focus:outline-none"
          />

          {hasReminderSlot(task) && (
            <TaskReminderField taskId={task.id} taskTitle={task.title} reminderTime={task.reminderTime} />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {activeQuests.map((q) => {
                const qStyle = accentStyle(q.accentColor);
                const isCurrentQuest = task.questId === q.id;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => updateTask(task.id, { questId: q.id })}
                    aria-pressed={isCurrentQuest}
                    className={`flex min-h-8 coarse:min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 transition-colors duration-150 ease-out active:opacity-80 ${
                      isCurrentQuest
                        ? "border-white/25 bg-white/10 text-white"
                        : "border-transparent text-hud-muted hover:text-neutral-300"
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${qStyle.bg}`}
                    />
                    <span className="truncate" title={q.title}>
                      {q.title}
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => updateTask(task.id, { questId: null })}
                className="min-h-8 coarse:min-h-11 rounded-full px-3 py-1.5 text-hud-muted hover:text-neutral-300 transition-colors duration-150 ease-out active:opacity-80"
              >
                Move to Other
              </button>
            </div>

            <ConfirmDeleteButton
              label="Delete task"
              onConfirm={deleteThisTask}
              className="-my-1.5 -mr-2 flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg px-2.5 py-1.5 text-hud-muted hover:bg-danger/10 hover:text-danger"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Delete</span>
            </ConfirmDeleteButton>
          </div>
        </div>
      </HeightReveal>
    </div>
  );
}

function CompletedTaskRow({
  task,
  quest,
  isJustCompleted,
}: CompletedTaskRowProps) {
  const { deleteThisTask } = useTaskRowActions(task.id);
  const reopenTaskById = useCommandStore((s) => s.reopenTaskById);
  const style = accentStyle(quest?.accentColor ?? "slate");
  const questLabel = quest ? quest.title : "Other work";

  // Only the accent bar and the check are dimmed (the card used
  // to be, which took the title below AA contrast). While settling
  // in (`isJustCompleted`), the card uses a solid elevated surface
  // (`z-10 bg-surface`, below the sticky notice) with a subtle emerald border highlight.
  return (
    <div
      data-testid="completed-task-row"
      data-task-id={task.id}
      className={`group relative overflow-hidden rounded-2xl border p-5 pl-6 transition-[border-color,background-color,box-shadow] duration-500 ease-out ${
        isJustCompleted
          ? SETTLING_COMPLETED_CARD_CLASS
          : "border-white/[0.05] bg-sunken/60"
      }`}
    >
      <div
        className={`absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full ${style.bg} opacity-40 transition-opacity duration-150 ease-out group-hover:opacity-60`}
      />

      <div className="break-words text-base text-hud-muted line-through">
        {task.title}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 sm:gap-3">
          <button
            type="button"
            onClick={() => {
              hudAudio.playClick();
              reopenTaskById(task.id);
            }}
            title="Reopen task"
            aria-label="Reopen task"
            className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-3 before:content-[''] ${reopenDotBgClass(style)} text-black opacity-65 transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-90 group-hover:opacity-95 focus-visible:opacity-100`}
          >
            {isJustCompleted ? (
              <motion.span
                initial={{ scale: 0.72 }}
                animate={{ scale: [0.72, 1.16, 1] }}
                transition={{
                  duration: 0.26,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="flex items-center justify-center"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="h-3 w-3"
                >
                  <motion.path
                    d="M20 6 9 17l-5-5"
                    strokeDasharray={24}
                    initial={{ strokeDashoffset: 24 }}
                    animate={{ strokeDashoffset: 0 }}
                    transition={{
                      duration: 0.22,
                      ease: [0.22, 1, 0.36, 1],
                    }}
                  />
                </svg>
              </motion.span>
            ) : (
              <Check className="h-3 w-3 stroke-[2.5]" />
            )}
          </button>

          <span className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1 text-xs text-neutral-400">
            <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
            <span className="truncate" title={questLabel}>
              {questLabel}
            </span>
          </span>

          {task.accumulatedSeconds > 0 && (
            <span className="shrink-0 font-mono text-xs tabular-nums text-hud-muted">
              {formatChronoMMSS(task.accumulatedSeconds).formatted}
            </span>
          )}
        </div>

        <RowDeleteButton onConfirm={deleteThisTask} />
      </div>
    </div>
  );
}
