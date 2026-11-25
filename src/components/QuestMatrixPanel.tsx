"use client";

import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { LayoutGroup } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import { BookOpen, Plus } from "lucide-react";
import type { Quest, QuestAccent, Task } from "@/lib/domainTypes";
import { accentColor, accentStyle } from "@/lib/questAccents";
import { isOpenTask } from "@/lib/dateUtils";
import { useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import {
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
  type TaskCompletionScene,
} from "@/lib/taskCompletionMotion";
import { confirmDiscard, confirmLeaveDirty, useDiscardGuard } from "./useDiscardGuard";
import { useTodayDateKey } from "./useTodayDateKey";
import { useTransientHighlight } from "./useTransientHighlight";
import { useQuestWeekLogs } from "./useQuestWeekLogs";
import { useLiveBurstSeconds } from "./useLiveBurstSeconds";
import { computeQuestWeekProgress } from "@/lib/questProgress";
import { HeightReveal } from "./HeightReveal";
import { CompletedQuestCard, QuestCard, QuestCardSkeletons } from "./QuestCard";
import { AccentPills, QuestEditDrawer, QuestTextFields, WeeklyTargetField } from "./QuestFormFields";

/** The running burst only moves a progress bar by ~1 % per 36 s at the 1 h minimum target. */
const LIVE_PROGRESS_TICK_MS = 15_000;
/**
 * How long (ms) a just-completed quest card stays highlighted in Completed
 * quests. Separate from the task-card COMPLETION_HIGHLIGHT_MS (650).
 */
const QUEST_COMPLETION_HIGHLIGHT_MS = 700;
/** Shared value for a quest with no open tasks. */
const NO_TASKS: readonly Task[] = Object.freeze([]);

/**
 * Open tasks (isOpenTask: queued or active, minus missed daily habit days)
 * grouped by quest, each in rank order: one pass over the table instead of a
 * scan per quest card.
 */
function groupOpenTasksByQuest(
  tasks: readonly Task[],
  todayKey: string
): Map<string, Task[]> {
  const byQuest = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.questId || !isOpenTask(t, todayKey)) continue;
    const list = byQuest.get(t.questId);
    if (list) list.push(t);
    else byQuest.set(t.questId, [t]);
  }
  byQuest.forEach((list) => list.sort(compareRank));
  return byQuest;
}

/**
 * A callback whose identity never changes but always runs the latest `fn`, so
 * memoized quest cards are not re-rendered by a new closure on every keystroke.
 */
function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback(
    ((...args: Parameters<T>) => ref.current(...args)) as T,
    []
  );
}

