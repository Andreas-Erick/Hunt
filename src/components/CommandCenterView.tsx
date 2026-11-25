"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { motion, AnimatePresence } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { accentColor, accentStyle } from "@/lib/questAccents";
import { dateFromKey, formatChronoMMSS, isTaskVisibleToday, toLocalDateKey } from "@/lib/dateUtils";
import type { Quest } from "@/lib/domainTypes";
import { formatTelemetryDuration } from "@/lib/reviewAnalytics";
import { useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import { onOpenTaskRequest, revealWhenDrawn, takeOpenTaskRequest } from "@/lib/openItemRequest";
import {
  COMPLETION_HIGHLIGHT_MS,
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
  type TaskCompletionScene,
} from "@/lib/taskCompletionMotion";
import { DayTimeline } from "./DayTimeline";
import { TaskComposer } from "./TaskComposer";
import { TaskRow } from "./TaskRow";
import { useQueueReorder } from "./useQueueReorder";
import { useTransientHighlight } from "./useTransientHighlight";
import { useQuestWeekLogs } from "./useQuestWeekLogs";
import { computeQuestWeekProgress } from "@/lib/questProgress";

/** Clock tick while a timer runs (drives the live counters). */
const RUNNING_TICK_MS = 1000;
/** Clock tick otherwise: enough for the date and the timeline's "now" line. */
const IDLE_TICK_MS = 60_000;

export function CommandCenterView() {
  const {
    activeTaskId,
    isRunning,
    sessionStartedAt,
    completeTaskById,
    materializeDailyHabits,
    lastCompletedFeedback,
    clearFeedback,
    setActiveView,
  } = useCommandStore(
    useShallow((s) => ({
      activeTaskId: s.activeTaskId,
      isRunning: s.isRunning,
      sessionStartedAt: s.sessionStartedAt,
      completeTaskById: s.completeTaskById,
      materializeDailyHabits: s.materializeDailyHabits,
      lastCompletedFeedback: s.lastCompletedFeedback,
      clearFeedback: s.clearFeedback,
      setActiveView: s.setActiveView,
    }))
  );

  const quests = useLiveQuery(reads.quests, []);

  const allTasks = useLiveQuery(reads.allTasks, []);

  const [filterQuestId, setFilterQuestId] = useState<string | "ALL">("ALL");

  // Expanded Task ID (for notes / quest change)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  // Notes toggle of the expanded task; Escape in the drawer returns focus here.
  const expandedToggleRef = useRef<HTMLButtonElement | null>(null);

  // A reminder's click (openItemRequest) opens its Task's row here: drawer open, scrolled to, no filter.
  useEffect(() => {
    const open = () => {
      const taskId = takeOpenTaskRequest();
      if (!taskId) return;
      setFilterQuestId("ALL");
      setExpandedTaskId(taskId);
      revealWhenDrawn("taskId", taskId);
    };
    open();
    return onOpenTaskRequest(open);
  }, []);

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
    const accentCss = accentColor(accentStyle(quest?.accentColor ?? "emerald"));
    pendingSceneRef.current = captureTaskCompletionScene(
      taskFlowRef.current,
      taskId,
      accentCss
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

  const { dragOverTaskId, rowHandlers, moveBy } = useQueueReorder(allTasks, questQueue);

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
              className="flex items-center justify-between gap-3 rounded-xl border border-success/30 bg-success/10 px-5 py-3.5 text-sm text-success"
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
                className="-my-1.5 -mr-2 min-h-8 min-w-8 coarse:min-h-11 coarse:min-w-11 shrink-0 rounded-lg px-2.5 py-1.5 text-base leading-none text-neutral-400 transition-colors duration-150 ease-out hover:bg-white/[0.06] hover:text-white active:opacity-80"
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
                className="h-full w-full rounded-full bg-accent transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
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
            <span className="text-sm font-semibold text-hud-muted">
              Quest work
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
                    className={`flex min-h-8 coarse:min-h-11 coarse:min-w-11 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
                      active
                        ? "bg-white/10 text-white"
                        : "text-hud-muted hover:text-neutral-300"
                    }`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${st.bg}`} />
                    <span
                      className="hidden sm:inline max-w-[10rem] truncate"
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
          <TaskComposer
            questsLoaded={quests !== undefined}
            activeQuests={activeQuests}
            activeQuestMap={activeQuestMap}
          />

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
                      className="rounded-2xl border border-white/[0.06] bg-surface/70 p-5 pl-6"
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
                        className="mt-4 min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors duration-150 ease-out hover:bg-white/10 hover:text-white active:opacity-80"
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
                const isExpanded = expandedTaskId === task.id;
                return (
                  <TaskRow
                    key={task.id}
                    variant="queue"
                    task={task}
                    quest={task.questId ? questMap.get(task.questId) : undefined}
                    isTopTask={idx === 0}
                    isCurrentlyActive={activeTaskId === task.id}
                    liveSeconds={liveDelta}
                    isCompleting={justCompletedId === task.id}
                    isExpanded={isExpanded}
                    isDragOver={dragOverTaskId === task.id}
                    activeQuests={activeQuests}
                    expandedToggleRef={expandedToggleRef}
                    reorderHandlers={rowHandlers(task.id)}
                    onMoveUp={moveBy(task.id, -1)}
                    onMoveDown={moveBy(task.id, 1)}
                    onComplete={handleCompleteTask}
                    onToggleExpanded={() =>
                      setExpandedTaskId(isExpanded ? null : task.id)
                    }
                    onCloseDrawer={() => {
                      setExpandedTaskId(null);
                      expandedToggleRef.current?.focus();
                    }}
                  />
                );
              })
            )}
            {questQueue.length > 1 && (
              <div
                data-flow-key="reorder-hint"
                className="text-center text-xs text-hud-muted hoverless:hidden"
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
                className="text-sm font-semibold text-hud-muted"
              >
                Other work
              </div>

              {maintenanceQueue.map((task) => (
                <TaskRow
                  key={task.id}
                  variant="maintenance"
                  task={task}
                  isCompleting={justCompletedId === task.id}
                  onComplete={handleCompleteTask}
                />
              ))}
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
                className="text-sm font-semibold text-hud-muted"
              >
                Completed
              </div>

              {completedTasks.map((task) => (
                <TaskRow
                  key={task.id}
                  variant="completed"
                  task={task}
                  quest={task.questId ? questMap.get(task.questId) : undefined}
                  isJustCompleted={justCompletedId === task.id}
                />
              ))}
            </div>
          )}
          </div>
        </div>

        {/* ================================================================= */}
        {/* RIGHT COLUMN (5 cols): TODAY'S DAY TIMELINE (Quest.app style)     */}
        {/* ================================================================= */}
        <DayTimeline
          weekLogs={weekLogs}
          todayKey={todayKey}
          activeTask={activeTaskObj}
          isRunning={isRunning}
          sessionStartedAt={sessionStartedAt}
          liveSeconds={liveDelta}
          nowMs={nowMs}
          questMap={questMap}
        />
      </div>
    </div>
  );
}
