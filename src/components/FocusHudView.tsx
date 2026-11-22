"use client";

import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { Play, Pause, Check, ArrowLeft, X } from "lucide-react";
import { formatChronoMMSS } from "@/lib/dateUtils";
import { accentStyle } from "@/lib/questAccents";
import { pickNextFocusTask, useCommandStore } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
import { DesktopWindowControls } from "./DesktopWindowControls";
import { TaskNotesField } from "./TaskNotesField";
import { useTodayDateKey } from "./useTodayDateKey";

/**
 * Space inside these keeps its native meaning (activate the focused control,
 * type a space) instead of toggling the timer.
 */
const NATIVE_SPACE_TARGETS =
  'button, a, input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function FocusHudView() {
  const {
    activeTaskId,
    isRunning,
    sessionStartedAt,
    lastCompletedFeedback,
    clearFeedback,
    initializeFocus,
    engageTimer,
    suspendTimer,
    completeActiveTask,
    returnToQueue,
  } = useCommandStore(
    useShallow((s) => ({
      activeTaskId: s.activeTaskId,
      isRunning: s.isRunning,
      sessionStartedAt: s.sessionStartedAt,
      lastCompletedFeedback: s.lastCompletedFeedback,
      clearFeedback: s.clearFeedback,
      initializeFocus: s.initializeFocus,
      engageTimer: s.engageTimer,
      suspendTimer: s.suspendTimer,
      completeActiveTask: s.completeActiveTask,
      returnToQueue: s.returnToQueue,
    }))
  );

  // undefined = still loading. While it re-reads for a new activeTaskId,
  // useLiveQuery keeps the previous result; `forId` tells the two apart.
  const focusRead = useLiveQuery(
    async () => ({
      forId: activeTaskId,
      task: (await reads.task(activeTaskId)) ?? null,
    }),
    [activeTaskId]
  );
  // undefined = still loading, null = no focused task.
  const activeTask = focusRead?.task;

  const linkedQuest = useLiveQuery(
    () => reads.quest(activeTask?.questId),
    [activeTask?.questId]
  );

  // Recomputed when the day changes (the view can stay open past midnight).
  const todayKey = useTodayDateKey();
  // undefined = still loading, null = nothing queued for today.
  const topQueuedTask = useLiveQuery(
    async () =>
      pickNextFocusTask(
        await reads.queuedTasks(),
        todayKey
      ),
    [todayKey]
  );

  const topQueuedQuest = useLiveQuery(
    () => reads.quest(topQueuedTask?.questId),
    [topQueuedTask?.questId]
  );

  const [liveDeltaSeconds, setLiveDeltaSeconds] = useState(0);
  // Task whose (still empty) notes field was opened; keeps the field mounted
  // while its text is cleared, and resets when focus moves to another task.
  const [notesOpenForTaskId, setNotesOpenForTaskId] = useState<string | null>(
    null
  );
  // Set synchronously by Complete: clicks that arrive before React re-renders
  // (or while the next task is being started) must not complete it as well.
  const completingRef = useRef(false);
  const [completing, setCompleting] = useState(false);

  useEffect(() => {
    if (!isRunning || !sessionStartedAt) {
      setLiveDeltaSeconds(0);
      return;
    }

    const update = () => {
      const elapsedMs = Math.max(0, Date.now() - sessionStartedAt);
      setLiveDeltaSeconds(Math.floor(elapsedMs / 1000));
    };

    update();
    // No re-renders while the window is hidden; catch up when it shows again.
    const interval = setInterval(() => {
      if (!document.hidden) update();
    }, 500);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
    };
  }, [isRunning, sessionStartedAt]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !activeTaskId) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target;
      if (target instanceof Element && target.closest(NATIVE_SPACE_TARGETS)) {
        return;
      }
      e.preventDefault();
      // A held Space repeats keydowns; only the first press toggles.
      if (e.repeat) return;
      hudAudio.playClick();
      if (isRunning) {
        suspendTimer();
      } else {
        engageTimer();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTaskId, isRunning, engageTimer, suspendTimer]);

  // The store may already focus the next task while the view still shows the
  // completed one (the live query has not caught up yet).
  const showsFocusedTask = !!activeTask && activeTask.id === activeTaskId;

  const handleComplete = (e: React.MouseEvent<HTMLButtonElement>) => {
    // detail > 1: the second click of a double-click would land on the next
    // task, which starts under the same button.
    if (e.detail > 1 || completingRef.current || !showsFocusedTask) return;
    completingRef.current = true;
    setCompleting(true);
    hudAudio.playComplete();
    // The store action never rejects (failures surface through actionError).
    void completeActiveTask().finally(() => {
      completingRef.current = false;
      setCompleting(false);
    });
  };

  // No focused task to show: wait for the queue, and for the store's new
  // focus (just started) instead of offering the queue it was taken from.
  const loading =
    activeTask === undefined ||
    (activeTask === null &&
      (focusRead?.forId !== activeTaskId || topQueuedTask === undefined));

  if (loading) {
    // Same container as the idle screen, without copy that may not be true yet.
    return (
      <div
        aria-busy="true"
        className="flex min-h-screen min-h-[100dvh] flex-col items-center justify-center bg-[#0b0c0e] px-6 text-center"
      />
    );
  }

  if (!activeTask) {
    const nextQuestStyle = accentStyle(
      topQueuedQuest ? topQueuedQuest.accentColor : "slate"
    );
    return (
      <div className="focus-stage-shell mx-auto flex min-h-screen min-h-[100dvh] w-full max-w-[1440px] flex-col bg-[#0b0c0e] px-4 py-6 sm:px-14 sm:py-10 text-center">
        <div className="flex w-full items-center justify-end">
          <DesktopWindowControls />
        </div>

        <div className="my-auto flex flex-col items-center justify-center">
        <div role="status" aria-live="polite" className="w-full max-w-lg">
          {lastCompletedFeedback && (
            <div className="mb-8 flex items-center justify-between gap-3 rounded-xl border border-[#00ff9d]/30 bg-[#00ff9d]/10 px-4 py-3 text-left text-xs text-[#00ff9d]">
              <span className="min-w-0 break-words">
                Completed{" "}
                <strong className="font-semibold text-white">
                  {lastCompletedFeedback.taskTitle}
                </strong>{" "}
                ·{" "}
                <span className="font-mono tabular-nums">
                  {formatChronoMMSS(lastCompletedFeedback.loggedSeconds).formatted}
                </span>{" "}
                logged
              </span>
              <button
                type="button"
                onClick={clearFeedback}
                aria-label="Dismiss"
                className="-my-1.5 -mr-2 shrink-0 rounded-lg p-1.5 coarse:p-2.5 text-neutral-400 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-white active:opacity-80"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <p className="text-xs font-medium uppercase tracking-[0.2em] text-hud-muted">
          {lastCompletedFeedback && topQueuedTask ? "Up Next" : "Focus Mode"}
        </p>

        {topQueuedTask ? (
          <div className="mt-5 flex w-full max-w-2xl flex-col items-center space-y-6">
            {topQueuedQuest && (
              <div
                className={`flex max-w-full items-center gap-2 rounded-full border ${nextQuestStyle.border} bg-white/[0.02] px-3.5 py-1 text-xs text-neutral-200`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${nextQuestStyle.bg}`}
                />
                <span className="truncate" title={topQueuedQuest.title}>
                  {topQueuedQuest.title}
                </span>
              </div>
            )}
            <h2 className="break-words [text-wrap:balance] text-2xl font-medium leading-snug text-white sm:text-3xl">
              {topQueuedTask.title}
            </h2>
            <button
              type="button"
              onClick={() => {
                hudAudio.playLockOn();
                initializeFocus(topQueuedTask.id);
              }}
              className="rounded-xl border border-white/15 bg-white/[0.06] px-7 py-3.5 text-sm font-medium text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out hover:bg-white/[0.12] active:scale-[0.98]"
            >
              Start Focus Session
            </button>
          </div>
        ) : (
          <p className="mt-4 text-base text-neutral-400">
            All tasks completed for today.
          </p>
        )}

        <button
          type="button"
          onClick={() => returnToQueue()}
          className="mt-8 rounded-lg px-3 py-2 coarse:py-3 text-sm text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.04] hover:text-neutral-300 active:opacity-80"
        >
          ← Back to Home
        </button>
        </div>
      </div>
    );
  }

  const totalElapsedSeconds =
    (activeTask.accumulatedSeconds || 0) + liveDeltaSeconds;
  const chrono = formatChronoMMSS(totalElapsedSeconds);
  const style = accentStyle(linkedQuest ? linkedQuest.accentColor : "slate");
  const questLabel = linkedQuest ? linkedQuest.title : "Other work";
  const topBarLabel = `Focus · ${linkedQuest ? linkedQuest.title : "Other Work"}`;

  return (
    <div className="focus-stage-shell mx-auto flex min-h-screen min-h-[100dvh] w-full max-w-[1440px] flex-col justify-between bg-[#0b0c0e] px-4 py-6 sm:px-14 sm:py-10">
      {/* Top Bar: "● FOCUS · QUEST NAME" on Left, "←" Back Arrow on Right */}
      <div className="flex w-full items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5 text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
          <span className="truncate" title={topBarLabel}>
            {topBarLabel}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => {
              hudAudio.playClick();
              returnToQueue();
            }}
            title="Return to Home"
            aria-label="Return to Home"
            className="shrink-0 rounded-lg p-2 coarse:p-3 text-neutral-400 hover:bg-white/[0.05] hover:text-white transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <span
            aria-hidden="true"
            className="hidden sm:block h-5 w-px bg-white/[0.08]"
          />

          <DesktopWindowControls />
        </div>
      </div>

      {/* Center Focus Stage (Quest.app Focus Screen) */}
      <motion.div
        key={activeTask.id}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="mx-auto my-auto flex w-full max-w-3xl flex-col items-center text-center"
      >
        {/* Quest Pill */}
        <div
          className={`flex max-w-full items-center gap-2.5 rounded-full border ${style.border} bg-white/[0.02] px-4 py-1.5 text-xs text-neutral-200`}
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
          <span className="truncate" title={questLabel}>
            {questLabel}
          </span>
        </div>

        {/* Active Task Title */}
        <h1 className="mt-4 sm:mt-6 w-full max-w-2xl break-words [text-wrap:balance] text-[clamp(1.35rem,2.4vw+0.8rem,2.25rem)] font-normal leading-snug text-white">
          {activeTask.title}
        </h1>

        {/* Giant Tabular-Nums Timer */}
        <div
          data-testid="focus-timer"
          className="focus-fluid-chrono my-6 sm:my-8 max-w-full select-none font-sans text-7xl font-medium leading-none tracking-tight text-white tabular-nums sm:text-[8.5rem] md:text-[9.5rem]"
        >
          {chrono.formatted}
        </div>

        {/* RUNNING / PAUSED Status Label */}
        <div className="focus-status-label mb-8 sm:mb-10 text-xs font-medium uppercase tracking-[0.22em] text-hud-muted">
          {isRunning ? "Running" : "Paused"}
        </div>

        {/* Two Clean Outlined Controls: [ ⏸ Pause ]  [ ✓ Complete ] */}
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
          {isRunning ? (
            <button
              type="button"
              onClick={() => {
                hudAudio.playClick();
                suspendTimer();
              }}
              className="flex min-w-[128px] sm:min-w-[136px] items-center justify-center gap-2.5 rounded-xl border border-white/15 bg-white/[0.03] px-5 sm:px-6 py-3 sm:py-3.5 text-sm font-medium text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out hover:border-white/25 hover:bg-white/[0.07] active:scale-[0.98]"
            >
              <Pause className="h-4 w-4" />
              <span>Pause</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                hudAudio.playLockOn();
                engageTimer();
              }}
              className="flex min-w-[128px] sm:min-w-[136px] items-center justify-center gap-2.5 rounded-xl border border-white/25 bg-white/[0.08] px-5 sm:px-6 py-3 sm:py-3.5 text-sm font-medium text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out hover:bg-white/[0.14] active:scale-[0.98]"
            >
              <Play className="h-4 w-4 fill-current" />
              <span>Resume</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleComplete}
            disabled={completing || !showsFocusedTask}
            aria-busy={completing || !showsFocusedTask}
            className="flex min-w-[136px] sm:min-w-[148px] items-center justify-center gap-2.5 rounded-xl border border-white/15 bg-white/[0.03] px-5 sm:px-6 py-3 sm:py-3.5 text-sm font-medium text-white transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out hover:border-[#00ff9d]/50 hover:bg-[#00ff9d]/10 active:scale-[0.98] disabled:cursor-wait disabled:opacity-60"
          >
            <Check className="h-4 w-4" />
            <span>Complete</span>
          </button>
        </div>

        {/* Optional Notes */}
        <div className="focus-notes-wrap mt-8 sm:mt-12 w-full max-w-md">
          {activeTask.notes || notesOpenForTaskId === activeTask.id ? (
            <TaskNotesField
              key={activeTask.id}
              taskId={activeTask.id}
              notes={activeTask.notes}
              rows={3}
              autoFocus={
                notesOpenForTaskId === activeTask.id && !activeTask.notes
              }
              onFocus={() => setNotesOpenForTaskId(activeTask.id)}
              placeholder="Session notes..."
              aria-label="Session notes"
              className="w-full resize-none rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5 text-center text-xs leading-relaxed text-neutral-300 placeholder:text-hud-muted focus:border-hud-cyan focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setNotesOpenForTaskId(activeTask.id)}
              className="-my-2 rounded-lg px-3 py-2 coarse:py-3 text-xs text-hud-muted transition-colors hover:bg-white/[0.04] hover:text-neutral-300 active:opacity-80"
            >
              + Add notes
            </button>
          )}
        </div>
      </motion.div>

      {/* Bottom Spacer / Subtle Keyboard Hint */}
      <div className="text-center text-xs text-hud-muted">
        Press Space to pause or resume
      </div>
    </div>
  );
}
