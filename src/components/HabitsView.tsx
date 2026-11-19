"use client";

import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useShallow } from "zustand/react/shallow";
import {
  Check,
  Play,
  Plus,
  Repeat,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import {
  db,
  accentStyle,
  dateKeyFromOffset,
  habitTaskId,
  toLocalDateKey,
  type Habit,
  type Quest,
  type Task,
} from "@/lib/db";
import { useCommandStore } from "@/store/useCommandStore";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

const DISCARD_PROMPT = "Discard unsaved changes?";
const HISTORY_DAYS = 7;

function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm(DISCARD_PROMPT);
}

/**
 * Consecutive completed days for a habit ending on `todayKey` (or yesterday if
 * today is not yet completed, so a running streak does not drop to 0 at 8 AM).
 */
export function computeHabitStreak(
  completedDates: ReadonlySet<string>,
  todayKey: string
): number {
  let offset = completedDates.has(todayKey) ? 0 : -1;
  let streak = 0;
  while (completedDates.has(dateKeyFromOffset(todayKey, offset))) {
    streak += 1;
    offset -= 1;
  }
  return streak;
}

export function HabitsView() {
  const {
    createHabit,
    updateHabit,
    deleteHabit,
    materializeDailyHabits,
    completeTaskById,
    reopenTaskById,
    initializeFocus,
  } = useCommandStore(
    useShallow((s) => ({
      createHabit: s.createHabit,
      updateHabit: s.updateHabit,
      deleteHabit: s.deleteHabit,
      materializeDailyHabits: s.materializeDailyHabits,
      completeTaskById: s.completeTaskById,
      reopenTaskById: s.reopenTaskById,
      initializeFocus: s.initializeFocus,
    }))
  );

  const quests = useLiveQuery(
    () => db.quests.orderBy("slotIndex").toArray(),
    []
  );
  const habits = useLiveQuery(
    async () => (await db.habits.toArray()).sort(compareRank),
    []
  );
  const habitTasks = useLiveQuery(
    () => db.tasks.filter((t) => Boolean(t.habitId)).toArray(),
    []
  );

  const todayKey = toLocalDateKey();

  // Ensure today's daily habit tasks exist whenever Habits view opens or the day rolls over.
  useEffect(() => {
    void materializeDailyHabits(todayKey);
  }, [materializeDailyHabits, todayKey]);

  const ids = useId();

  // New Habit form state
  const [newTitle, setNewTitle] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [questChoice, setQuestChoice] = useState<string | null | undefined>(
    undefined
  );
  const addingRef = useRef(false);

  // Inline Edit drawer (one habit at a time)
  const [editingHabit, setEditingHabit] = useState<Habit | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editQuestId, setEditQuestId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const savingEditRef = useRef(false);
  const editToggleRef = useRef<HTMLButtonElement | null>(null);

  const questMap = useMemo(() => {
    const map = new Map<string, Quest>();
    quests?.forEach((q) => map.set(q.id, q));
    return map;
  }, [quests]);

  // Default quest = first existing quest (or null = Other work).
  const selectedQuestId: string | null =
    questChoice === null
      ? null
      : questChoice !== undefined && questMap.has(questChoice)
      ? questChoice
      : quests?.[0]?.id ?? null;
  const otherSelected = quests !== undefined && selectedQuestId === null;

  // Last 7 local days (oldest -> today) for real daily consistency dots.
  const recentDays = useMemo(
    () =>
      Array.from({ length: HISTORY_DAYS }, (_, idx) =>
        dateKeyFromOffset(todayKey, idx - (HISTORY_DAYS - 1))
      ),
    [todayKey]
  );

  // Index materialized tasks by habitId -> (todayTask + set of completed dateKeys).
  const habitStats = useMemo(() => {
    const todayByHabit = new Map<string, Task>();
    const completedDatesByHabit = new Map<string, Set<string>>();
    for (const task of habitTasks ?? []) {
      if (!task.habitId) continue;
      if (task.id === habitTaskId(task.habitId, todayKey) || task.scheduledDate === todayKey) {
        if (!todayByHabit.has(task.habitId) || task.id === habitTaskId(task.habitId, todayKey)) {
          todayByHabit.set(task.habitId, task);
        }
      }
      if (task.status === "completed") {
        const dKey =
          task.scheduledDate ??
          (task.completedAt ? toLocalDateKey(task.completedAt) : undefined);
        if (dKey) {
          let set = completedDatesByHabit.get(task.habitId);
          if (!set) {
            set = new Set<string>();
            completedDatesByHabit.set(task.habitId, set);
          }
          set.add(dKey);
        }
      }
    }
    return { todayByHabit, completedDatesByHabit };
  }, [habitTasks, todayKey]);

  const completedTodayCount = useMemo(() => {
    if (!habits) return 0;
    return habits.filter(
      (h) => habitStats.todayByHabit.get(h.id)?.status === "completed"
    ).length;
  }, [habits, habitStats]);

  const editIsDirty = () =>
    editingHabit !== null &&
    (editTitle !== editingHabit.title ||
      editNotes !== (editingHabit.notes ?? "") ||
      editQuestId !== editingHabit.questId);

  const handleAdd = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const title = newTitle.trim();
    if (!title || addingRef.current) return;
    addingRef.current = true;
    const notes = newNotes;
    setNewTitle("");
    setNewNotes("");
    hudAudio.playClick();
    let created = false;
    try {
      created = await createHabit({
        title,
        notes,
        questId: selectedQuestId,
      });
    } finally {
      addingRef.current = false;
      if (!created) {
        setNewTitle((cur) => (cur === "" ? title : cur));
        setNewNotes((cur) => (cur === "" ? notes : cur));
      }
    }
  };

  const startEdit = (habit: Habit, toggle: HTMLButtonElement) => {
    hudAudio.playClick();
    if (!confirmDiscard(editIsDirty())) return;
    if (editingHabit?.id === habit.id) {
      setEditingHabit(null);
      return;
    }
    editToggleRef.current = toggle;
    setEditingHabit(habit);
    setEditTitle(habit.title);
    setEditNotes(habit.notes ?? "");
    setEditQuestId(habit.questId);
  };

  const closeEdit = () => {
    setEditingHabit(null);
    editToggleRef.current?.focus();
  };

  const cancelEdit = () => {
    if (confirmDiscard(editIsDirty())) closeEdit();
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingHabit || savingEditRef.current) return;
    const title = editTitle.trim();
    if (!title) return;
    savingEditRef.current = true;
    setSavingEdit(true);
    hudAudio.playClick();
    const habitId = editingHabit.id;
    const toggle = editToggleRef.current;
    try {
      const saved = await updateHabit(habitId, {
        title,
        notes: editNotes,
        questId: editQuestId,
      });
      if (saved) {
        setEditingHabit((cur) => (cur?.id === habitId ? null : cur));
        if (editToggleRef.current === toggle) toggle?.focus();
      }
    } finally {
      savingEditRef.current = false;
      setSavingEdit(false);
    }
  };

  const handleToggleToday = async (habit: Habit) => {
    let todayTask = habitStats.todayByHabit.get(habit.id);
    if (!todayTask) {
      await materializeDailyHabits(todayKey);
      todayTask = await db.tasks.get(habitTaskId(habit.id, todayKey));
    }
    if (!todayTask) return;
    if (todayTask.status === "completed") {
      hudAudio.playClick();
      await reopenTaskById(todayTask.id);
    } else {
      hudAudio.playComplete();
      await completeTaskById(todayTask.id);
    }
  };

  const handleFocusToday = async (habit: Habit) => {
    let todayTask = habitStats.todayByHabit.get(habit.id);
    if (!todayTask) {
      await materializeDailyHabits(todayKey);
      todayTask = await db.tasks.get(habitTaskId(habit.id, todayKey));
    }
    if (!todayTask) return;
    if (todayTask.status === "completed") {
      await reopenTaskById(todayTask.id);
    }
    hudAudio.playLockOn();
    await initializeFocus(todayTask.id);
  };

  const editTitleId = `${ids}-edit-title`;
  const editNotesId = `${ids}-edit-notes`;

  return (
    <div className="mx-auto max-w-[1120px] px-6 py-10 sm:px-10 lg:px-16 lg:py-12">
      {/* Header */}
      <div className="mb-10 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-white sm:text-4xl">
            Daily habits
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Recurring routines added to your Home queue every day.
          </p>
        </div>

        {habits !== undefined && habits.length > 0 && (
          <div className="flex items-baseline gap-2 tabular-nums">
            <span className="text-2xl font-medium tracking-tight text-white">
              {completedTodayCount} / {habits.length}
            </span>
            <span className="text-sm text-hud-muted">done today</span>
          </div>
        )}
      </div>

      {/* Dashed Quick-Add Habit Box */}
      <form
        onSubmit={handleAdd}
        className="mb-8 rounded-2xl border border-dashed border-white/[0.15] bg-[#111318]/60 p-4 transition-colors focus-within:border-white/40"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a daily habit..."
            aria-label="Add a daily habit"
            className="flex-1 bg-transparent px-1 py-1 text-base text-white placeholder:text-hud-muted focus:outline-none"
          />

          <button
            type="submit"
            disabled={!newTitle.trim()}
            className="flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[#00f0ff] px-4 py-2 text-xs font-semibold text-black transition-all duration-150 ease-out hover:bg-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Habit</span>
          </button>
        </div>

        <div
          role="group"
          aria-label="Quest for new habit"
          className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3"
        >
          {quests?.map((q) => {
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
                className={`flex min-w-0 max-w-full sm:max-w-[230px] items-center gap-2 rounded-full border px-3 py-1 text-xs transition-all duration-150 ease-out active:opacity-80 ${
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
            aria-pressed={otherSelected}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs transition-all duration-150 ease-out active:opacity-80 ${
              otherSelected
                ? "border-white/30 bg-white/[0.08] text-white font-medium"
                : "border-white/[0.07] text-hud-muted hover:text-neutral-300"
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-neutral-500" />
            <span>Other work</span>
          </button>
        </div>
      </form>

      {/* Habits List */}
      {habits === undefined ? (
        <div aria-busy="true" className="space-y-3.5" />
      ) : habits.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/[0.08] py-16 text-center text-sm text-hud-muted">
          No daily habits yet. Add one above and it will appear in today&apos;s
          queue every day.
        </div>
      ) : (
        <div className="space-y-3.5">
          {habits.map((habit) => {
            const linkedQuest = habit.questId
              ? questMap.get(habit.questId)
              : undefined;
            const style = accentStyle(linkedQuest?.accentColor ?? "slate");
            const questLabel = linkedQuest ? linkedQuest.title : "Other work";
            const todayTask = habitStats.todayByHabit.get(habit.id);
            const doneToday = todayTask?.status === "completed";
            const completedDates =
              habitStats.completedDatesByHabit.get(habit.id) ??
              new Set<string>();
            const streak = computeHabitStreak(completedDates, todayKey);
            const isEditing = editingHabit?.id === habit.id;

            return (
              <div
                key={habit.id}
                data-testid="habit-row"
                data-habit-id={habit.id}
                className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#111318] transition-colors hover:border-white/[0.15]"
              >
                <div
                  className={`absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full ${style.bg} ${
                    doneToday ? "opacity-45" : ""
                  }`}
                />

                <div className="p-5 pl-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3.5">
                      <button
                        type="button"
                        onClick={() => void handleToggleToday(habit)}
                        aria-label={
                          doneToday
                            ? `Reopen today's habit: ${habit.title}`
                            : `Complete today's habit: ${habit.title}`
                        }
                        aria-pressed={doneToday}
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ease-out active:opacity-80 ${
                          doneToday
                            ? `${style.bg} border-transparent text-black`
                            : "border-white/25 text-transparent hover:border-[#00ff9d] hover:text-[#00ff9d]"
                        }`}
                      >
                        <Check className="h-3 w-3 stroke-[2.5]" />
                      </button>

                      <div className="min-w-0 flex-1">
                        <div
                          className={`break-words [text-wrap:pretty] text-base font-medium leading-snug ${
                            doneToday
                              ? "text-hud-muted line-through"
                              : "text-white"
                          }`}
                        >
                          {habit.title}
                        </div>
                        {habit.notes && (
                          <p className="mt-1 break-words text-xs text-hud-muted">
                            {habit.notes}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {!doneToday && (
                        <button
                          type="button"
                          onClick={() => void handleFocusToday(habit)}
                          aria-label={`Start focus: ${habit.title}`}
                          title="Start focus"
                          className="rounded-lg p-2 text-neutral-400 transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => startEdit(habit, e.currentTarget)}
                        aria-label={`Edit habit ${habit.title}`}
                        aria-expanded={isEditing}
                        title="Edit habit"
                        className="rounded-lg p-2 text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
                      >
                        <SlidersHorizontal className="h-4 w-4" />
                      </button>
                      <ConfirmDeleteButton
                        label={`Delete habit ${habit.title}`}
                        confirmLabel="Delete habit?"
                        onConfirm={() => deleteHabit(habit.id)}
                        className="rounded-lg p-2 text-hud-muted hover:text-[#ff2a5f] data-[state=armed]:opacity-100"
                      >
                        <Trash2 className="h-4 w-4" />
                      </ConfirmDeleteButton>
                    </div>
                  </div>

                  {/* Metadata Row: Daily pill, Quest pill, 7-day dots & streak */}
                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 pl-8">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-0.5 text-[11px] text-hud-muted">
                        <Repeat className="h-3 w-3" aria-hidden="true" />
                        <span>Daily</span>
                      </span>

                      <span className="flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 py-0.5 text-[11px] text-neutral-300">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.bg}`}
                        />
                        <span className="max-w-[160px] truncate" title={questLabel}>
                          {questLabel}
                        </span>
                      </span>
                    </div>

                    {/* Real 7-day completion history */}
                    <div className="flex items-center gap-3">
                      <div
                        className="flex items-center gap-1.5"
                        aria-label={`${
                          recentDays.filter((d) => completedDates.has(d)).length
                        } of last 7 days completed`}
                      >
                        {recentDays.map((dKey) => {
                          const hit = completedDates.has(dKey);
                          const isCurrent = dKey === todayKey;
                          return (
                            <span
                              key={dKey}
                              title={`${dKey}: ${hit ? "Completed" : "Not completed"}`}
                              className={`h-2 w-2 rounded-full ${
                                hit
                                  ? style.bg
                                  : isCurrent
                                  ? "border border-white/30 bg-transparent"
                                  : "bg-white/[0.09]"
                              }`}
                            />
                          );
                        })}
                      </div>

                      {streak > 0 && (
                        <span className="font-mono text-xs tabular-nums text-neutral-300">
                          {streak}d streak
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Inline Edit Drawer */}
                {isEditing && (
                  <form
                    aria-label={`Edit habit ${habit.title}`}
                    onSubmit={saveEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        cancelEdit();
                      }
                    }}
                    className="border-t border-white/[0.06] bg-[#0c0e12] px-6 py-4 space-y-3"
                  >
                    <div>
                      <label
                        htmlFor={editTitleId}
                        className="mb-1 block text-xs text-neutral-400"
                      >
                        Habit Title
                      </label>
                      <input
                        id={editTitleId}
                        type="text"
                        required
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-[#00f0ff] focus:outline-none"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor={editNotesId}
                        className="mb-1 block text-xs text-neutral-400"
                      >
                        Default Notes
                      </label>
                      <input
                        id={editNotesId}
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Optional reminder copied to each day's task..."
                        className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-[#00f0ff] focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      <div
                        role="group"
                        aria-label="Habit quest"
                        className="flex min-w-0 flex-wrap items-center gap-1.5"
                      >
                        {quests?.map((q) => {
                          const qStyle = accentStyle(q.accentColor);
                          const active = editQuestId === q.id;
                          return (
                            <button
                              key={q.id}
                              type="button"
                              aria-pressed={active}
                              onClick={() => setEditQuestId(q.id)}
                              className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
                                active
                                  ? "border-white/25 bg-white/10 text-white"
                                  : "border-transparent text-hud-muted hover:text-neutral-300"
                              }`}
                            >
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${qStyle.bg}`}
                              />
                              <span className="truncate max-w-[140px]" title={q.title}>
                                {q.title}
                              </span>
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          aria-pressed={editQuestId === null}
                          onClick={() => setEditQuestId(null)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
                            editQuestId === null
                              ? "border-white/25 bg-white/10 text-white"
                              : "border-transparent text-hud-muted hover:text-neutral-300"
                          }`}
                        >
                          Other work
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg px-2.5 py-1.5 text-xs text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={savingEdit || !editTitle.trim()}
                          aria-busy={savingEdit}
                          className="flex items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-neutral-200 transition-colors duration-150 ease-out active:opacity-80 disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>Save</span>
                        </button>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
