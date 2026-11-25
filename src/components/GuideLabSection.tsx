"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { reads } from "@/lib/reads";
import { useShallow } from "zustand/react/shallow";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Plus,
  Sparkles,
} from "lucide-react";
import { QUEST_ACCENT_KEYS, type QuestAccent } from "@/lib/domainTypes";
import { QUEST_ACCENT_STYLES } from "@/lib/questAccents";
import { useCommandStore } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
import {
  auditWorkspace,
  evaluateQuestDraft,
  evaluateTaskDraft,
  type CheckStatus,
  type DraftEvaluation,
} from "@/lib/questScience";
import {
  QUEST_LAB_PRESETS,
  TASK_LAB_PRESETS,
} from "@/lib/questScienceContent";
import { useTodayDateKey } from "./useTodayDateKey";
import { SavedNotice } from "./SavedNotice";

type LabMode = "task" | "quest";

const PRESSABLE =
  "transition-colors duration-150 ease-out active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hud-cyan/70";

const ACCENT_CHOICES: ReadonlyArray<{ id: QuestAccent; label: string }> =
  QUEST_ACCENT_KEYS.map((id) => ({
    id,
    label: QUEST_ACCENT_STYLES[id].label,
  }));

const CONFIRM_FEEDBACK_MS = 1500;

