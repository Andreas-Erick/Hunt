"use client";

import React, { memo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, CheckCircle2, Play, Plus, RotateCcw, SlidersHorizontal, Trash2 } from "lucide-react";
import type { Quest, QuestAccent, Task } from "@/lib/domainTypes";
import { accentStyle } from "@/lib/questAccents";
import { formatChronoMMSS } from "@/lib/dateUtils";
import { formatTelemetryDuration } from "@/lib/reviewAnalytics";
import { hudAudio } from "@/lib/hudAudio";
import { MAX_LONG_TEXT_LENGTH, MAX_TASK_TITLE_LENGTH } from "@/lib/syncTypes";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { HeightReveal } from "./HeightReveal";
import { RowTick } from "./RowTick";

/** Armed text of a quest's Complete: completing moves open tasks to Other work. */
function completeQuestConfirmLabel(openTaskCount: number): string {
  if (openTaskCount === 0) return "Complete quest?";
  const tasks = openTaskCount === 1 ? "open task moves" : "open tasks move";
  return `Complete quest? ${openTaskCount} ${tasks} to Other work`;
}

export type CreateTaskFn = (params: {
  title: string;
  notes?: string;
  questId: string | null;
  promoteToTop?: boolean;
}) => Promise<boolean>;

const QUEST_CARD_LAYOUT_TRANSITION = {
  layout: {
    type: "spring",
    stiffness: 300,
    damping: 30,
    mass: 0.9,
  },
} as const;

export interface QuestCardProps {
  quest: Quest;
  weeklySeconds: number;
  pct: number;
  weekLogsLoaded: boolean;
  questTasks: readonly Task[];
  tasksLoaded: boolean;
  isEditing: boolean;
  /** The edit drawer, only for the card being edited (null otherwise). */
  editDrawer: React.ReactNode;
  flowRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onCompleteQuest: (questId: string) => Promise<void>;
  onToggleEdit: (quest: Quest, toggle: HTMLButtonElement) => void;
  onCompleteStep: (taskId: string, questId: string, accent: QuestAccent) => void;
  onStartFocus: (taskId: string) => void;
  createTask: CreateTaskFn;
}

/**
 * One active quest card. Memoized with stable callbacks and its own quick-add
 * state, so typing in any form re-renders (and framer re-measures) only the
 * card that changed instead of every card in the LayoutGroup.
 */
