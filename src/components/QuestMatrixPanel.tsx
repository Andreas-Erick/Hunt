"use client";

import React, {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { LayoutGroup, motion } from "framer-motion";
import { useShallow } from "zustand/react/shallow";
import {
  BookOpen,
  Check,
  CheckCircle2,
  RotateCcw,
  SlidersHorizontal,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  db,
  QUEST_ACCENT_KEYS,
  QUEST_ACCENT_STYLES,
  accentStyle,
  dateKeyFromOffset,
  isOpenTask,
  loadSortedQuests,
  formatChronoMMSS,
  type Quest,
  type QuestAccent,
  type Task,
  type TimeLog,
} from "@/lib/db";
import { formatTelemetryDuration } from "@/lib/reviewAnalytics";
import { useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import {
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
  type TaskCompletionScene,
} from "@/lib/taskCompletionMotion";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { useDiscardGuard } from "./useDiscardGuard";
import { useTodayDateKey } from "./useTodayDateKey";
import { useTransientHighlight } from "./useTransientHighlight";

const DISCARD_PROMPT = "Discard unsaved changes?";
/** Quest hours cover today and the 6 days before it. */
const WEEK_DAYS = 7;
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
/** Native `pattern` (matched against the whole value): at least one non-space character. */
const NON_BLANK_PATTERN = ".*\\S.*";

const ACCENT_OPTIONS: ReadonlyArray<{ id: QuestAccent; label: string }> =
  QUEST_ACCENT_KEYS.map((id) => ({
    id,
    label: QUEST_ACCENT_STYLES[id].label,
  }));

/** Armed text of a quest's Complete: completing moves open tasks to Other work. */
function completeQuestConfirmLabel(openTaskCount: number): string {
  if (openTaskCount === 0) return "Complete quest?";
  const tasks = openTaskCount === 1 ? "open task moves" : "open tasks move";
  return `Complete quest? ${openTaskCount} ${tasks} to Other work`;
}

/** Armed text of a quest's Delete: deleting moves its tasks to Other work. */
function deleteQuestConfirmLabel(openTaskCount: number): string {
  if (openTaskCount === 0) return "Delete quest?";
  const tasks = openTaskCount === 1 ? "open task moves" : "open tasks move";
  return `Delete quest? ${openTaskCount} ${tasks} to Other work`;
}

/** Nothing to lose, or the user agreed to discard it. */
function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm(DISCARD_PROMPT);
}

/** Discard guard for leaving the Quests view with unsaved form edits. */
const confirmLeaveDirty = () => confirmDiscard(true);

function AccentPills({
  value,
  onChange,
  compact = false,
}: {
  value: QuestAccent;
  onChange: (accent: QuestAccent) => void;
  compact?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Quest color"
      className="flex flex-wrap items-center gap-1.5"
    >
      {ACCENT_OPTIONS.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.id)}
            className={`flex items-center rounded-full border py-1 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
              compact ? "gap-1.5 px-2.5" : "gap-2 px-3"
            } ${
              selected
                ? "border-white/30 bg-white/10 text-white"
                : compact
                ? "border-white/10 text-hud-muted"
                : "border-white/10 text-neutral-400"
            }`}
          >
            <span
              className={`${compact ? "h-2 w-2" : "h-2.5 w-2.5"} rounded-full ${
                QUEST_ACCENT_STYLES[opt.id].bg
              }`}
            />
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Weekly hours as typed (a string, so it can be cleared while editing). The
 * native required/min/max checks run on submit; "any" step keeps fractional
 * targets saved elsewhere editable.
 */
function WeeklyTargetInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="number"
      required
      min={1}
      max={100}
      step="any"
      aria-label="Weekly target hours"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-16 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-hud-cyan focus:outline-none"
    />
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
  } = useCommandStore(
    useShallow((s) => ({
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

  const quests = useLiveQuery(() => loadSortedQuests(), []);
  const allTasks = useLiveQuery(() => db.tasks.toArray(), []);

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
    () => {
      const ids = completedQuestIdsKey ? completedQuestIdsKey.split(",") : [];
      if (ids.length === 0) return Promise.resolve([] as TimeLog[]);
      return db.timeLogs.where("questId").anyOf(ids).toArray();
    },
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
  // Today and the 6 days before it, stepped from a noon anchor (DST-safe).
  const weekDateKeys = useMemo(
    () =>
      Array.from({ length: WEEK_DAYS }, (_, i) =>
        dateKeyFromOffset(todayKey, -i)
      ),
    [todayKey]
  );
  // Only this week's logs are read (dateKey is indexed), never the whole history.
  const weekLogs = useLiveQuery(
    () => db.timeLogs.where("dateKey").anyOf(weekDateKeys).toArray(),
    [todayKey]
  );
  const weeklySecondsByQuest = useMemo(() => {
    const totals = new Map<string, number>();
    for (const log of weekLogs ?? []) {
      if (!log.questId) continue;
      totals.set(log.questId, (totals.get(log.questId) ?? 0) + log.durationSeconds);
    }
    return totals;
  }, [weekLogs]);

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

  const [quickTaskByQuest, setQuickTaskByQuest] = useState<
    Record<string, string>
  >({});
  const [quickNotesByQuest, setQuickNotesByQuest] = useState<
    Record<string, string>
  >({});
  // Quest ids whose quick-add write is in flight.
  const quickAddInFlight = useRef(new Set<string>());

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
      accentStyle(accent).hex
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

  const handleQuickAdd = async (questId: string) => {
    const text = (quickTaskByQuest[questId] ?? "").trim();
    const rawNotes = quickNotesByQuest[questId] ?? "";
    const trimmedNotes = rawNotes.trim();
    if (!text || quickAddInFlight.current.has(questId)) return;
    quickAddInFlight.current.add(questId);
    setQuickTaskByQuest((prev) => ({ ...prev, [questId]: "" }));
    setQuickNotesByQuest((prev) => ({ ...prev, [questId]: "" }));
    hudAudio.playClick();
    let created = false;
    try {
      created = await createTask({
        title: text,
        questId,
        promoteToTop: false,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } finally {
      quickAddInFlight.current.delete(questId);
      if (!created) {
        setQuickTaskByQuest((prev) =>
          (prev[questId] ?? "") === "" ? { ...prev, [questId]: text } : prev
        );
        setQuickNotesByQuest((prev) =>
          (prev[questId] ?? "") === "" ? { ...prev, [questId]: rawNotes } : prev
        );
      }
    }
  };

  const newTitleId = `${ids}-new-title`;
  const newDescId = `${ids}-new-desc`;
  const editTitleId = `${ids}-edit-title`;
  const editDescId = `${ids}-edit-desc`;

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
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-xs font-medium text-neutral-300 hover:border-white/25 hover:text-white transition-colors duration-150 ease-out active:opacity-80"
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
            className="flex items-center gap-2 rounded-xl bg-[#00f0ff] px-4 py-2.5 text-xs font-semibold text-black hover:bg-white transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span>New Quest</span>
          </button>
        </div>
      </div>

      {/* Inline Create Quest Form */}
      {creatingNew && (
        <form
          onSubmit={handleCreateQuest}
          onKeyDown={(e) => {
            if (e.key === "Escape") cancelCreate();
          }}
          className="cq-card mb-8 rounded-2xl border border-[#00f0ff]/30 bg-[#111318] p-5 sm:p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-base font-medium text-white">
              Create New Quest
            </h2>
            <button
              type="button"
              onClick={cancelCreate}
              className="text-xs text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
            >
              Cancel
            </button>
          </div>

          <div className="cq-form-two-col">
            <div>
              <label
                htmlFor={newTitleId}
                className="mb-1 block text-xs text-neutral-400"
              >
                Quest Title
              </label>
              <input
                id={newTitleId}
                type="text"
                required
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="e.g. Launch my idea"
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-white focus:border-[#00f0ff] focus:outline-none"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <label
                  htmlFor={newDescId}
                  className="block text-xs text-neutral-400"
                >
                  Description
                </label>
                <span className="text-[11px] text-hud-muted">Optional</span>
              </div>
              <input
                id={newDescId}
                type="text"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="What moves this quest forward?"
                className="w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-neutral-200 placeholder:text-hud-muted focus:border-[#00f0ff] focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
            <div className="flex flex-wrap items-center gap-4">
              <AccentPills value={newAccent} onChange={setNewAccent} />

              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <span>Weekly Target:</span>
                <WeeklyTargetInput value={newTarget} onChange={setNewTarget} />
                <span>h/wk</span>
              </div>
            </div>

            <button
              type="submit"
              disabled={!newTitle.trim()}
              className="rounded-xl bg-[#00f0ff] px-5 py-2 text-xs font-semibold text-black hover:bg-white disabled:opacity-40"
            >
              Create Quest
            </button>
          </div>
        </form>
      )}

      <LayoutGroup id="quests-matrix">
      {/* Intrinsic Fluid Quest Grid (1 col -> 2 col split-screen -> 3 col desktop) */}
      {quests === undefined ? (
        // Layout-matching skeleton cards while IndexedDB resolves (no empty-state flash or CLS).
        <div
          aria-busy="true"
          data-testid="quests-loading-skeleton"
          className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6 sm:gap-8"
        >
          {[0, 1, 2].map((slot) => (
            <div
              key={slot}
              className="flex min-h-[320px] flex-col justify-between rounded-2xl border border-white/[0.06] bg-[#111318]/70 p-5 sm:p-7"
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
      ) : activeQuests.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 py-16 text-center text-sm text-hud-muted">
          No active Quests. Click <strong>+ New Quest</strong> above to create
          one.
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6 sm:gap-8">
          {activeQuests.map((quest) => {
            const style = accentStyle(quest.accentColor);
            const weeklySeconds = weeklySecondsByQuest.get(quest.id) ?? 0;

            const weeklyHours = weeklySeconds / 3600;
            const pct = Math.min(
              100,
              Math.round(
                (weeklyHours / Math.max(1, quest.targetWeeklyHours)) * 100
              )
            );
            const isEditing = editingQuest?.id === quest.id;

            const questTasks = openTasksByQuest.get(quest.id) ?? NO_TASKS;

            return (
              <motion.div
                layout="position"
                layoutId={`quest-card-${quest.id}`}
                transition={{
                  layout: {
                    type: "spring",
                    stiffness: 300,
                    damping: 30,
                    mass: 0.9,
                  },
                }}
                key={quest.id}
                data-testid="quest-card"
                data-quest-id={quest.id}
                className="cq-card flex min-w-0 flex-col justify-between rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7"
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

                    <div className="flex shrink-0 items-center gap-2">
                      <ConfirmDeleteButton
                        label={`Complete quest ${quest.title}`}
                        confirmLabel={completeQuestConfirmLabel(
                          questTasks.length
                        )}
                        armedClassName="text-hud-emerald font-medium"
                        onConfirm={() => handleCompleteQuest(quest.id)}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs text-neutral-300 hover:border-[#00ff9d]/40 hover:bg-[#00ff9d]/10 hover:text-[#00ff9d] data-[state=armed]:border-[#00ff9d]/45 data-[state=armed]:bg-[#00ff9d]/15"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 text-[#00ff9d]" />
                        <span>Complete</span>
                      </ConfirmDeleteButton>

                      <button
                        type="button"
                        onClick={(e) => startEdit(quest, e.currentTarget)}
                        title="Edit or Delete Quest"
                        aria-label={`Edit quest ${quest.title}`}
                        aria-expanded={isEditing}
                        className="shrink-0 rounded-lg p-2 text-hud-muted hover:bg-white/[0.05] hover:text-white transition-colors"
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
                  {isEditing && (
                    <form
                      aria-label={`Edit quest ${quest.title}`}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveEdit(e.currentTarget);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") cancelEdit();
                      }}
                      className="mt-5 rounded-xl border border-white/10 bg-[#0b0c0e] p-4 space-y-3.5"
                    >
                      <div>
                        <label
                          htmlFor={editTitleId}
                          className="mb-1 block text-xs text-neutral-400"
                        >
                          Quest Title
                        </label>
                        <input
                          id={editTitleId}
                          type="text"
                          required
                          autoFocus
                          pattern={NON_BLANK_PATTERN}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-[#00f0ff] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor={editDescId}
                          className="mb-1 block text-xs text-neutral-400"
                        >
                          Description
                        </label>
                        <input
                          id={editDescId}
                          type="text"
                          value={editDesc}
                          onChange={(e) => setEditDesc(e.target.value)}
                          className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-xs text-neutral-200 focus:border-[#00f0ff] focus:outline-none"
                        />
                      </div>

                      <AccentPills
                        compact
                        value={editAccent}
                        onChange={setEditAccent}
                      />

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-2 text-xs text-neutral-400">
                          <span>Weekly Goal:</span>
                          <WeeklyTargetInput
                            value={editTarget}
                            onChange={setEditTarget}
                          />
                          <span>h/wk</span>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <ConfirmDeleteButton
                            label="Delete quest"
                            confirmLabel={deleteQuestConfirmLabel(
                              questTasks.length
                            )}
                            onConfirm={() => handleDeleteQuest(quest.id)}
                            className="flex items-center gap-1 rounded-lg border border-[#ff2a5f]/30 bg-[#ff2a5f]/10 px-2.5 py-1.5 text-xs text-[#ff2a5f] hover:bg-[#ff2a5f]/20 data-[state=armed]:bg-[#ff2a5f]/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Delete</span>
                          </ConfirmDeleteButton>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="rounded-lg px-2.5 py-1.5 text-xs text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            disabled={savingEdit}
                            aria-busy={savingEdit}
                            className="flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-neutral-200 transition-colors duration-150 ease-out active:opacity-80 disabled:opacity-60"
                          >
                            <Check className="h-3.5 w-3.5" />
                            <span>Save</span>
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  {/* Weekly Quest Hours Progress */}
                  <div className="mt-6 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs font-medium uppercase tracking-[0.14em] text-hud-muted">
                        Quest Hours (7d)
                      </span>
                      <span className="text-sm text-neutral-400 tabular-nums">
                        <strong className="text-lg font-medium text-white">
                          {weekLogs === undefined
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
                      questFlowRefs.current[quest.id] = el;
                    }}
                    className="relative mt-6 space-y-2.5"
                  >
                    <div className="text-xs font-medium uppercase tracking-[0.14em] text-hud-muted">
                      Next Steps
                      {allTasks === undefined ? "" : ` (${questTasks.length})`}
                    </div>

                    {questTasks.map((t) => (
                      <div
                        key={t.id}
                        data-task-id={t.id}
                        className="group flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-[#14171f] px-4 py-3 text-sm"
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              // The second click of a double-click would hit
                              // the next row, which slides up under the cursor.
                              if (e.detail > 1) return;
                              handleCompleteQuestStep(
                                t.id,
                                quest.id,
                                quest.accentColor
                              );
                            }}
                            title="Mark complete"
                            aria-label="Mark complete"
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-white/25 text-transparent hover:border-[#00ff9d] hover:text-[#00ff9d] transition-colors duration-150 ease-out active:opacity-80"
                          >
                            <Check className="h-2.5 w-2.5" />
                          </button>
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
                          onClick={() => {
                            hudAudio.playLockOn();
                            initializeFocus(t.id);
                          }}
                          aria-label={`Start focus: ${t.title}`}
                          className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400 hover:text-white"
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
                <div className="mt-6 rounded-xl border border-dashed border-white/[0.12] bg-black/20 px-3.5 py-2.5 transition-colors focus-within:border-white/40">
                  <div className="flex items-center gap-2 focus-within:border-white/40">
                    <input
                      type="text"
                      value={quickTaskByQuest[quest.id] ?? ""}
                      onChange={(e) =>
                        setQuickTaskByQuest((prev) => ({
                          ...prev,
                          [quest.id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleQuickAdd(quest.id);
                        }
                      }}
                      placeholder={`Add task to ${quest.title}...`}
                      aria-label={`Add quest work to ${quest.title}`}
                      className="min-w-0 flex-1 bg-transparent text-xs text-white placeholder:text-hud-muted focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleQuickAdd(quest.id)}
                      aria-label={`Add task to ${quest.title}`}
                      className="rounded-lg p-1 text-neutral-400 hover:text-white transition-colors"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-1.5 border-t border-white/[0.05] pt-1.5">
                    <input
                      type="text"
                      value={quickNotesByQuest[quest.id] ?? ""}
                      onChange={(e) =>
                        setQuickNotesByQuest((prev) => ({
                          ...prev,
                          [quest.id]: e.target.value,
                        }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleQuickAdd(quest.id);
                        }
                      }}
                      placeholder="Description (optional)..."
                      aria-label={`Task description for ${quest.title} (optional)`}
                      className="w-full bg-transparent text-[11px] text-neutral-200 placeholder:text-hud-muted focus:outline-none"
                    />
                  </div>
                </div>
              </motion.div>
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
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-hud-muted tabular-nums">
              Completed Quests ({completedQuests.length})
            </h2>
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-6">
            {completedQuests.map((quest) => {
              const style = accentStyle(quest.accentColor);
              const totalSec = totalSecondsByCompletedQuest.get(quest.id) ?? 0;
              const isJustFinished = justCompletedQuestId === quest.id;

              return (
                <motion.div
                  layout="position"
                  layoutId={`quest-card-${quest.id}`}
                  transition={{
                    layout: {
                      type: "spring",
                      stiffness: 300,
                      damping: 30,
                      mass: 0.9,
                    },
                  }}
                  key={quest.id}
                  data-testid="completed-quest-card"
                  data-quest-id={quest.id}
                  className={`cq-card flex min-w-0 flex-col justify-between rounded-2xl border bg-[#0e1015]/80 p-5 sm:p-6 transition-[border-color,box-shadow] duration-500 ease-out ${
                    isJustFinished
                      ? "border-[#00ff9d]/40 shadow-[0_0_26px_-10px_rgba(0,255,157,0.35)]"
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

                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#00ff9d]/30 bg-[#00ff9d]/10 px-2.5 py-0.5 text-[11px] font-medium text-[#00ff9d]">
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
                    <span className="font-mono text-hud-muted tabular-nums">
                      {completedQuestLogs === undefined
                        ? "–"
                        : `${formatTelemetryDuration(totalSec, {
                            zeroAs: "0.0h",
                          })} logged`}
                    </span>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleReopenQuest(quest.id)}
                        aria-label={`Reopen quest ${quest.title}`}
                        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 hover:border-white/25 hover:bg-white/[0.08] hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Reopen</span>
                      </button>

                      <ConfirmDeleteButton
                        label={`Delete quest ${quest.title}`}
                        confirmLabel="Delete quest?"
                        onConfirm={() => handleDeleteQuest(quest.id)}
                        className="flex items-center gap-1 rounded-lg border border-[#ff2a5f]/25 bg-[#ff2a5f]/[0.06] px-2.5 py-1.5 text-xs text-[#ff2a5f] hover:bg-[#ff2a5f]/15 data-[state=armed]:bg-[#ff2a5f]/20"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Delete</span>
                      </ConfirmDeleteButton>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </section>
      )}
      </LayoutGroup>
    </div>
  );
}
