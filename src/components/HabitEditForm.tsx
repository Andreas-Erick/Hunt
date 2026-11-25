"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { Habit, HabitFrequency, Quest } from "@/lib/domainTypes";
import { habitFrequencyOn, sameHabitFrequency } from "@/lib/habitFrequency";
import { habitKindRules } from "@/lib/habitKind";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";
import * as Count from "./CountHabitControls";
import { EditHabitQuestPicker } from "./HabitQuestPicker";
import { HabitEndDateField } from "./HabitEndDateField";
import { HabitFrequencyPicker, isHabitFrequencyValid } from "./HabitFrequencyPicker";
import { HabitReminderTimes } from "./HabitReminderTimes";
import { useDiscardGuard } from "./useDiscardGuard";

const DISCARD_PROMPT = "Discard unsaved changes?";

/** Asks before unsaved habit edits are dropped; true when there are none or the user agrees. */
export function confirmDiscardHabitEdit(dirty: boolean): boolean {
  return !dirty || window.confirm(DISCARD_PROMPT);
}

/** Discard guard for leaving the view with an unsaved habit edit. */
const confirmLeaveDirty = () => confirmDiscardHabitEdit(true);

/**
 * The one editor of a Habit, used by the card's Edit drawer and the detail
 * screen's Edit tab: title and notes, the Kind (read-only) with a Count
 * Habit's target and unit, the Frequency (from today), the end date, the
 * reminder times (saved as they change) and the Quest. While it holds unsaved
 * edits a view switch asks first (useDiscardGuard), Cancel and Escape ask too.
 */
export function HabitEditForm({
  habit,
  todayKey,
  quests,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  habit: Habit;
  todayKey: string;
  /** The active Quests the Habit can be assigned to. */
  quests: readonly Quest[];
  onSaved: () => void;
  /** Called once a Cancel or Escape is confirmed (or nothing was changed). */
  onCancel: () => void;
  /** Told whenever the form gains or loses unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const ids = useId();
  const updateHabit = useCommandStore((s) => s.updateHabit);
  const [title, setTitle] = useState(habit.title);
  const [notes, setNotes] = useState(habit.notes ?? "");
  const [questId, setQuestId] = useState<string | null>(habit.questId);
  const [frequency, setFrequency] = useState<HabitFrequency>(() => habitFrequencyOn(habit, todayKey));
  const [endDate, setEndDate] = useState(habit.endDate ?? ""); // "" = no end date
  const kind = Count.useHabitKindEdit(habit);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const dirty =
    title !== habit.title ||
    notes !== (habit.notes ?? "") ||
    questId !== habit.questId ||
    kind.isDirty(habit) ||
    endDate !== (habit.endDate ?? "") ||
    !sameHabitFrequency(frequency, habitFrequencyOn(habit, todayKey));
  useDiscardGuard(dirty, confirmLeaveDirty);
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  const cancel = () => {
    if (confirmDiscardHabitEdit(dirty)) onCancel();
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (savingRef.current || !trimmed || !isHabitFrequencyValid(frequency)) return;
    savingRef.current = true;
    setSaving(true);
    hudAudio.playClick();
    try {
      const saved = await updateHabit(habit.id, {
        title: trimmed,
        notes,
        questId,
        frequency,
        ...kind.changes(habit),
        endDate: endDate || null,
      });
      if (saved) onSaved();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const titleId = `${ids}-title`;
  const notesId = `${ids}-notes`;
  return (
    <form
      aria-label={`Edit habit ${habit.title}`}
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          cancel();
        }
      }}
      className="space-y-3"
    >
      <div>
        <label htmlFor={titleId} className="mb-1 block text-xs text-neutral-400">
          Habit Title
        </label>
        <input
          id={titleId}
          type="text"
          required
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor={notesId} className="mb-1 block text-xs text-neutral-400">Default Notes</label>
        <input
          id={notesId}
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional reminder copied to each day's task..."
          className="w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-accent focus:outline-none"
        />
      </div>

      {kind.fields(habit)}

      <div>
        <span className="mb-1 block text-xs text-neutral-400">Frequency (applies from today)</span>
        <HabitFrequencyPicker
          label="Habit frequency"
          value={frequency}
          onChange={setFrequency}
          allowPerWeek={habitKindRules(habit).allowsPerWeek}
        />
      </div>
      <HabitEndDateField value={endDate} onChange={setEndDate} />

      <HabitReminderTimes habitId={habit.id} habitTitle={habit.title} times={habit.reminderTimes} />

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <EditHabitQuestPicker quests={quests} questId={questId} onSelect={setQuestId} />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancel}
            className="min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !title.trim() || !isHabitFrequencyValid(frequency)}
            aria-busy={saving}
            className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-neutral-200 transition-colors duration-150 ease-out active:opacity-80 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            <span>Save</span>
          </button>
        </div>
      </div>
    </form>
  );
}
