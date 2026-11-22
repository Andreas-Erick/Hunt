"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { motion, AnimatePresence } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import {
  Play,
  Pause,
  Check,
  ArrowUpToLine,
  ArrowDownToLine,
  AlignLeft,
  Trash2,
  Repeat,
} from "lucide-react";
import {
  accentStyle,
  dateFromKey,
  formatChronoMMSS,
  isTaskVisibleToday,
  toLocalDateKey,
  type Task,
  type Quest,
} from "@/lib/db";
import {
  formatTelemetryDuration,
  layoutTimelineBlocks,
} from "@/lib/reviewAnalytics";
import { orderAfterDrop, useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import {
  COMPLETION_HIGHLIGHT_MS,
  SETTLING_COMPLETED_CARD_CLASS,
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
  reopenDotBgClass,
  type TaskCompletionScene,
} from "@/lib/taskCompletionMotion";
import { TaskNotesField } from "./TaskNotesField";
import { ConfirmDeleteButton, ROW_DELETE_CLASS } from "./ConfirmDeleteButton";
import { useTransientHighlight } from "./useTransientHighlight";
import { useQuestWeekLogs } from "./useQuestWeekLogs";
import { computeQuestWeekProgress } from "@/lib/questProgress";

/** Clock tick while a timer runs (drives the live counters). */
const RUNNING_TICK_MS = 1000;
/** Clock tick otherwise: enough for the date and the timeline's "now" line. */
const IDLE_TICK_MS = 60_000;
/** Calendar days in the week KPI, today included. */

/** Elements where Alt+Arrow keys belong to text editing, not to reordering. */
function isTextEntryTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

export function CommandCenterView() {
  const {
    activeTaskId,
    isRunning,
    sessionStartedAt,
    initializeFocus,
    suspendTimer,
    createTask,
    updateTask,
    deleteTask,
    completeTaskById,
    reopenTaskById,
    reorderTaskQueue,
    materializeDailyHabits,
    lastCompletedFeedback,
    clearFeedback,
    setActiveView,
  } = useCommandStore(
    useShallow((s) => ({
      activeTaskId: s.activeTaskId,
      isRunning: s.isRunning,
      sessionStartedAt: s.sessionStartedAt,
      initializeFocus: s.initializeFocus,
      suspendTimer: s.suspendTimer,
      createTask: s.createTask,
      updateTask: s.updateTask,
      deleteTask: s.deleteTask,
      completeTaskById: s.completeTaskById,
      reopenTaskById: s.reopenTaskById,
      reorderTaskQueue: s.reorderTaskQueue,
      materializeDailyHabits: s.materializeDailyHabits,
      lastCompletedFeedback: s.lastCompletedFeedback,
      clearFeedback: s.clearFeedback,
      setActiveView: s.setActiveView,
    }))
  );

  const quests = useLiveQuery(reads.quests, []);

  const allTasks = useLiveQuery(reads.allTasks, []);

  // Input State
  const [newTitle, setNewTitle] = useState("");
  const [newNotes, setNewNotes] = useState("");
  // Set synchronously by the first add; drops activations that arrive before
  // React re-renders with the cleared input.
  const addingRef = useRef(false);
  // Explicit quest choice for new tasks: undefined = default (first quest),
  // null = Other work.
  const [questChoice, setQuestChoice] = useState<string | null | undefined>(
    undefined
  );
  const [filterQuestId, setFilterQuestId] = useState<string | "ALL">("ALL");

  // Drag & Drop State
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);

  // Keyboard reorder (Alt+↑/↓): one move at a time.
  const keyboardMoveRef = useRef(false);

  // Expanded Task ID (for notes / quest change)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Notes toggle of the expanded task; Escape in the drawer returns focus here.
  const expandedToggleRef = useRef<HTMLButtonElement | null>(null);

  // Recently completed task id for tactile arrival highlight & checkmark draw
  const [justCompletedId, flashJustCompleted] = useTransientHighlight(
    COMPLETION_HIGHLIGHT_MS
  );

  // Live session delta for active task & timeline
  const [liveDelta, setLiveDelta] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 1 s tick only while a timer runs; otherwise once a minute. Ticks are
  // skipped while the window is hidden and caught up when it becomes visible.
  useEffect(() => {
    const running = isRunning && sessionStartedAt !== null;
    const tick = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const current = Date.now();
      setNowMs(current);
      setLiveDelta(
        running && sessionStartedAt !== null
          ? Math.max(0, Math.floor((current - sessionStartedAt) / 1000))
          : 0
      );
    };
    tick();
    const id = setInterval(tick, running ? RUNNING_TICK_MS : IDLE_TICK_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [isRunning, sessionStartedAt]);

  const questMap = React.useMemo(() => {
    const map = new Map<string, Quest>();
    quests?.forEach((q) => map.set(q.id, q));
    return map;
  }, [quests]);

  const activeQuests = React.useMemo(
    () => (quests ?? []).filter((q) => !q.archived),
    [quests]
  );

  const activeQuestMap = React.useMemo(() => {
    const map = new Map<string, Quest>();
    activeQuests.forEach((q) => map.set(q.id, q));
    return map;
  }, [activeQuests]);

  // Default quest for new tasks = first active quest (never a hardcoded,
  // completed or deleted id); an explicit pick sticks while that quest is active.
  const selectedQuestId: string | null =
    questChoice === null
      ? null
      : questChoice !== undefined && activeQuestMap.has(questChoice)
      ? questChoice
      : activeQuests[0]?.id ?? null;
  const otherWorkSelected = quests !== undefined && selectedQuestId === null;

  const effectiveFilterQuestId =
    filterQuestId === "ALL" || activeQuestMap.has(filterQuestId)
      ? filterQuestId
      : "ALL";

  const todayKey = toLocalDateKey(nowMs);

  // Materialize daily habits whenever Home mounts or the local day rolls over.
  useEffect(() => {
    void materializeDailyHabits(todayKey);
  }, [materializeDailyHabits, todayKey]);

  const weekLogs = useQuestWeekLogs(todayKey);

  // Active & Queued tasks for today (or overdue regular tasks / unscheduled),
  // sorted by rank (ties by id, as on the phone). Future-scheduled tasks belong
  // to Plan the week, and missed daily habits from past days never pile up.
  const pendingTasks = React.useMemo(() => {
    const list = (allTasks ?? [])
      .filter(
        (t) =>
          (t.status === "queued" || t.status === "active") &&
          isTaskVisibleToday(t, todayKey)
      )
      .sort(compareRank);
    if (effectiveFilterQuestId === "ALL") return list;
    return list.filter((t) => t.questId === effectiveFilterQuestId);
  }, [allTasks, effectiveFilterQuestId, todayKey]);

  const questQueue = React.useMemo(
    () => pendingTasks.filter((t) => t.questId !== null),
    [pendingTasks]
  );

  const maintenanceQueue = React.useMemo(
    () => pendingTasks.filter((t) => t.questId === null),
    [pendingTasks]
  );

  // Completed tasks (most recent 4)
  const completedTasks = React.useMemo(() => {
    return (allTasks ?? [])
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 4);
  }, [allTasks]);

  // Today's & Weekly Quest Hours
  const activeTaskObj = React.useMemo(
    () => (allTasks ?? []).find((t) => t.id === activeTaskId),
    [allTasks, activeTaskId]
  );

  const liveBurst = React.useMemo(
    () =>
      activeTaskObj && liveDelta > 0
        ? { questId: activeTaskObj.questId, seconds: liveDelta }
        : null,
    [activeTaskObj, liveDelta]
  );
  const questWeek = React.useMemo(
    () =>
      computeQuestWeekProgress({
        quests: activeQuests,
        logs: weekLogs ?? [],
        todayKey,
        live: liveBurst,
      }).total,
    [activeQuests, weekLogs, todayKey, liveBurst]
  );
  const todayQuestSeconds = questWeek.todaySeconds;
  const weekQuestSeconds = questWeek.weekSeconds;
  const totalWeeklyTargetHours = questWeek.targetHours;
  const weeklyProgressPct = questWeek.pct;

  // '–' instead of a misleading 0.0h until the logs and targets have loaded.
  const kpisLoading = weekLogs === undefined || quests === undefined;

  // Formatted Today Date ("Wednesday, November 18")
  const formattedToday = React.useMemo(() => {
    return dateFromKey(todayKey).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [todayKey]);

  const taskFlowRef = useRef<HTMLDivElement>(null);
  const pendingSceneRef = useRef<TaskCompletionScene | null>(null);

  const handleCompleteTask = (taskId: string) => {
    const task = allTasks?.find((t) => t.id === taskId);
    const quest = task?.questId ? questMap.get(task.questId) : undefined;
    const accentHex = accentStyle(quest?.accentColor ?? "emerald").hex;
    pendingSceneRef.current = captureTaskCompletionScene(
      taskFlowRef.current,
      taskId,
      accentHex
    );
    setExpandedTaskId((cur) => (cur === taskId ? null : cur));
    flashJustCompleted(taskId);
    hudAudio.playComplete();
    void completeTaskById(taskId);
  };

  useLayoutEffect(() => {
    const scene = pendingSceneRef.current;
    if (!scene) return;
    if (!completedTasks.some((t) => t.id === scene.taskId)) return;
    pendingSceneRef.current = null;
    return playTwoBeatTaskCompletion(taskFlowRef.current, scene);
  }, [completedTasks]);

  const handleAdd = async (promoteToTop: boolean) => {
    const title = newTitle.trim();
    const rawNotes = newNotes;
    const trimmedNotes = rawNotes.trim();
    // The input is cleared before the write, so a double click or a repeated
    // Enter cannot create the task twice.
    if (!title || addingRef.current) return;
    addingRef.current = true;
    setNewTitle("");
    setNewNotes("");
    hudAudio.playClick();
    let created = false;
    try {
      // Resolves false when the local write failed (the store reports it).
      created = await createTask({
        title,
        questId: selectedQuestId,
        promoteToTop,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } finally {
      addingRef.current = false;
      // Give the title & description back unless something new was typed meanwhile.
      if (!created) {
        setNewTitle((current) => (current === "" ? title : current));
        setNewNotes((current) => (current === "" ? rawNotes : current));
      }
    }
  };

  /**
   * Moves `movedId` next to `targetId` (before it when moving up in `list`,
   * after it when moving down) in the GLOBAL rank order. Nothing else moves, so
   * exactly one row is rewritten (rows the user did not move keep their
   * updatedAt and cannot revert edits made on the phone).
   */
  const moveTaskNextTo = async (
    movedId: string,
    targetId: string,
    list: Task[]
  ): Promise<void> => {
    if (!allTasks) return;
    const allPending = allTasks
      .filter((t) => t.status === "queued" || t.status === "active")
      .sort(compareRank)
      .map((t) => t.id);
    const finalOrder = orderAfterDrop(
      allPending,
      list.map((t) => t.id),
      movedId,
      targetId
    );
    if (!finalOrder) return;
    // The store reports its own failures and resolves; this only keeps the
    // fire-and-forget keyboard and drop handlers free of unhandled rejections.
    try {
      await reorderTaskQueue(finalOrder, movedId);
    } catch (err) {
      console.error("[hunt] action_failed", "reorderTaskQueue", err);
    }
  };

  const handleDropOnTask = async (targetTaskId: string, targetList: Task[]) => {
    if (!draggedTaskId || draggedTaskId === targetTaskId || !allTasks) {
      setDraggedTaskId(null);
      setDragOverTaskId(null);
      return;
    }

    hudAudio.playClick();
    await moveTaskNextTo(draggedTaskId, targetTaskId, targetList);

    setDraggedTaskId(null);
    setDragOverTaskId(null);
  };

  /**
   * Alt+ArrowUp / Alt+ArrowDown anywhere in a quest row (it bubbles up from the
   * row's buttons) swaps the task with its visible neighbour, the keyboard
   * equivalent of dropping it there. Held keys (repeat) and the list ends do
   * nothing; text fields keep their own Alt+Arrow behaviour.
   */
  const handleQueueRowKeyDown = async (
    e: React.KeyboardEvent<HTMLElement>,
    taskId: string
  ) => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (step === 0 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isTextEntryTarget(e.target)) return;
    e.preventDefault();
    if (e.repeat || keyboardMoveRef.current) return;

    const index = questQueue.findIndex((t) => t.id === taskId);
    const neighbour = index === -1 ? undefined : questQueue[index + step];
    if (!neighbour) return;

    // React DOM gives focus back to the pressed control after it moves the
    // row, so the next press works without refocusing.
    keyboardMoveRef.current = true;
    hudAudio.playClick();
    try {
      await moveTaskNextTo(taskId, neighbour.id, questQueue);
    } finally {
      keyboardMoveRef.current = false;
    }
  };

  // Today's Timeline Logs (default 08:00–22:00, dynamically expanding for early/late sessions)
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
    if (activeTaskObj && isRunning && sessionStartedAt) {
      items.push({
        id: "__live_running__",
        startTime: sessionStartedAt,
        durationSeconds: Math.max(60, liveDelta),
      });
    }
    return layoutTimelineBlocks(items, 8, 22);
  }, [todayLogs, activeTaskObj, isRunning, sessionStartedAt, liveDelta]);

  const timelineHours = timelineLayout.hours;
  const TIMELINE_START_HOUR = timelineLayout.windowStartHour;
  const TIMELINE_END_HOUR = timelineLayout.windowEndHour;
  const HOUR_HEIGHT_PX = 52;

  const currentHourFloat = React.useMemo(() => {
    const d = new Date(nowMs);
    return d.getHours() + d.getMinutes() / 60;
  }, [nowMs]);

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      {/* Subtle Completion Banner (the live region stays mounted so the
          message is announced when it appears) */}
      <div role="status" aria-live="polite" className="overflow-hidden">
        <AnimatePresence initial={false}>
          {lastCompletedFeedback && (
            <motion.div
              initial={{ opacity: 0, height: 0, marginBottom: 0 }}
              animate={{ opacity: 1, height: "auto", marginBottom: 32 }}
              exit={{ opacity: 0, height: 0, marginBottom: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="flex items-center justify-between gap-3 rounded-xl border border-[#00ff9d]/30 bg-[#00ff9d]/10 px-5 py-3.5 text-sm text-[#00ff9d]"
            >
              <span className="min-w-0 break-words">
                Completed{" "}
                <strong className="font-semibold text-white">
                  {lastCompletedFeedback.taskTitle}
                </strong>{" "}
                · {formatChronoMMSS(lastCompletedFeedback.loggedSeconds).formatted}{" "}
                logged
              </span>
              <button
                type="button"
                onClick={clearFeedback}
                aria-label="Dismiss"
                className="-my-1.5 -mr-2 shrink-0 rounded-lg px-2.5 py-1.5 text-base leading-none text-neutral-400 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-white active:opacity-80"
              >
                ×
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ================================================================= */}
      {/* HEADER ROW: Big Date on Left, Today & Weekly Progress on Right    */}
      {/* ================================================================= */}
      <div className="mb-10 sm:mb-12 flex flex-col justify-between gap-4 sm:gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium leading-tight tracking-tight text-white">
            {formattedToday}
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-baseline gap-2">
            <span className="text-2xl sm:text-3xl font-medium tracking-tight text-white tabular-nums">
              {kpisLoading
                ? "–"
                : formatTelemetryDuration(todayQuestSeconds, { zeroAs: "0.0h" })}
            </span>
            <span className="text-sm text-hud-muted">today</span>
          </div>

          <div className="w-32 sm:w-44">
            <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.08]">
              {/* Full-width fill slid in from the left (compositor-only); the
                  track's overflow-hidden clips it, keeping the rounded end. */}
              <div
                data-testid="week-progress-fill"
                className="h-full w-full rounded-full bg-[#00f0ff] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                style={{ transform: `translateX(${weeklyProgressPct - 100}%)` }}
              />
            </div>
            <div className="mt-1.5 text-right text-xs text-hud-muted tabular-nums">
              {kpisLoading
                ? "–"
                : `${formatTelemetryDuration(weekQuestSeconds, { zeroAs: "0.0h" })} / ${totalWeeklyTargetHours}h`}{" "}
              this week
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* TWO-COLUMN SPACIOUS WORKSPACE: Tasks (Left) + Day Timeline (Right)*/}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-12 xl:gap-14 items-start">
        {/* LEFT COLUMN (7 cols): QUEST WORK QUEUE */}
        <div className="min-w-0 lg:col-span-7 space-y-6">
          {/* Section Header + Quest Filter */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-400">
              Quest Work
            </span>

            <div
              role="group"
              aria-label="Filter by quest"
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <button
                type="button"
                onClick={() => setFilterQuestId("ALL")}
                aria-pressed={effectiveFilterQuestId === "ALL"}
                className={`min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
                  effectiveFilterQuestId === "ALL"
                    ? "bg-white/10 text-white"
                    : "text-hud-muted hover:text-neutral-300"
                }`}
              >
                All
              </button>
              {activeQuests.map((q) => {
                const st = accentStyle(q.accentColor);
                const active = effectiveFilterQuestId === q.id;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() =>
                      setFilterQuestId(active ? "ALL" : q.id)
                    }
                    aria-label={q.title}
                    aria-pressed={active}
                    className={`flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
                      active
                        ? "bg-white/10 text-white"
                        : "text-hud-muted hover:text-neutral-300"
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.bg}`} />
                    <span
                      className="hidden sm:inline max-w-[110px] truncate"
                      title={q.title}
                    >
                      {q.title}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dashed Quick-Add Box (Quest.app style with ↑ Top & ↓ Bottom) */}
          <div className="rounded-2xl border border-dashed border-white/[0.15] bg-[#111318]/60 p-4 transition-colors focus-within:border-white/40">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd(true);
                  }
                }}
                placeholder="Add quest work..."
                aria-label="Add quest work"
                className="flex-1 bg-transparent px-1 py-1 text-base text-white placeholder:text-hud-muted focus:outline-none"
              />

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={!newTitle.trim()}
                  onClick={() => handleAdd(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10 active:opacity-80 disabled:cursor-not-allowed coarse:min-h-11 disabled:opacity-40 transition-[color,background-color,border-color,opacity] duration-150 ease-out"
                >
                  <ArrowUpToLine className="h-3.5 w-3.5" />
                  <span>Top</span>
                </button>
                <button
                  type="button"
                  disabled={!newTitle.trim()}
                  onClick={() => handleAdd(false)}
                  className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-400 hover:bg-white/10 hover:text-white active:opacity-80 disabled:cursor-not-allowed coarse:min-h-11 disabled:opacity-40 transition-[color,background-color,border-color,opacity] duration-150 ease-out"
                >
                  <ArrowDownToLine className="h-3.5 w-3.5" />
                  <span>Bottom</span>
                </button>
              </div>
            </div>

            <div className="mt-2 border-t border-white/[0.05] pt-2">
              <input
                type="text"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAdd(true);
                  }
                }}
                placeholder="Add description (optional)..."
                aria-label="Task description (optional)"
                className="w-full bg-transparent px-1 py-1 text-xs text-neutral-200 placeholder:text-hud-muted focus:outline-none"
              />
            </div>

            {/* Quest Selector Pills inside the Add Box */}
            <div
              role="group"
              aria-label="Quest for new task"
              className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3"
            >
              {activeQuests.map((q) => {
                const st = accentStyle(q.accentColor);
                const isSelected = selectedQuestId === q.id;
                return (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => {
                      hudAudio.playClick();
                      setQuestChoice(q.id);
                    }}
                    aria-pressed={isSelected}
                    className={`flex min-w-0 max-w-full sm:max-w-[230px] min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
                      isSelected
                        ? `${st.border} bg-white/[0.06] text-white font-medium`
                        : "border-white/[0.07] bg-transparent text-neutral-400 hover:border-white/15 hover:text-neutral-200"
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.bg}`} />
                    <span className="truncate" title={q.title}>
                      {q.title}
                    </span>
                  </button>
                );
              })}

              <button
                type="button"
                onClick={() => {
                  hudAudio.playClick();
                  setQuestChoice(null);
                }}
                aria-pressed={otherWorkSelected}
                className={`flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
                  otherWorkSelected
                    ? "border-white/30 bg-white/[0.08] text-white font-medium"
                    : "border-white/[0.07] text-hud-muted hover:text-neutral-300"
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-neutral-500" />
                <span>Other work</span>
              </button>
            </div>
          </div>

          <div ref={taskFlowRef} className="relative space-y-6">
          {/* =============================================================== */}
          {/* QUEST WORK TASK CARDS                                           */}
          {/* =============================================================== */}
          <div className="space-y-3.5">
            {questQueue.length === 0 ? (
              // Skeleton while the tasks are still loading: the empty copy
              // would be wrong for a populated queue.
              allTasks === undefined ? (
                <div
                  aria-busy="true"
                  data-testid="home-loading-skeleton"
                  className="space-y-3.5"
                >
                  {[0, 1].map((slot) => (
                    <div
                      key={slot}
                      className="rounded-2xl border border-white/[0.06] bg-[#111318]/70 p-5 pl-6"
                    >
                      <div className="h-5 w-3/5 animate-pulse rounded-lg bg-white/[0.06]" />
                      <div className="mt-3.5 h-4 w-1/3 animate-pulse rounded-lg bg-white/[0.04]" />
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  data-flow-key="empty-queue"
                  className="rounded-2xl border border-dashed border-white/[0.08] px-4 py-14 text-center text-sm text-hud-muted"
                >
                  {quests !== undefined && activeQuests.length === 0 ? (
                    // With no active quest, new tasks land in Other work, so
                    // "add above" could never fill this queue.
                    <>
                      <p>
                        No active quests. Create a quest to give your most
                        important work a home.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          hudAudio.playClick();
                          setActiveView("quests");
                        }}
                        className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/10 hover:text-white active:opacity-80"
                      >
                        Go to Quests
                      </button>
                    </>
                  ) : (
                    "No quest tasks queued. Add your most important work above."
                  )}
                </div>
              )
            ) : (
              questQueue.map((task, idx) => {
                const linkedQuest = task.questId
                  ? questMap.get(task.questId)
                  : undefined;
                const style = accentStyle(linkedQuest?.accentColor ?? "cyan");
                const isTopTask = idx === 0;
                const isCurrentlyActive = activeTaskId === task.id;
                const isExpanded = expandedTaskId === task.id;
                const isDragOver = dragOverTaskId === task.id;
                const isCompleting = justCompletedId === task.id;
                const taskTotalSec =
                  (task.accumulatedSeconds || 0) +
                  (isCurrentlyActive ? liveDelta : 0);

                return (
                  <div
                    key={task.id}
                    data-testid="task-row"
                    data-task-id={task.id}
                    onKeyDown={(e) => void handleQueueRowKeyDown(e, task.id)}
                    // Not draggable while the notes drawer is open, so selecting
                    // text or placing the caret in the notes field never starts a drag.
                    draggable={!isExpanded}
                    onDragStart={() => setDraggedTaskId(task.id)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedTaskId && draggedTaskId !== task.id) {
                        setDragOverTaskId(task.id);
                      }
                    }}
                    onDrop={() => handleDropOnTask(task.id, questQueue)}
                    onDragEnd={() => {
                      setDraggedTaskId(null);
                      setDragOverTaskId(null);
                    }}
                    className={`group relative overflow-hidden rounded-2xl border transition-colors duration-200 ${
                      isExpanded ? "" : "cursor-grab active:cursor-grabbing "
                    }${
                      isDragOver
                        ? "border-white/40 bg-[#1a1d24]"
                        : isTopTask
                        ? "border-[#00f0ff]/35 bg-[#12151c] shadow-[0_0_30px_-12px_rgba(0,240,255,0.22)]"
                        : "border-white/[0.08] bg-[#111318] hover:border-white/[0.15]"
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
                        onClick={() => {
                          hudAudio.playLockOn();
                          initializeFocus(task.id);
                        }}
                        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        className="block w-full cursor-pointer break-words [text-wrap:pretty] text-left text-base font-medium leading-snug text-white hover:text-[#00f0ff] transition-colors duration-150 ease-out active:opacity-80"
                      >
                        {task.title}
                      </button>

                      {!isExpanded && task.notes && (
                        <p className="mt-1.5 max-w-[70ch] line-clamp-2 break-words text-xs leading-relaxed text-hud-muted">
                          {task.notes}
                        </p>
                      )}

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
                              handleCompleteTask(task.id);
                            }}
                            title="Mark complete"
                            aria-label="Mark complete"
                            className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full border before:absolute before:-inset-3 before:content-[''] transition-[color,background-color,border-color,opacity,transform] duration-150 ease-out active:scale-90 active:opacity-80 ${
                              isCompleting
                                ? `${style.bg} border-transparent text-black`
                                : "border-white/40 text-transparent hover:border-[#00ff9d] hover:text-[#00ff9d]"
                            }`}
                          >
                            <Check className="h-3 w-3" />
                          </button>

                          {/* Rounded Quest Pill */}
                          {linkedQuest && (
                            <span className="flex min-w-0 max-w-full sm:max-w-[250px] items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3 py-1 text-xs text-neutral-300">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`}
                              />
                              <span className="truncate" title={linkedQuest.title}>
                                {linkedQuest.title}
                              </span>
                            </span>
                          )}

                          {task.habitId && (
                            <span
                              title="Daily habit"
                              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] text-hud-muted"
                            >
                              <Repeat className="h-3 w-3" aria-hidden="true" />
                              <span>Daily</span>
                            </span>
                          )}

                          {/* Timer / Play Button */}
                          {isCurrentlyActive && isRunning ? (
                            <button
                              type="button"
                              onClick={() => {
                                hudAudio.playClick();
                                suspendTimer();
                              }}
                              aria-label={`Pause focus: ${task.title}`}
                              className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full px-2.5 py-1 font-mono text-xs tabular-nums text-[#00ff9d] hover:bg-white/[0.05] transition-colors duration-150 ease-out active:opacity-80"
                            >
                              <span className="h-2 w-2 rounded-full bg-[#00ff9d] animate-pulse" />
                              <span>
                                {formatChronoMMSS(taskTotalSec).formatted}
                              </span>
                              <Pause className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                hudAudio.playLockOn();
                                initializeFocus(task.id);
                              }}
                              aria-label={`Start focus: ${task.title}`}
                              className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full px-2.5 py-1 font-mono text-xs tabular-nums text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                            >
                              {taskTotalSec > 0 && (
                                <span>
                                  {formatChronoMMSS(taskTotalSec).formatted}
                                </span>
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
                            onClick={() =>
                              setExpandedTaskId(isExpanded ? null : task.id)
                            }
                            title="Task notes & options"
                            aria-expanded={isExpanded}
                            className={`rounded-lg p-1.5 transition-colors duration-150 ease-out active:opacity-80 ${
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
                    {isExpanded && (
                      <div
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setExpandedTaskId(null);
                            expandedToggleRef.current?.focus();
                          }
                        }}
                        // cursor-auto: the row's grab cursor is inherited, and
                        // the notes field should keep its text cursor.
                        className="cursor-auto border-t border-white/[0.06] bg-[#0c0e12] px-6 py-4 space-y-3"
                      >
                        <TaskNotesField
                          key={task.id}
                          taskId={task.id}
                          notes={task.notes}
                          rows={2}
                          placeholder="Add session notes..."
                          aria-label={`Notes for ${task.title}`}
                          className="w-full rounded-xl border border-white/10 bg-black/40 p-3 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-[#00f0ff]/50 focus:outline-none"
                        />

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            {activeQuests.map((q) => {
                              const qStyle = accentStyle(q.accentColor);
                              const isCurrentQuest = task.questId === q.id;
                              return (
                                <button
                                  key={q.id}
                                  type="button"
                                  onClick={() =>
                                    updateTask(task.id, { questId: q.id })
                                  }
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
                              onClick={() =>
                                updateTask(task.id, { questId: null })
                              }
                              className="min-h-8 coarse:min-h-11 rounded-full px-3 py-1.5 text-hud-muted hover:text-neutral-300 transition-colors duration-150 ease-out active:opacity-80"
                            >
                              Move to Other
                            </button>
                          </div>

                          <ConfirmDeleteButton
                            label="Delete task"
                            onConfirm={() => deleteTask(task.id)}
                            className="-my-1.5 -mr-2 flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg px-2.5 py-1.5 text-hud-muted hover:bg-[#ff2a5f]/10 hover:text-[#ff2a5f]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete</span>
                          </ConfirmDeleteButton>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {questQueue.length > 1 && (
              <div
                data-flow-key="reorder-hint"
                className="text-center text-xs text-hud-muted"
              >
                Alt+↑/↓ to reorder
              </div>
            )}
          </div>

          {/* =============================================================== */}
          {/* OTHER WORK / MAINTENANCE                                        */}
          {/* =============================================================== */}
          {maintenanceQueue.length > 0 && (
            <div className="pt-6 space-y-3">
              <div
                data-flow-key="other-header"
                className="text-xs font-semibold uppercase tracking-[0.16em] text-hud-muted"
              >
                Other Work
              </div>

              {maintenanceQueue.map((task) => {
                const taskTotalSec = task.accumulatedSeconds || 0;
                const isCompleting = justCompletedId === task.id;
                return (
                  <div
                    key={task.id}
                    data-testid="task-row"
                    data-task-id={task.id}
                    className="group relative overflow-hidden rounded-2xl border border-white/[0.06] bg-[#101115] p-5 pl-6 hover:border-white/15 transition-colors duration-200"
                  >
                    <div className="absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full bg-neutral-600" />

                    <button
                      type="button"
                      data-task-title="true"
                      onClick={() => {
                        hudAudio.playLockOn();
                        initializeFocus(task.id);
                      }}
                      className="block w-full cursor-pointer break-words text-left text-base font-medium text-neutral-200 hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                    >
                      {task.title}
                    </button>

                    {task.notes && (
                      <p className="mt-1.5 max-w-[70ch] line-clamp-2 break-words text-xs leading-relaxed text-hud-muted">
                        {task.notes}
                      </p>
                    )}

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-wrap items-center gap-2.5 sm:gap-3">
                        <button
                          type="button"
                          onClick={(e) => {
                            // Ignore the second click of a double-click.
                            if (e.detail > 1) return;
                            handleCompleteTask(task.id);
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

                        {task.habitId && (
                          <span
                            title="Daily habit"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] text-hud-muted"
                          >
                            <Repeat className="h-3 w-3" aria-hidden="true" />
                            <span>Daily</span>
                          </span>
                        )}

                        <button
                          type="button"
                          onClick={() => {
                            hudAudio.playLockOn();
                            initializeFocus(task.id);
                          }}
                          aria-label={`Start focus: ${task.title}`}
                          className="-my-1 flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-full px-2 py-1 font-mono text-xs tabular-nums text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                        >
                          {taskTotalSec > 0 && (
                            <span>
                              {formatChronoMMSS(taskTotalSec).formatted}
                            </span>
                          )}
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                      </div>

                      <ConfirmDeleteButton
                        label="Delete task"
                        onConfirm={() => deleteTask(task.id)}
                        className={ROW_DELETE_CLASS}
                      >
                        <Trash2 className="h-4 w-4" />
                      </ConfirmDeleteButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* =============================================================== */}
          {/* COMPLETED TASKS (Two-Beat Glide Destination)                    */}
          {/* =============================================================== */}
          {completedTasks.length > 0 && (
            <div
              data-testid="completed-tasks-section"
              className="pt-6 space-y-3"
            >
              <div
                data-flow-key="completed-header"
                className="text-xs font-semibold uppercase tracking-[0.16em] text-hud-muted"
              >
                Completed
              </div>

              {completedTasks.map((task) => {
                const linkedQuest = task.questId
                  ? questMap.get(task.questId)
                  : undefined;
                const style = accentStyle(linkedQuest?.accentColor ?? "slate");
                const questLabel = linkedQuest ? linkedQuest.title : "Other work";
                const isJustCompleted = justCompletedId === task.id;

                // Only the accent bar and the check are dimmed (the card used
                // to be, which took the title below AA contrast). While settling
                // in (`isJustCompleted`), the card uses a solid elevated surface
                // (`z-10 bg-[#11141b]`, below the sticky notice) with a subtle emerald border highlight.
                return (
                  <div
                    key={task.id}
                    data-testid="completed-task-row"
                    data-task-id={task.id}
                    className={`group relative overflow-hidden rounded-2xl border p-5 pl-6 transition-[border-color,background-color,box-shadow] duration-500 ease-out ${
                      isJustCompleted
                        ? SETTLING_COMPLETED_CARD_CLASS
                        : "border-white/[0.05] bg-[#0e1014]/60"
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
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`}
                          />
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

                      <ConfirmDeleteButton
                        label="Delete task"
                        onConfirm={() => deleteTask(task.id)}
                        className={ROW_DELETE_CLASS}
                      >
                        <Trash2 className="h-4 w-4" />
                      </ConfirmDeleteButton>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* RIGHT COLUMN (5 cols): TODAY'S DAY TIMELINE (Quest.app style)     */}
        {/* ================================================================= */}
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
              {activeTaskObj && isRunning && sessionStartedAt && (
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
                    (liveDelta / 3600) * HOUR_HEIGHT_PX
                  );
                  const colIndex = placement?.colIndex ?? 0;
                  const totalCols = placement?.totalCols ?? 1;
                  const leftExpr = `calc(3.5rem + (100% - 3.75rem) * ${colIndex} / ${totalCols})`;
                  const widthExpr = `calc((100% - 3.75rem) / ${totalCols} - ${
                    totalCols > 1 ? 4 : 0
                  }px)`;
                  const q = activeTaskObj.questId
                    ? questMap.get(activeTaskObj.questId)
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
                        {activeTaskObj.title}
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
      </div>
    </div>
  );
}