function VerdictBadge({ evaluation }: { evaluation: DraftEvaluation }) {
  if (evaluation.verdict === "empty") {
    return (
      <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-0.5 text-xs text-hud-muted">
        Waiting for draft
      </span>
    );
  }
  const styles: Record<Exclude<DraftEvaluation["verdict"], "empty">, string> = {
    strong: "border-hud-emerald/40 bg-hud-emerald/10 text-hud-emerald",
    fair: "border-hud-amber/40 bg-hud-amber/10 text-hud-amber",
    weak: "border-hud-crimson/40 bg-hud-crimson/10 text-hud-crimson",
  };
  const labels: Record<Exclude<DraftEvaluation["verdict"], "empty">, string> = {
    strong: "Strong",
    fair: "Needs polish",
    weak: "Too vague / broad",
  };
  return (
    <span
      data-testid="lab-verdict"
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium tabular-nums ${styles[evaluation.verdict]}`}
    >
      {labels[evaluation.verdict]} · {evaluation.score}/{evaluation.maxScore}
    </span>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-hud-emerald" aria-hidden="true" />;
  }
  if (status === "warn") {
    return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-hud-amber" aria-hidden="true" />;
  }
  return <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-hud-crimson" aria-hidden="true" />;
}

export function GuideLabSection() {
  const { createTask, createQuest, setActiveView } = useCommandStore(
    useShallow((s) => ({
      createTask: s.createTask,
      createQuest: s.createQuest,
      setActiveView: s.setActiveView,
    }))
  );

  const quests = useLiveQuery(reads.quests, []);
  const tasks = useLiveQuery(reads.allTasks, []);
  const loadingAudit = quests === undefined || tasks === undefined;

  // Recomputed when the day changes (the view can stay open past midnight).
  const todayKey = useTodayDateKey();
  const audit = useMemo(
    () => (loadingAudit ? null : auditWorkspace(quests, tasks, todayKey)),
    [loadingAudit, quests, tasks, todayKey]
  );

  const ids = useId();
  const [mode, setMode] = useState<LabMode>("task");

  // Task draft state
  const [taskTitle, setTaskTitle] = useState("");
  const [taskNotes, setTaskNotes] = useState("");
  const [taskQuestChoice, setTaskQuestChoice] = useState<string | null | undefined>(undefined);
  const [taskTouched, setTaskTouched] = useState(false);

  // Quest draft state
  const [questTitle, setQuestTitle] = useState("");
  const [questDesc, setQuestDesc] = useState("");
  const [questHours, setQuestHours] = useState("6");
  const [questAccent, setQuestAccent] = useState<QuestAccent>("cyan");
  const [questTouched, setQuestTouched] = useState(false);

  // Save state & confirmation feedback
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  const flashNotice = (message: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setSavedNotice(message);
    noticeTimerRef.current = setTimeout(() => {
      setSavedNotice(null);
      noticeTimerRef.current = null;
    }, CONFIRM_FEEDBACK_MS);
  };

  const activeQuests = useMemo(
    () => (quests ?? []).filter((q) => !q.archived),
    [quests]
  );

  const selectedQuestId = useMemo(() => {
    if (taskQuestChoice === null) return null;
    if (taskQuestChoice && activeQuests.some((q) => q.id === taskQuestChoice)) {
      return taskQuestChoice;
    }
    return activeQuests[0]?.id ?? null;
  }, [taskQuestChoice, activeQuests]);

  const taskEvaluation = useMemo(
    () => evaluateTaskDraft(taskTitle, taskNotes),
    [taskTitle, taskNotes]
  );

  const questEvaluation = useMemo(
    () =>
      evaluateQuestDraft({
        title: questTitle,
        description: questDesc,
        targetWeeklyHours: Number(questHours),
        existingQuestCount: audit?.activeQuestCount ?? 0,
        existingWeeklyHours: audit?.weeklyBudgetHours ?? 0,
      }),
    [questTitle, questDesc, questHours, audit]
  );

  const activeEvaluation = mode === "task" ? taskEvaluation : questEvaluation;

  const taskTitleError =
    taskTouched && !taskTitle.trim() ? "Enter a task title before adding to Today." : null;
  const parsedHours = Number(questHours);
  const questTitleError =
    questTouched && !questTitle.trim() ? "Enter a Quest title before creating." : null;
  const questHoursError =
    questTouched && (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 100)
      ? "Enter weekly target hours between 1 and 100."
      : null;

  const handleSaveTask = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setTaskTouched(true);
    const trimmed = taskTitle.trim();
    if (!trimmed || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    hudAudio.playComplete();
    try {
      const ok = await createTask({
        title: trimmed,
        notes: taskNotes.trim(),
        questId: selectedQuestId,
        promoteToTop: true,
      });
      if (ok) {
        setTaskTitle("");
        setTaskNotes("");
        setTaskTouched(false);
        flashNotice("Added to Today's Queue");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const handleSaveQuest = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setQuestTouched(true);
    const trimmed = questTitle.trim();
    if (!trimmed || !Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 100) {
      return;
    }
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    hudAudio.playComplete();
    try {
      const ok = await createQuest({
        title: trimmed,
        description: questDesc.trim(),
        accentColor: questAccent,
        targetWeeklyHours: parsedHours,
      });
      if (ok) {
        setQuestTitle("");
        setQuestDesc("");
        setQuestHours("6");
        setQuestTouched(false);
        flashNotice("Quest created");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const taskTitleId = `${ids}-task-title`;
  const taskNotesId = `${ids}-task-notes`;
  const questTitleId = `${ids}-quest-title`;
  const questDescId = `${ids}-quest-desc`;
  const questHoursId = `${ids}-quest-hours`;

  return (
    <div className="space-y-8">
      {/* 1. Live Workspace Health Check */}
      <section aria-labelledby={`${ids}-audit-heading`}>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id={`${ids}-audit-heading`} className="text-lg font-medium text-white">
              Your workspace check
            </h2>
            <p className="mt-1 text-xs text-hud-muted">
              A live, calm read of your current Quests and open tasks against these principles.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                hudAudio.playClick();
                setActiveView("quests");
              }}
              className={`inline-flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-300 hover:border-white/20 hover:text-white ${PRESSABLE}`}
            >
              <span>Manage Quests</span>
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {loadingAudit || !audit ? (
          <div
            aria-busy="true"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-28 rounded-2xl border border-white/[0.06] bg-surface p-5"
              />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-4">
              {/* Active Quests KPI */}
              <div className="rounded-2xl border border-white/[0.08] bg-surface p-5">
                <div className="text-xs text-hud-muted">
                  Active Quests
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span
                    data-testid="audit-quest-count"
                    className={`text-2xl font-medium tabular-nums ${
                      audit.questLoadStatus === "optimal"
                        ? "text-hud-emerald"
                        : audit.questLoadStatus === "empty"
                        ? "text-hud-cyan"
                        : "text-hud-amber"
                    }`}
                  >
                    {audit.activeQuestCount}
                  </span>
                  <span className="text-xs text-hud-muted">recommended: 1–3</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-300">
                  {audit.questLoadMessage}
                </p>
              </div>

              {/* Weekly Deep-Work Budget KPI */}
              <div className="rounded-2xl border border-white/[0.08] bg-surface p-5">
                <div className="text-xs text-hud-muted">
                  Weekly Target Budget
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span
                    data-testid="audit-weekly-hours"
                    className={`text-2xl font-medium tabular-nums ${
                      audit.budgetStatus === "sustainable"
                        ? "text-hud-emerald"
                        : audit.budgetStatus === "overbooked"
                        ? "text-hud-crimson"
                        : "text-hud-amber"
                    }`}
                  >
                    {audit.weeklyBudgetHours}h
                  </span>
                  <span className="text-xs text-hud-muted">ideal: 12–25 h/wk</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-300">
                  {audit.budgetMessage}
                </p>
              </div>

              {/* Open Task Clarity KPI */}
              <div className="rounded-2xl border border-white/[0.08] bg-surface p-5">
                <div className="text-xs text-hud-muted">
                  Open Task Clarity
                </div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span
                    data-testid="audit-task-clarity"
                    className={`text-2xl font-medium tabular-nums ${
                      audit.openTaskCount === 0
                        ? "text-neutral-300"
                        : audit.clarityPct >= 70
                        ? "text-hud-emerald"
                        : "text-hud-amber"
                    }`}
                  >
                    {audit.openTaskCount === 0 ? "–" : `${audit.clarityPct}%`}
                  </span>
                  <span className="text-xs text-hud-muted">
                    {audit.openTaskCount === 0
                      ? "no open tasks"
                      : `${audit.strongTaskCount}/${audit.openTaskCount} strong`}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-neutral-300">
                  {audit.openTaskCount === 0
                    ? "Your queue is clear. Use the Workshop below to craft your next task."
                    : `${audit.questTaskCount} Quest · ${audit.otherTaskCount} Other open tasks.`}
                </p>
              </div>
            </div>

            {audit.tasksToSharpen.length > 0 && (
              <div className="rounded-2xl border border-white/[0.08] bg-surface p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-hud-muted">
                    Open tasks you could sharpen ({audit.tasksToSharpen.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      hudAudio.playClick();
                      setActiveView("command");
                    }}
                    className={`-my-1.5 -mr-2 min-h-8 coarse:min-h-11 rounded-lg px-2.5 py-1.5 text-xs text-hud-cyan hover:bg-white/[0.06] hover:text-white ${PRESSABLE}`}
                  >
                    Edit on Home
                  </button>
                </div>
                <ul className="space-y-2.5">
                  {audit.tasksToSharpen.map((item) => (
                    <li
                      key={item.taskId}
                      className="flex flex-col justify-between gap-2 rounded-xl border border-white/[0.06] bg-raised px-4 py-3 sm:flex-row sm:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-white" title={item.title}>
                          {item.title}
                        </div>
                        <p className="mt-0.5 text-xs text-hud-muted">{item.topTip}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          hudAudio.playClick();
                          setMode("task");
                          setTaskTitle(item.title);
                          setTaskTouched(false);
                        }}
                        className={`shrink-0 min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-neutral-200 hover:border-hud-cyan/40 hover:text-white ${PRESSABLE}`}
                      >
                        Load in tester
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      {/* 2. Interactive Task & Quest Workshop */}
      <section
        aria-labelledby={`${ids}-workshop-heading`}
        className="cq-card rounded-2xl border border-white/[0.08] bg-surface p-5 sm:p-7"
      >
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-hud-cyan" aria-hidden="true" />
              <h2 id={`${ids}-workshop-heading`} className="text-lg font-medium text-white">
                Interactive Draft Tester
              </h2>
            </div>
            <p className="mt-1 max-w-[68ch] text-xs text-hud-muted">
              Practice writing a high-clarity Task or Quest, get instant science feedback, then add it directly to Hunt.
            </p>
          </div>

          <div
            role="group"
            aria-label="Draft type"
            className="inline-flex shrink-0 rounded-xl border border-white/10 bg-base p-1"
          >
            {(["task", "quest"] as const).map((m) => {
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    hudAudio.playClick();
                    setMode(m);
                  }}
                  className={`min-h-8 coarse:min-h-11 rounded-lg px-3.5 py-1.5 text-xs font-medium ${PRESSABLE} ${
                    active
                      ? "bg-white/10 text-white"
                      : "text-hud-muted hover:text-neutral-200"
                  }`}
                >
                  {m === "task" ? "Test a Task" : "Test a Quest"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Presets */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className="text-xs text-hud-muted">Try an example:</span>
          {mode === "task"
            ? TASK_LAB_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    hudAudio.playClick();
                    setTaskTitle(preset.title);
                    setTaskNotes(preset.notes);
                    setTaskTouched(false);
                  }}
                  className={`min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs ${PRESSABLE} ${
                    preset.kind === "strong"
                      ? "border-hud-emerald/25 bg-hud-emerald/[0.06] text-hud-emerald hover:bg-hud-emerald/15"
                      : "border-white/10 bg-white/[0.03] text-neutral-300 hover:border-white/25 hover:text-white"
                  }`}
                >
                  {preset.label}
                </button>
              ))
            : QUEST_LAB_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => {
                    hudAudio.playClick();
                    setQuestTitle(preset.title);
                    setQuestDesc(preset.description);
                    setQuestHours(String(preset.targetWeeklyHours));
                    setQuestAccent(preset.accent);
                    setQuestTouched(false);
                  }}
                  className={`min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs ${PRESSABLE} ${
                    preset.kind === "strong"
                      ? "border-hud-emerald/25 bg-hud-emerald/[0.06] text-hud-emerald hover:bg-hud-emerald/15"
                      : "border-white/10 bg-white/[0.03] text-neutral-300 hover:border-white/25 hover:text-white"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Form */}
          {mode === "task" ? (
            <form onSubmit={handleSaveTask} noValidate className="min-w-0 space-y-4">
              <div>
                <label htmlFor={taskTitleId} className="mb-1.5 block text-xs text-neutral-300">
                  Task title
                </label>
                <input
                  id={taskTitleId}
                  type="text"
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  onBlur={() => setTaskTouched(true)}
                  placeholder="e.g. Draft 400 words for the intro of essay #4"
                  aria-invalid={Boolean(taskTitleError)}
                  className="w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-white placeholder:text-hud-muted focus:border-hud-cyan focus:outline-none"
                />
                {taskTitleError && (
                  <p role="alert" className="mt-1.5 text-xs text-hud-crimson">
                    {taskTitleError}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor={taskNotesId} className="mb-1.5 block text-xs text-neutral-300">
                  Definition of Done (optional Notes)
                </label>
                <textarea
                  id={taskNotesId}
                  rows={2}
                  value={taskNotes}
                  onChange={(e) => setTaskNotes(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="What does finished look like for this single focus bout?"
                  className="w-full resize-none rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-hud-cyan focus:outline-none"
                />
              </div>

              {/* Target Quest picker */}
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Assign to Quest">
                {activeQuests.map((q) => {
                  const chosen = selectedQuestId === q.id;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      aria-pressed={chosen}
                      onClick={() => setTaskQuestChoice(q.id)}
                      className={`flex min-w-0 max-w-full items-center gap-1.5 min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs ${PRESSABLE} ${
                        chosen
                          ? "border-white/30 bg-white/10 text-white"
                          : "border-white/10 text-hud-muted hover:text-neutral-200"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          QUEST_ACCENT_STYLES[q.accentColor]?.bg ?? "bg-neutral-500"
                        }`}
                      />
                      <span className="truncate">{q.title}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  aria-pressed={selectedQuestId === null}
                  onClick={() => setTaskQuestChoice(null)}
                  className={`flex items-center gap-1.5 min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs ${PRESSABLE} ${
                    selectedQuestId === null
                      ? "border-white/30 bg-white/10 text-white"
                      : "border-white/10 text-hud-muted hover:text-neutral-200"
                  }`}
                >
                  <span className="h-2 w-2 rounded-full bg-neutral-500" />
                  <span>Other</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className={`inline-flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-xl bg-hud-cyan px-4 py-2 text-xs font-semibold text-black hover:bg-white disabled:opacity-50 ${PRESSABLE}`}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Add to Today&apos;s Queue</span>
                </button>
                <SavedNotice text={savedNotice} />
              </div>
            </form>
          ) : (
            <form onSubmit={handleSaveQuest} noValidate className="min-w-0 space-y-4">
              <div>
                <label htmlFor={questTitleId} className="mb-1.5 block text-xs text-neutral-300">
                  Quest title
                </label>
                <input
                  id={questTitleId}
                  type="text"
                  value={questTitle}
                  onChange={(e) => setQuestTitle(e.target.value)}
                  onBlur={() => setQuestTouched(true)}
                  placeholder="e.g. Ship v1 of my audio plugin"
                  aria-invalid={Boolean(questTitleError)}
                  className="w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-white placeholder:text-hud-muted focus:border-hud-cyan focus:outline-none"
                />
                {questTitleError && (
                  <p role="alert" className="mt-1.5 text-xs text-hud-crimson">
                    {questTitleError}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor={questDescId} className="mb-1.5 block text-xs text-neutral-300">
                  Why it matters &amp; what moves it forward
                </label>
                <textarea
                  id={questDescId}
                  rows={2}
                  value={questDesc}
                  onChange={(e) => setQuestDesc(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Core craft milestones and why this pursuit matters to you..."
                  className="w-full resize-none rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-hud-cyan focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-neutral-300">
                  <label htmlFor={questHoursId}>Weekly target:</label>
                  <input
                    id={questHoursId}
                    type="number"
                    min={1}
                    max={100}
                    step="any"
                    value={questHours}
                    onChange={(e) => setQuestHours(e.target.value)}
                    onBlur={() => setQuestTouched(true)}
                    aria-invalid={Boolean(questHoursError)}
                    className="w-16 min-h-8 coarse:min-h-11 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-hud-cyan focus:outline-none"
                  />
                  <span className="text-hud-muted">h/wk</span>
                </div>

                <div role="group" aria-label="Quest accent" className="flex flex-wrap items-center gap-2">
                  {ACCENT_CHOICES.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={questAccent === opt.id}
                      onClick={() => setQuestAccent(opt.id)}
                      className={`flex items-center gap-1.5 min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs ${PRESSABLE} ${
                        questAccent === opt.id
                          ? "border-white/30 bg-white/10 text-white"
                          : "border-white/10 text-hud-muted hover:text-neutral-200"
                      }`}
                    >
                      <span className={`h-2 w-2 rounded-full ${QUEST_ACCENT_STYLES[opt.id].bg}`} />
                      <span>{opt.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              {questHoursError && (
                <p role="alert" className="text-xs text-hud-crimson">
                  {questHoursError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className={`inline-flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-xl bg-hud-cyan px-4 py-2 text-xs font-semibold text-black hover:bg-white disabled:opacity-50 ${PRESSABLE}`}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Create Quest</span>
                </button>
                <SavedNotice text={savedNotice} />
              </div>
            </form>
          )}

          {/* Right: Live Science Evaluation */}
          <div className="min-w-0 rounded-xl border border-white/[0.06] bg-base p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-hud-muted">
                Science check
              </span>
              <VerdictBadge evaluation={activeEvaluation} />
            </div>

            <p className="mt-3 max-w-[68ch] text-xs leading-relaxed text-neutral-300">
              {activeEvaluation.summary}
            </p>

            {activeEvaluation.checks.length > 0 && (
              <ul className="mt-4 space-y-3">
                {activeEvaluation.checks.map((check) => (
                  <li
                    key={check.id}
                    className="flex items-start gap-2.5 rounded-lg bg-surface p-3"
                  >
                    <StatusIcon status={check.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-xs font-medium text-white">{check.label}</span>
                        <span className="text-[11px] text-hud-muted">{check.principle}</span>
                      </div>
                      <p className="mt-1 break-words text-xs leading-relaxed text-neutral-300">
                        {check.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
