"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowUpToLine,
  ArrowDownToLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Repeat,
  Trash2,
} from "lucide-react";
import {
  db,
  accentStyle,
  dateFromKey,
  dateKeyFromOffset,
  formatChronoMMSS,
  loadSortedQuests,
  toLocalDateKey,
  type Quest,
  type Task,
} from "@/lib/db";
import { useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import {
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
  type TaskCompletionScene,
} from "@/lib/taskCompletionMotion";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { useTodayDateKey } from "./useTodayDateKey";

interface DayColumn {
  dateKey: string;
  weekdayShort: string;
  weekdayLong: string;
  dayNum: string;
  monthYear: string;
  isToday: boolean;
  isPast: boolean;
}

/**
 * The 5 visible days centred on today + dayOffset. Each day is a calendar step
 * from a noon anchor, so 23- and 25-hour DST days never skip or repeat a column.
 */
function buildDayColumns(todayKey: string, dayOffset: number): DayColumn[] {
  return [-2, -1, 0, 1, 2].map((i) => {
    const d = dateFromKey(todayKey, dayOffset + i);
    const dateKey = toLocalDateKey(d.getTime());
    return {
      dateKey,
      weekdayShort: d.toLocaleDateString("en-US", { weekday: "short" }),
      weekdayLong: d.toLocaleDateString("en-US", { weekday: "long" }),
      dayNum: String(d.getDate()),
      monthYear: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      isToday: dateKey === todayKey,
      isPast: dateKey < todayKey,
    };
  });
}

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";
const ADD_BUTTON = `rounded border border-white/10 bg-white/[0.03] p-1 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40 ${PRESSABLE}`;
const NAV_BUTTON = `rounded-lg border border-white/10 bg-[#111318] hover:border-white/20 hover:text-white ${PRESSABLE}`;
const COMPLETION_HIGHLIGHT_MS = 650;

export function PlanWeekView() {
  const {
    activeTaskId,
    initializeFocus,
    createTask,
    updateTask,
    deleteTask,
    completeTaskById,
    reopenTaskById,
  } = useCommandStore(
    useShallow((s) => ({
      activeTaskId: s.activeTaskId,
      initializeFocus: s.initializeFocus,
      createTask: s.createTask,
      updateTask: s.updateTask,
      deleteTask: s.deleteTask,
      completeTaskById: s.completeTaskById,
      reopenTaskById: s.reopenTaskById,
    }))
  );

  const quests = useLiveQuery(() => loadSortedQuests(), []);
  const allTasks = useLiveQuery(() => db.tasks.toArray(), []);

  // Day offset from Today (0 = centered on Today: [Today-2, Today-1, Today, Today+1, Today+2])
  const [dayOffset, setDayOffset] = useState(0);
  // Explicit quest choice for new tasks: undefined = default (first quest),
  // null = Other.
  const [questChoice, setQuestChoice] = useState<string | null | undefined>(
    undefined
  );
  const [inputsByDay, setInputsByDay] = useState<Record<string, string>>({});
  const [notesByDay, setNotesByDay] = useState<Record<string, string>>({});
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverDateKey, setDragOverDateKey] = useState<string | null>(null);
  const [justCompletedId, setJustCompletedId] = useState<string | null>(null);
  const completeHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  useEffect(() => {
    return () => {
      if (completeHighlightTimerRef.current !== null) {
        clearTimeout(completeHighlightTimerRef.current);
      }
    };
  }, []);

  // Days with an add in flight; set synchronously, so a double click or a
  // repeated Enter cannot create the task twice before React re-renders.
  const addingDaysRef = useRef<Set<string>>(new Set());
  // Keyboard reschedule (Alt+Shift+←/→): one move at a time, and the card that
  // moved gets the focus back once it renders in its new column.
  const keyboardMoveRef = useRef(false);
  const refocusRef = useRef<{ taskId: string; dateKey: string } | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

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

  // Default quest = first active quest (never a hardcoded, completed or deleted id).
  const selectedQuestId: string | null =
    questChoice === null
      ? null
      : questChoice !== undefined && activeQuestMap.has(questChoice)
      ? questChoice
      : activeQuests[0]?.id ?? null;
  const otherSelected = quests !== undefined && selectedQuestId === null;

  const todayKey = useTodayDateKey();

  const columns = React.useMemo(
    () => buildDayColumns(todayKey, dayOffset),
    [dayOffset, todayKey]
  );

  // A card moved by keyboard is re-created in its new column; give its title
  // the focus back once the live query shows it there.
  useEffect(() => {
    const target = refocusRef.current;
    if (!target || !allTasks) return;
    const task = allTasks.find((t) => t.id === target.taskId);
    if (task && task.scheduledDate !== target.dateKey) return;
    refocusRef.current = null;
    const card = Array.from(
      boardRef.current?.querySelectorAll<HTMLElement>("[data-testid='task-row']") ?? []
    ).find(
      (el) =>
        el.dataset.taskId === target.taskId &&
        el.dataset.dateKey === target.dateKey
    );
    card?.querySelector<HTMLElement>("[data-card-title]")?.focus();
  }, [allTasks, columns]);

  const colFlowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingSceneRef = useRef<{
    colDateKey: string;
    scene: TaskCompletionScene;
  } | null>(null);

  const handleCompleteTask = (taskId: string, colDateKey: string) => {
    if (completeHighlightTimerRef.current !== null) {
      clearTimeout(completeHighlightTimerRef.current);
    }
    const task = allTasks?.find((t) => t.id === taskId);
    const quest = task?.questId ? questMap.get(task.questId) : undefined;
    const accentHex = accentStyle(quest?.accentColor ?? "emerald").hex;
    const scene = captureTaskCompletionScene(
      colFlowRefs.current[colDateKey] ?? null,
      taskId,
      accentHex
    );
    pendingSceneRef.current = scene ? { colDateKey, scene } : null;
    setJustCompletedId(taskId);
    completeHighlightTimerRef.current = setTimeout(() => {
      setJustCompletedId((cur) => (cur === taskId ? null : cur));
      completeHighlightTimerRef.current = null;
    }, COMPLETION_HIGHLIGHT_MS);
    hudAudio.playComplete();
    void completeTaskById(taskId);
  };

  useLayoutEffect(() => {
    const pending = pendingSceneRef.current;
    if (!pending) return;
    const done = (allTasks ?? []).some(
      (t) => t.id === pending.scene.taskId && t.status === "completed"
    );
    if (!done) return;
    pendingSceneRef.current = null;
    return playTwoBeatTaskCompletion(
      colFlowRefs.current[pending.colDateKey] ?? null,
      pending.scene
    );
  }, [allTasks]);

  const handleAddForDay = async (dateKey: string, promoteToTop: boolean) => {
    const title = (inputsByDay[dateKey] ?? "").trim();
    const rawNotes = notesByDay[dateKey] ?? "";
    const trimmedNotes = rawNotes.trim();
    if (!title || addingDaysRef.current.has(dateKey)) return;
    hudAudio.playClick();
    addingDaysRef.current.add(dateKey);
    setInputsByDay((prev) => ({ ...prev, [dateKey]: "" }));
    setNotesByDay((prev) => ({ ...prev, [dateKey]: "" }));
    let created = false;
    try {
      // Resolves false when the local write failed (the store reports it).
      created = await createTask({
        title,
        questId: selectedQuestId,
        promoteToTop,
        scheduledDate: dateKey,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } finally {
      addingDaysRef.current.delete(dateKey);
      // Give the title & description back unless something new was typed meanwhile.
      if (!created) {
        setInputsByDay((prev) =>
          (prev[dateKey] ?? "") === "" ? { ...prev, [dateKey]: title } : prev
        );
        setNotesByDay((prev) =>
          (prev[dateKey] ?? "") === "" ? { ...prev, [dateKey]: rawNotes } : prev
        );
      }
    }
  };

  const handleDropOnDay = async (dateKey: string) => {
    if (!draggedTaskId) return;
    const dragged = allTasks?.find((t) => t.id === draggedTaskId);
    const currentDate = dragged?.scheduledDate ?? todayKey;
    setDraggedTaskId(null);
    setDragOverDateKey(null);
    // Dropped back on its own day: nothing to write (and nothing to sync).
    if (dragged && currentDate === dateKey) return;
    hudAudio.playClick();
    await updateTask(draggedTaskId, { scheduledDate: dateKey });
  };

  /**
   * Alt+Shift+ArrowLeft / Alt+Shift+ArrowRight anywhere in a card (it bubbles up
   * from the card's buttons) moves the task one calendar day, the keyboard
   * equivalent of dragging it to the next column. Plain Alt+Arrow is the
   * browser's Back/Forward. Held keys (repeat) are ignored. A move past the
   * visible window first scrolls the window one day, so the card stays in view
   * at the edges as well.
   *
   * `fromKey` is the key of the column the card renders in, which equals
   * `task.scheduledDate ?? todayKey` and is always a well-formed key, so a
   * malformed synced date can never turn into a "NaN-NaN-NaN" write.
   */
  const handleCardKeyDown = async (
    e: React.KeyboardEvent<HTMLElement>,
    task: Task,
    fromKey: string
  ) => {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (step === 0 || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    if (e.repeat || keyboardMoveRef.current) return;

    const target = dateKeyFromOffset(fromKey, step);
    hudAudio.playClick();
    keyboardMoveRef.current = true;
    refocusRef.current = { taskId: task.id, dateKey: target };
    if (!columns.some((c) => c.dateKey === target)) {
      setDayOffset((d) => d + step);
    }
    try {
      // Resolves false when the local write failed (the store reports it).
      const moved = await updateTask(task.id, { scheduledDate: target });
      if (!moved) refocusRef.current = null;
    } finally {
      keyboardMoveRef.current = false;
    }
  };

  const hasVisiblePendingTasks = (allTasks ?? []).some(
    (t) =>
      (t.status === "queued" || t.status === "active") &&
      columns.some((c) => c.dateKey === (t.scheduledDate ?? todayKey))
  );

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      {/* Header Row: "Plan the week" + Active Quest Selector + Month / Today Controls */}
      <div className="mb-8 sm:mb-10 flex flex-col justify-between gap-4 sm:gap-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-4">
          <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium tracking-tight text-white">
            Plan the week
          </h1>

          {/* Quest Tag Selector for Quick Add */}
          <div
            role="group"
            aria-label="Quest for new tasks"
            className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5 rounded-full border border-white/[0.07] bg-[#111318] p-1"
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
                  className={`flex min-w-0 max-w-full sm:max-w-[200px] items-center gap-1.5 rounded-full px-3 py-1 text-xs ${PRESSABLE} ${
                    isSelected
                      ? "bg-white/10 text-white font-medium"
                      : "text-neutral-400 hover:text-neutral-200"
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
              aria-pressed={otherSelected}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${PRESSABLE} ${
                otherSelected
                  ? "bg-white/10 text-white font-medium"
                  : "text-hud-muted hover:text-neutral-300"
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-neutral-500" />
              <span>Other</span>
            </button>
          </div>
        </div>

        {/* Right: Month Label + Today Navigation */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <span className="mr-1 sm:mr-2 text-sm sm:text-base text-neutral-400">
            {columns[2]?.monthYear}
          </span>
          <button
            type="button"
            onClick={() => setDayOffset((d) => d - 1)}
            aria-label="Previous day"
            className={`${NAV_BUTTON} p-2 text-neutral-400`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDayOffset(0)}
            className={`${NAV_BUTTON} px-4 py-2 text-xs font-medium text-white`}
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setDayOffset((d) => d + 1)}
            aria-label="Next day"
            className={`${NAV_BUTTON} p-2 text-neutral-400`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 5-Column Weekly Board (Intrinsic Fluid Grid across 320px -> Split-Screen -> 5-Col) */}
      <div
        ref={boardRef}
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4 xl:grid-cols-5"
      >
        {columns.map((col) => {
          const dayTasks = (allTasks ?? [])
            .filter((t) => {
              const sDate = t.scheduledDate ?? todayKey;
              return sDate === col.dateKey;
            })
            .sort(compareRank);

          const pendingDayTasks = dayTasks.filter(
            (t) => t.status === "queued" || t.status === "active"
          );
          const completedDayTasks = dayTasks.filter(
            (t) => t.status === "completed"
          );
          const isDragTarget = dragOverDateKey === col.dateKey;
          const dayInput = inputsByDay[col.dateKey] ?? "";

          return (
            <div
              key={col.dateKey}
              data-testid="day-column"
              data-date-key={col.dateKey}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverDateKey(col.dateKey);
              }}
              onDragLeave={() => setDragOverDateKey(null)}
              onDrop={() => handleDropOnDay(col.dateKey)}
              className={`flex min-h-[200px] xl:min-h-[560px] min-w-0 flex-col rounded-2xl border p-4 transition-colors ${
                isDragTarget
                  ? "border-[#00f0ff]/50 bg-[#141821]"
                  : col.isToday
                  ? "border-white/[0.12] bg-[#111318]"
                  : "border-white/[0.05] bg-[#0d0f13]"
              }`}
            >
              {/* Day Column Header */}
              <div
                className={`mb-4 border-b pb-3 ${
                  col.isToday ? "border-[#ffb800]" : "border-white/[0.06]"
                }`}
              >
                <div className="flex items-baseline gap-1.5 text-base">
                  <span
                    className={
                      col.isToday
                        ? "font-semibold text-white"
                        : "font-medium text-hud-muted"
                    }
                  >
                    {col.weekdayShort}
                  </span>
                  <span
                    className={`tabular-nums ${
                      col.isToday
                        ? "font-semibold text-[#ffb800]"
                        : "text-hud-muted"
                    }`}
                  >
                    {col.dayNum}
                  </span>
                </div>
              </div>

              {/* Dashed Add Task Input (for Today & Future Columns) */}
              {!col.isPast && (
                <div className="mb-3.5 rounded-xl border border-dashed border-white/[0.12] bg-black/20 px-3 py-2.5 transition-colors duration-150 ease-out focus-within:border-white/40">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={dayInput}
                      onChange={(e) =>
                        setInputsByDay((prev) => ({
                          ...prev,
                          [col.dateKey]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddForDay(col.dateKey, true);
                        }
                      }}
                      placeholder="Add a task..."
                      aria-label={`Add task for ${col.weekdayLong}`}
                      className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-hud-muted focus:outline-none"
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleAddForDay(col.dateKey, true)}
                        disabled={!dayInput.trim()}
                        title="Add to top"
                        className={`${ADD_BUTTON} text-neutral-400`}
                      >
                        <ArrowUpToLine className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAddForDay(col.dateKey, false)}
                        disabled={!dayInput.trim()}
                        title="Add to bottom"
                        className={`${ADD_BUTTON} text-hud-muted`}
                      >
                        <ArrowDownToLine className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-1.5 border-t border-white/[0.05] pt-1.5">
                    <input
                      type="text"
                      value={notesByDay[col.dateKey] ?? ""}
                      onChange={(e) =>
                        setNotesByDay((prev) => ({
                          ...prev,
                          [col.dateKey]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAddForDay(col.dateKey, true);
                        }
                      }}
                      placeholder="Description (optional)..."
                      aria-label={`Task description for ${col.weekdayLong} (optional)`}
                      className="w-full bg-transparent text-[11px] text-neutral-200 placeholder:text-hud-muted focus:outline-none"
                    />
                  </div>
                </div>
              )}

              {/* A past day has no add box; say so instead of a blank column. */}
              {col.isPast &&
                allTasks !== undefined &&
                pendingDayTasks.length + completedDayTasks.length === 0 && (
                <div className="text-xs text-hud-muted">Nothing planned</div>
              )}

              {/* Pending & Completed Tasks in this Day Column */}
              <div
                ref={(el) => {
                  colFlowRefs.current[col.dateKey] = el;
                }}
                className="relative space-y-3"
              >
                {pendingDayTasks.map((task, idx) => {
                  const linkedQuest = task.questId
                    ? questMap.get(task.questId)
                    : undefined;
                  const style = accentStyle(linkedQuest?.accentColor);
                  const questLabel = linkedQuest ? linkedQuest.title : "Other";
                  const isHero = col.isToday && idx === 0;
                  const isRunningHere = activeTaskId === task.id;
                  const isCompleting = justCompletedId === task.id;

                  return (
                    <div
                      key={task.id}
                      data-testid="task-row"
                      data-task-id={task.id}
                      data-date-key={col.dateKey}
                      draggable
                      onDragStart={() => setDraggedTaskId(task.id)}
                      onDragEnd={() => {
                        setDraggedTaskId(null);
                        setDragOverDateKey(null);
                      }}
                      onKeyDown={(e) => void handleCardKeyDown(e, task, col.dateKey)}
                      className={`group relative overflow-hidden rounded-xl border p-4 pl-5 transition-colors duration-200 cursor-grab ${
                        isHero
                          ? "border-[#ffb800]/40 bg-[#151820] shadow-[0_0_24px_-10px_rgba(255,184,0,0.2)]"
                          : "border-white/[0.08] bg-[#13151b] hover:border-white/20"
                      }`}
                    >
                      <div
                        className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${style.bg}`}
                      />

                      <button
                        type="button"
                        data-card-title
                        data-task-title="true"
                        onClick={() => {
                          hudAudio.playLockOn();
                          initializeFocus(task.id);
                        }}
                        aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
                        className={`block w-full cursor-pointer break-words [text-wrap:pretty] text-left text-sm font-medium leading-snug text-white hover:text-[#00f0ff] ${PRESSABLE}`}
                      >
                        {task.title}
                      </button>

                      {task.notes && (
                        <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-hud-muted">
                          {task.notes}
                        </p>
                      )}

                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={(e) => {
                              // The second click of a double-click would hit
                              // the next card, which slides up under the cursor.
                              if (e.detail > 1) return;
                              handleCompleteTask(task.id, col.dateKey);
                            }}
                            title="Mark complete"
                            aria-label="Mark complete"
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-all duration-150 ease-out active:scale-90 active:opacity-80 ${
                              isCompleting
                                ? `${style.bg} border-transparent text-black`
                                : "border-white/25 text-transparent hover:border-[#00ff9d] hover:text-[#00ff9d]"
                            }`}
                          >
                            <Check className="h-2.5 w-2.5" />
                          </button>

                          <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-0.5 text-[11px] text-neutral-300">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.bg}`}
                            />
                            <span className="max-w-[115px] truncate" title={questLabel}>
                              {questLabel}
                            </span>
                          </span>
                          {task.habitId && (
                            <span
                              title="Daily habit"
                              aria-label="Daily habit"
                              className="inline-flex shrink-0 items-center text-hud-muted"
                            >
                              <Repeat className="h-3 w-3" aria-hidden="true" />
                            </span>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                          {task.accumulatedSeconds > 0 && (
                            <span className="font-mono text-[11px] tabular-nums text-neutral-400">
                              {formatChronoMMSS(task.accumulatedSeconds).formatted}
                            </span>
                          )}
                          {isRunningHere && (
                            <span className="h-2 w-2 rounded-full bg-[#00ff9d] animate-pulse" />
                          )}
                          {/* The arbitrary transition-property comes after the
                              component's transition-colors in the compiled CSS,
                              so both the colour and the hover fade transition. */}
                          <ConfirmDeleteButton
                            label="Delete task"
                            onConfirm={() => deleteTask(task.id)}
                            className="whitespace-nowrap text-xs text-hud-muted opacity-0 hover:text-[#ff2a5f] group-hover:opacity-100 focus-visible:opacity-100 data-[state=armed]:opacity-100 [transition-property:color,opacity]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </ConfirmDeleteButton>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {/* Completed Tasks in this Day Column. Only the accent bar and
                    the check are dimmed, so the title keeps AA contrast. */}
                {completedDayTasks.length > 0 && (
                  <div
                    data-flow-key="completed-header"
                    className="pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-hud-muted"
                  >
                    Completed
                  </div>
                )}
                {completedDayTasks.map((task) => {
                  const linkedQuest = task.questId
                    ? questMap.get(task.questId)
                    : undefined;
                  const style = accentStyle(linkedQuest?.accentColor);
                  const questLabel = linkedQuest ? linkedQuest.title : "Other";
                  const isJustCompleted = justCompletedId === task.id;

                  return (
                    <div
                      key={task.id}
                      data-testid="task-row"
                      data-task-id={task.id}
                      data-completed-row="true"
                      data-date-key={col.dateKey}
                      className={`group relative overflow-hidden rounded-xl border p-4 pl-5 transition-[border-color,background-color,box-shadow] duration-500 ease-out ${
                        isJustCompleted
                          ? "z-20 border-[#00ff9d]/35 bg-[#11141b] shadow-[0_10px_24px_-10px_rgba(0,255,157,0.3)]"
                          : "border-white/[0.05] bg-[#101217]/50"
                      }`}
                    >
                      <div
                        className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${style.bg} opacity-40 transition-opacity duration-150 ease-out group-hover:opacity-60`}
                      />
                      <div className="break-words text-sm text-hud-muted line-through">
                        {task.title}
                      </div>
                      <div className="mt-3 flex min-w-0 items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => reopenTaskById(task.id)}
                            title="Reopen task"
                            aria-label="Reopen task"
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${style.bg} text-black opacity-65 transition-all duration-150 ease-out active:scale-90 hover:opacity-95 focus-visible:opacity-100 active:opacity-80`}
                          >
                            {isJustCompleted ? (
                              <motion.span
                                initial={{ scale: 0.72 }}
                                animate={{ scale: [0.72, 1.16, 1] }}
                                transition={{
                                  duration: 0.24,
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
                                  className="h-2.5 w-2.5"
                                >
                                  <motion.path
                                    d="M20 6 9 17l-5-5"
                                    strokeDasharray={24}
                                    initial={{ strokeDashoffset: 24 }}
                                    animate={{ strokeDashoffset: 0 }}
                                    transition={{
                                      duration: 0.2,
                                      ease: [0.22, 1, 0.36, 1],
                                    }}
                                  />
                                </svg>
                              </motion.span>
                            ) : (
                              <Check className="h-2.5 w-2.5 stroke-[2.5]" />
                            )}
                          </button>
                          <span className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-2.5 py-0.5 text-[11px] text-neutral-400">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.bg}`}
                            />
                            <span className="max-w-[115px] truncate" title={questLabel}>
                              {questLabel}
                            </span>
                          </span>
                        </div>

                        <ConfirmDeleteButton
                          label="Delete task"
                          onConfirm={() => deleteTask(task.id)}
                          className="shrink-0 text-hud-muted opacity-0 hover:text-[#ff2a5f] group-hover:opacity-100 focus-visible:opacity-100 data-[state=armed]:opacity-100 [transition-property:color,opacity]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </ConfirmDeleteButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {hasVisiblePendingTasks && (
        <p className="mt-4 text-center text-xs text-hud-muted">
          Alt+Shift+←/→ moves a task to the previous or next day
        </p>
      )}
    </div>
  );
}