export const QuestCard = memo(function QuestCard({
  quest,
  weeklySeconds,
  pct,
  weekLogsLoaded,
  questTasks,
  tasksLoaded,
  isEditing,
  editDrawer,
  flowRefs,
  onCompleteQuest,
  onToggleEdit,
  onCompleteStep,
  onStartFocus,
  createTask,
}: QuestCardProps) {
  const style = accentStyle(quest.accentColor);
  const [quickTask, setQuickTask] = useState("");
  const [quickNotes, setQuickNotes] = useState("");
  // Set while this card's quick-add write is in flight.
  const quickAddInFlight = useRef(false);

  const handleQuickAdd = async () => {
    const text = quickTask.trim();
    const rawNotes = quickNotes;
    const trimmedNotes = rawNotes.trim();
    if (!text || quickAddInFlight.current) return;
    quickAddInFlight.current = true;
    setQuickTask("");
    setQuickNotes("");
    hudAudio.playClick();
    let created = false;
    try {
      created = await createTask({
        title: text,
        questId: quest.id,
        promoteToTop: false,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } finally {
      quickAddInFlight.current = false;
      if (!created) {
        setQuickTask((prev) => (prev === "" ? text : prev));
        setQuickNotes((prev) => (prev === "" ? rawNotes : prev));
      }
    }
  };

  return (
    <motion.div
      layout="position"
      layoutId={`quest-card-${quest.id}`}
      transition={QUEST_CARD_LAYOUT_TRANSITION}
      data-testid="quest-card"
      data-quest-id={quest.id}
      className="cq-card flex min-w-0 flex-col justify-between rounded-2xl border border-white/[0.08] bg-surface p-5 sm:p-7"
    >
      <div>
        {/* Top Row: Colored Dot + Quest Title + Complete & Edit Buttons */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span
              className={`mt-2 h-3 w-3 shrink-0 rounded-full ${style.bg}`}
            />
            <h2 className="min-w-0 break-words [text-wrap:balance] text-xl font-medium leading-snug text-white">
              {quest.title}
            </h2>
          </div>

          {/* Not shrink-0: the armed label wraps inside the card instead of spilling past it. */}
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <ConfirmDeleteButton
              label={`Complete quest ${quest.title}`}
              confirmLabel={completeQuestConfirmLabel(questTasks.length)}
              armedClassName="text-hud-emerald font-medium"
              onConfirm={() => onCompleteQuest(quest.id)}
              className="flex min-h-8 coarse:min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:border-success/40 hover:bg-success/10 hover:text-success data-[state=armed]:border-success/45 data-[state=armed]:bg-success/15"
            >
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
              <span>Complete</span>
            </ConfirmDeleteButton>

            <button
              type="button"
              onClick={(e) => onToggleEdit(quest, e.currentTarget)}
              title="Edit or Delete Quest"
              aria-label={`Edit quest ${quest.title}`}
              aria-expanded={isEditing}
              className="shrink-0 rounded-lg p-2 coarse:p-3.5 text-hud-muted hover:bg-white/[0.05] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          </div>
        </div>

        {quest.description && (
          <p className="mt-2.5 max-w-[65ch] break-words text-sm leading-relaxed text-neutral-400">
            {quest.description}
          </p>
        )}

        {/* Inline Edit & Delete Drawer */}
        <HeightReveal show={isEditing}>{editDrawer}</HeightReveal>

        {/* Weekly Quest Hours Progress */}
        <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium text-hud-muted">
              Last 7 days
            </span>
            <span className="text-sm text-neutral-400 tabular-nums">
              <strong className="text-lg font-medium text-white">
                {!weekLogsLoaded
                  ? "–"
                  : formatTelemetryDuration(weeklySeconds, {
                      zeroAs: "0.0h",
                    })}
              </strong>{" "}
              / {quest.targetWeeklyHours}h
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
            {/* Full-width fill slid in from the left (compositor-only);
                the track's overflow-hidden clips it, keeping the rounded end. */}
            <div
              data-testid="quest-progress-fill"
              className={`h-full w-full rounded-full ${style.bg} transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]`}
              style={{ transform: `translateX(${pct - 100}%)` }}
            />
          </div>
        </div>

        {/* Linked Open Tasks */}
        <div
          ref={(el) => {
            flowRefs.current[quest.id] = el;
          }}
          className="relative mt-6 space-y-2.5"
        >
          <div className="text-xs font-medium text-hud-muted">
            Next steps
            {tasksLoaded ? ` (${questTasks.length})` : ""}
          </div>

          {questTasks.map((t) => (
            <div
              key={t.id}
              data-task-id={t.id}
              className="group flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-raised px-4 py-3 text-sm"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <RowTick
                  task={t}
                  onComplete={() => onCompleteStep(t.id, quest.id, quest.accentColor)}
                  className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/25 text-transparent before:absolute before:-inset-2.5 coarse:before:-inset-3.5 before:content-[''] hover:border-success hover:text-success transition-colors duration-150 ease-out active:opacity-80"
                />
                <span
                  data-task-title="true"
                  className="truncate text-neutral-200"
                  title={t.title}
                >
                  {t.title}
                </span>
              </div>

              <button
                type="button"
                onClick={() => onStartFocus(t.id)}
                aria-label={`Start focus: ${t.title}`}
                className="-my-1.5 -mr-2 flex min-h-8 coarse:min-h-11 coarse:min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
              >
                {t.accumulatedSeconds > 0 && (
                  <span className="font-mono tabular-nums">
                    {formatChronoMMSS(t.accumulatedSeconds).formatted}
                  </span>
                )}
                <Play className="h-3.5 w-3.5 fill-current" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Add Task to this Quest */}
      <div className="mt-6 rounded-xl border border-dashed border-white/[0.12] bg-black/20 px-3.5 py-1 transition-colors focus-within:border-white/40">
        <div className="flex items-center gap-2">
          <input
            type="text"
            maxLength={MAX_TASK_TITLE_LENGTH}
            value={quickTask}
            onChange={(e) => setQuickTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleQuickAdd();
              }
            }}
            placeholder={`Add task to ${quest.title}...`}
            aria-label={`Add quest work to ${quest.title}`}
            className="min-h-8 coarse:min-h-11 min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-hud-muted focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleQuickAdd()}
            aria-label={`Add task to ${quest.title}`}
            className="-my-1.5 -mr-2 rounded-lg p-2 coarse:p-3.5 text-neutral-400 hover:bg-white/[0.06] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-1.5 border-t border-white/[0.05] pt-1.5">
          <input
            type="text"
            maxLength={MAX_LONG_TEXT_LENGTH}
            value={quickNotes}
            onChange={(e) => setQuickNotes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleQuickAdd();
              }
            }}
            placeholder="Description (optional)..."
            aria-label={`Task description for ${quest.title} (optional)`}
            className="min-h-8 coarse:min-h-11 w-full bg-transparent text-[11px] text-neutral-200 placeholder:text-hud-muted focus:outline-none"
          />
        </div>
      </div>
    </motion.div>
  );
});

/** One completed quest: its logged hours, Delete, and Reopen. */
export function CompletedQuestCard({
  quest,
  totalSeconds,
  highlighted,
  onDelete,
  onReopen,
}: {
  quest: Quest;
  /** All hours logged to the quest; undefined while the logs load. */
  totalSeconds: number | undefined;
  /** Just completed: the card glows for a moment. */
  highlighted: boolean;
  onDelete: (questId: string) => Promise<void>;
  onReopen: (questId: string) => Promise<void>;
}) {
  const style = accentStyle(quest.accentColor);
  return (
    <motion.div
      layout="position"
      layoutId={`quest-card-${quest.id}`}
      transition={QUEST_CARD_LAYOUT_TRANSITION}
      data-testid="completed-quest-card"
      data-quest-id={quest.id}
      className={`cq-card flex min-w-0 flex-col justify-between rounded-2xl border bg-sunken/80 p-5 sm:p-6 transition-[border-color,box-shadow] duration-500 ease-out ${
        highlighted
          ? "border-success/40 shadow-card-success"
          : "border-white/[0.06]"
      }`}
    >
      <div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span
              className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${style.bg} opacity-65`}
            />
            <h3 className="min-w-0 break-words [text-wrap:balance] text-lg font-medium leading-snug text-neutral-200">
              {quest.title}
            </h3>
          </div>

          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-success/30 bg-success/10 px-2.5 py-0.5 text-[11px] font-medium text-success">
            <Check className="h-3 w-3 stroke-[2.5]" aria-hidden="true" />
            <span>Completed</span>
          </span>
        </div>

        {quest.description && (
          <p className="mt-2 max-w-[65ch] break-words text-xs leading-relaxed text-hud-muted">
            {quest.description}
          </p>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4 text-xs">
        <ConfirmDeleteButton
          label={`Delete quest ${quest.title}`}
          confirmLabel="Delete quest?"
          onConfirm={() => onDelete(quest.id)}
          className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg px-3 py-1.5 text-xs text-hud-muted hover:bg-danger/10 hover:text-danger data-[state=armed]:bg-danger/20 data-[state=armed]:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Delete</span>
        </ConfirmDeleteButton>

        <div className="flex items-center gap-3">
          <span className="text-hud-muted tabular-nums">
            {totalSeconds === undefined
              ? "–"
              : `${formatTelemetryDuration(totalSeconds ?? 0, {
                  zeroAs: "0.0h",
                })} logged`}
          </span>
          <button
            type="button"
            onClick={() => void onReopen(quest.id)}
            aria-label={`Reopen quest ${quest.title}`}
            className="flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-white/25 hover:bg-white/[0.08] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Reopen</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

/** Layout-matching skeleton cards while IndexedDB resolves (no empty-state flash or CLS). */
export function QuestCardSkeletons() {
  return (
    <div
      aria-busy="true"
      data-testid="quests-loading-skeleton"
      className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6 sm:gap-8"
    >
      {[0, 1, 2].map((slot) => (
        <div
          key={slot}
          className="flex min-h-[320px] flex-col justify-between rounded-2xl border border-white/[0.06] bg-surface/70 p-5 sm:p-7"
        >
          <div className="space-y-4">
            <div className="h-6 w-2/3 animate-pulse rounded-lg bg-white/[0.06]" />
            <div className="h-4 w-full animate-pulse rounded-lg bg-white/[0.04]" />
            <div className="mt-6 h-20 w-full animate-pulse rounded-xl bg-white/[0.03]" />
          </div>
          <div className="mt-6 h-10 w-full animate-pulse rounded-xl bg-white/[0.03]" />
        </div>
      ))}
    </div>
  );
}