export function QuestMatrixPanel() {
  const {
    setActiveView,
    initializeFocus,
    createTask,
    completeTaskById,
    createQuest,
    updateQuest,
    completeQuest,
    reopenQuest,
    deleteQuest,
    activeTaskId,
    isRunning,
    sessionStartedAt,
  } = useCommandStore(
    useShallow((s) => ({
      activeTaskId: s.activeTaskId,
      isRunning: s.isRunning,
      sessionStartedAt: s.sessionStartedAt,
      setActiveView: s.setActiveView,
      initializeFocus: s.initializeFocus,
      createTask: s.createTask,
      completeTaskById: s.completeTaskById,
      createQuest: s.createQuest,
      updateQuest: s.updateQuest,
      completeQuest: s.completeQuest,
      reopenQuest: s.reopenQuest,
      deleteQuest: s.deleteQuest,
    }))
  );

  const quests = useLiveQuery(reads.quests, []);
  const allTasks = useLiveQuery(reads.allTasks, []);

  const activeQuests = useMemo(
    () => (quests ?? []).filter((q) => !q.archived),
    [quests]
  );

  const completedQuests = useMemo(
    () =>
      (quests ?? [])
        .filter((q) => q.archived)
        .sort(
          (a, b) =>
            (b.completedAt ?? b.updatedAt ?? 0) -
            (a.completedAt ?? a.updatedAt ?? 0)
        ),
    [quests]
  );

  const completedQuestIdsKey = useMemo(
    () => completedQuests.map((q) => q.id).join(","),
    [completedQuests]
  );

  // Indexed read of total logged hours for completed quests only (zero reads when none).
  const completedQuestLogs = useLiveQuery(
    () => reads.logsForQuests(completedQuestIdsKey ? completedQuestIdsKey.split(",") : []),
    [completedQuestIdsKey]
  );

  const totalSecondsByCompletedQuest = useMemo(() => {
    const totals = new Map<string, number>();
    for (const log of completedQuestLogs ?? []) {
      if (!log.questId) continue;
      totals.set(log.questId, (totals.get(log.questId) ?? 0) + log.durationSeconds);
    }
    return totals;
  }, [completedQuestLogs]);

  // Recomputed when the day changes (the view can stay open past midnight).
  const todayKey = useTodayDateKey();
  // Regrouped only when the tasks or the day change, not on every keystroke in
  // the quick-add, edit or new-quest fields.
  const openTasksByQuest = useMemo(
    () => groupOpenTasksByQuest(allTasks ?? [], todayKey),
    [allTasks, todayKey]
  );
  const weekLogs = useQuestWeekLogs(todayKey);
  const liveBurstSeconds = useLiveBurstSeconds(
    isRunning ? sessionStartedAt : null,
    LIVE_PROGRESS_TICK_MS
  );
  const liveQuestId = useMemo(
    () => (allTasks ?? []).find((t) => t.id === activeTaskId)?.questId ?? null,
    [allTasks, activeTaskId]
  );
  // Same rule as Home (logs of the rolling week plus the running burst).
  const questWeek = useMemo(
    () =>
      computeQuestWeekProgress({
        quests: quests ?? [],
        logs: weekLogs ?? [],
        todayKey,
        live:
          liveBurstSeconds > 0
            ? { questId: liveQuestId, seconds: liveBurstSeconds }
            : null,
      }),
    [quests, weekLogs, todayKey, liveQuestId, liveBurstSeconds]
  );

  const ids = useId();

  // Edit drawer (one quest at a time); the target is kept as typed.
  const [editingQuest, setEditingQuest] = useState<Quest | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAccent, setEditAccent] = useState<QuestAccent>("cyan");
  const [editTarget, setEditTarget] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  // The edit toggle that opened the drawer; focus returns there on close.
  const editToggleRef = useRef<HTMLButtonElement | null>(null);

  // New Quest form
  const [creatingNew, setCreatingNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAccent, setNewAccent] = useState<QuestAccent>("cyan");
  const [newTarget, setNewTarget] = useState("10");
  // Set synchronously by the first submit; drops submits that arrive before
  // React re-renders with the cleared title.
  const creatingQuestRef = useRef(false);
  const newQuestToggleRef = useRef<HTMLButtonElement | null>(null);

  const editIsDirty = () =>
    editingQuest !== null &&
    (editTitle !== editingQuest.title ||
      editDesc !== (editingQuest.description ?? "") ||
      editAccent !== editingQuest.accentColor ||
      editTarget !== String(editingQuest.targetWeeklyHours));

  const newQuestIsDirty = () =>
    newTitle.trim() !== "" || newDesc.trim() !== "";

  useDiscardGuard(editIsDirty() || newQuestIsDirty(), confirmLeaveDirty);

  const startEdit = (q: Quest, toggle: HTMLButtonElement) => {
    hudAudio.playClick();
    if (!confirmDiscard(editIsDirty())) return;
    if (editingQuest?.id === q.id) {
      setEditingQuest(null);
      return;
    }
    editToggleRef.current = toggle;
    setEditingQuest(q);
    setEditTitle(q.title);
    setEditDesc(q.description ?? "");
    setEditAccent(q.accentColor);
    setEditTarget(String(q.targetWeeklyHours));
  };

  const closeEdit = () => {
    setEditingQuest(null);
    editToggleRef.current?.focus();
  };

  const cancelEdit = () => {
    if (confirmDiscard(editIsDirty())) closeEdit();
  };

  const saveEdit = async (form: HTMLFormElement) => {
    if (!editingQuest || savingEditRef.current) return;
    const target = Number(editTarget);
    // Native checks: a non-blank title and a target within min/max.
    if (!form.checkValidity() || !Number.isFinite(target)) {
      form.reportValidity();
      return;
    }
    savingEditRef.current = true;
    setSavingEdit(true);
    hudAudio.playClick();
    const questId = editingQuest.id;
    const toggle = editToggleRef.current;
    try {
      // false: the local write failed (shown through actionError); the drawer
      // stays open with the edits.
      const saved = await updateQuest(questId, {
        title: editTitle,
        description: editDesc,
        accentColor: editAccent,
        targetWeeklyHours: target,
      });
      if (saved) {
        setEditingQuest((current) => (current?.id === questId ? null : current));
        // Unless another quest's drawer was opened meanwhile.
        if (editToggleRef.current === toggle) toggle?.focus();
      }
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  const questFlowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const pendingTaskSceneRef = useRef<{
    questId: string;
    scene: TaskCompletionScene;
  } | null>(null);

  const handleCompleteQuestStep = (
    taskId: string,
    questId: string,
    accent: QuestAccent
  ) => {
    const scene = captureTaskCompletionScene(
      questFlowRefs.current[questId] ?? null,
      taskId,
      accentColor(accentStyle(accent))
    );
    pendingTaskSceneRef.current = scene ? { questId, scene } : null;
    hudAudio.playComplete();
    void completeTaskById(taskId);
  };

  useLayoutEffect(() => {
    const pending = pendingTaskSceneRef.current;
    if (!pending) return;
    const done = (allTasks ?? []).some(
      (t) => t.id === pending.scene.taskId && t.status === "completed"
    );
    if (!done) return;
    pendingTaskSceneRef.current = null;
    return playTwoBeatTaskCompletion(
      questFlowRefs.current[pending.questId] ?? null,
      pending.scene
    );
  }, [allTasks]);

  const [justCompletedQuestId, flashJustCompletedQuest] = useTransientHighlight(
    QUEST_COMPLETION_HIGHLIGHT_MS
  );

  const handleCompleteQuest = async (questId: string) => {
    flashJustCompletedQuest(questId);
    hudAudio.playComplete();
    setEditingQuest((current) => (current?.id === questId ? null : current));
    await completeQuest(questId);
  };

  const handleReopenQuest = async (questId: string) => {
    hudAudio.playLockOn();
    await reopenQuest(questId);
  };

  const handleDeleteQuest = async (questId: string) => {
    hudAudio.playClick();
    await deleteQuest(questId);
    setEditingQuest((current) => (current?.id === questId ? null : current));
  };

  /** Closes the New Quest form, discarding typed text after a confirm. */
  const closeCreateForm = (): boolean => {
    if (!confirmDiscard(newQuestIsDirty())) return false;
    setNewTitle("");
    setNewDesc("");
    setCreatingNew(false);
    return true;
  };

  const cancelCreate = () => {
    if (closeCreateForm()) newQuestToggleRef.current?.focus();
  };

  const handleCreateQuest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const title = newTitle.trim();
    if (!title || creatingQuestRef.current) return;
    const target = Number(newTarget);
    if (!form.checkValidity() || !Number.isFinite(target)) {
      form.reportValidity();
      return;
    }
    creatingQuestRef.current = true;
    const description = newDesc;
    // Cleared before the write, so a second click or Enter finds nothing to create.
    setNewTitle("");
    setNewDesc("");
    hudAudio.playComplete();
    let created = false;
    try {
      created = await createQuest({
        title,
        description,
        accentColor: newAccent,
        targetWeeklyHours: target,
      });
    } finally {
      creatingQuestRef.current = false;
      if (created) {
        setCreatingNew(false);
      } else {
        // The write failed: give the text back unless something new was typed.
        setNewTitle((current) => (current === "" ? title : current));
        setNewDesc((current) => (current === "" ? description : current));
      }
    }
  };

  // Stable identities for the memoized quest cards (they always call the
  // latest handler, which reads the current drawer state).
  const onToggleEdit = useStableCallback(startEdit);
  const onCompleteQuest = useStableCallback(handleCompleteQuest);
  const onCompleteStep = useStableCallback(handleCompleteQuestStep);
  const onStartFocus = useStableCallback((taskId: string) => {
    hudAudio.playLockOn();
    initializeFocus(taskId);
  });
  const createQuestTask = useStableCallback(createTask);

  /** Inline Edit & Delete drawer of the quest being edited. */
  const renderEditDrawer = (quest: Quest, questTasks: readonly Task[]) => (
    <QuestEditDrawer
      quest={quest}
      openTaskCount={questTasks.length}
      idPrefix={`${ids}-edit`}
      title={editTitle}
      onTitleChange={setEditTitle}
      description={editDesc}
      onDescriptionChange={setEditDesc}
      accent={editAccent}
      onAccentChange={setEditAccent}
      target={editTarget}
      onTargetChange={setEditTarget}
      saving={savingEdit}
      onSave={(form) => void saveEdit(form)}
      onCancel={cancelEdit}
      onDelete={handleDeleteQuest}
    />
  );

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      {/* Page Heading + New Quest Button */}
      <div className="mb-8 sm:mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium leading-tight tracking-tight text-white">
            Quests
          </h1>
          <p className="mt-2 max-w-[65ch] text-sm text-neutral-400">
            Connect your high-level ambitions to weekly input hours and daily
            tasks.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              hudAudio.playClick();
              setActiveView("guide");
            }}
            className="flex coarse:min-h-11 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-medium text-neutral-300 hover:border-white/25 hover:text-white transition-colors duration-150 ease-out active:opacity-80"
          >
            <BookOpen className="h-4 w-4 text-hud-cyan" aria-hidden="true" />
            <span>Quest Guide</span>
          </button>

          <button
            ref={newQuestToggleRef}
            type="button"
            aria-expanded={creatingNew}
            onClick={() => {
              hudAudio.playClick();
              if (creatingNew) closeCreateForm();
              else setCreatingNew(true);
            }}
            className={`flex coarse:min-h-11 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.98] ${
              // While the form is open this acts as its close toggle: secondary
              // style, so only "Create Quest" reads as the primary action.
              creatingNew
                ? "border border-white/15 bg-white/[0.04] text-neutral-300 hover:border-white/25 hover:text-white"
                : "border border-transparent bg-accent text-black hover:bg-white"
            }`}
          >
            <Plus className="h-4 w-4" />
            <span>New Quest</span>
          </button>
        </div>
      </div>

      {/* Inline Create Quest Form */}
      <HeightReveal show={creatingNew}>
        <form
          onSubmit={handleCreateQuest}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelCreate();
          }}
          className="cq-card mb-8 rounded-2xl border border-accent/30 bg-surface p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium text-white">
              Create New Quest
            </h2>
            <button
              type="button"
              onClick={cancelCreate}
              className="-my-1.5 -mr-2.5 min-h-8 coarse:min-h-11 rounded-lg px-2.5 py-1.5 text-xs text-hud-muted hover:bg-white/[0.06] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
            >
              Cancel
            </button>
          </div>

          <QuestTextFields
            variant="create"
            idPrefix={`${ids}-new`}
            title={newTitle}
            onTitleChange={setNewTitle}
            description={newDesc}
            onDescriptionChange={setNewDesc}
          />

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
            <div className="flex flex-wrap items-center gap-4">
              <AccentPills value={newAccent} onChange={setNewAccent} />

              <WeeklyTargetField
                value={newTarget}
                onChange={setNewTarget}
                className="flex items-center gap-2 text-xs text-neutral-400"
              />
            </div>

            <button
              type="submit"
              disabled={!newTitle.trim()}
              className="coarse:min-h-11 rounded-xl bg-accent px-5 py-2 text-xs font-semibold text-black hover:bg-white transition-[background-color,opacity,transform] duration-150 ease-out active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
            >
              Create Quest
            </button>
          </div>
        </form>
      </HeightReveal>

      <LayoutGroup id="quests-matrix">
      {/* Intrinsic Fluid Quest Grid (1 col -> 2 col split-screen -> 3 col desktop) */}
      {quests === undefined ? (
        <QuestCardSkeletons />
      ) : activeQuests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-hud-muted">
          No active Quests. Click <strong>+ New Quest</strong> above to create
          one.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6 sm:gap-8">
          {activeQuests.map((quest) => {
            const { weekSeconds: weeklySeconds, pct } =
              questWeek.forQuest(quest);
            const isEditing = editingQuest?.id === quest.id;
            const questTasks = openTasksByQuest.get(quest.id) ?? NO_TASKS;

            return (
              <QuestCard
                key={quest.id}
                quest={quest}
                weeklySeconds={weeklySeconds}
                pct={pct}
                weekLogsLoaded={weekLogs !== undefined}
                questTasks={questTasks}
                tasksLoaded={allTasks !== undefined}
                isEditing={isEditing}
                editDrawer={isEditing ? renderEditDrawer(quest, questTasks) : null}
                flowRefs={questFlowRefs}
                onCompleteQuest={onCompleteQuest}
                onToggleEdit={onToggleEdit}
                onCompleteStep={onCompleteStep}
                onStartFocus={onStartFocus}
                createTask={createQuestTask}
              />
            );
          })}
        </div>
      )}

      {/* Completed Quests Section */}
      {completedQuests.length > 0 && (
        <section
          aria-label="Completed Quests"
          className="mt-14 space-y-5"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-hud-muted tabular-nums">
              Completed Quests ({completedQuests.length})
            </h2>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6">
            {completedQuests.map((quest) => (
              <CompletedQuestCard
                key={quest.id}
                quest={quest}
                totalSeconds={
                  completedQuestLogs === undefined
                    ? undefined
                    : totalSecondsByCompletedQuest.get(quest.id) ?? 0
                }
                highlighted={justCompletedQuestId === quest.id}
                onDelete={handleDeleteQuest}
                onReopen={handleReopenQuest}
              />
            ))}
          </div>
        </section>
      )}
      </LayoutGroup>
    </div>
  );
}
