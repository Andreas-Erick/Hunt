"use client";

import React from "react";
import { Check, Trash2 } from "lucide-react";
import { QUEST_ACCENT_KEYS, type Quest, type QuestAccent } from "@/lib/domainTypes";
import { QUEST_ACCENT_STYLES } from "@/lib/questAccents";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

/** Native `pattern` (matched against the whole value): at least one non-space character. */
const NON_BLANK_PATTERN = ".*\\S.*";

const ACCENT_OPTIONS: ReadonlyArray<{ id: QuestAccent; label: string }> =
  QUEST_ACCENT_KEYS.map((id) => ({
    id,
    label: QUEST_ACCENT_STYLES[id].label,
  }));

/**
 * Per-form styling of the Quest text fields: the edit drawer is compact and
 * stacked, the New Quest card is roomier with its fields side by side.
 */
const VARIANTS = {
  drawer: {
    title:
      "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white focus:border-accent focus:outline-none",
    description:
      "w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-xs text-neutral-200 focus:border-accent focus:outline-none",
    titlePlaceholder: undefined,
    descriptionPlaceholder: undefined,
  },
  create: {
    title:
      "w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-white focus:border-accent focus:outline-none",
    description:
      "w-full rounded-xl border border-white/15 bg-black/40 px-3.5 py-2.5 text-sm text-neutral-200 placeholder:text-hud-muted focus:border-accent focus:outline-none",
    titlePlaceholder: "e.g. Launch my idea",
    descriptionPlaceholder: "What moves this quest forward?",
  },
} as const;

/**
 * A Quest's title and description inputs, shared by the edit drawer and the
 * New Quest form.
 */
export function QuestTextFields({
  variant,
  idPrefix,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
}: {
  variant: keyof typeof VARIANTS;
  /** Unique per form; the inputs' ids derive from it. */
  idPrefix: string;
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
}) {
  const v = VARIANTS[variant];
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  const fields = (
    <>
      <div>
        <label htmlFor={titleId} className="mb-1 block text-xs text-neutral-400">
          Quest Title
        </label>
        <input
          id={titleId}
          type="text"
          required
          autoFocus
          pattern={NON_BLANK_PATTERN}
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder={v.titlePlaceholder}
          className={v.title}
        />
      </div>
      <div>
        {variant === "create" ? (
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor={descId} className="block text-xs text-neutral-400">
              Description
            </label>
            <span className="text-[11px] text-hud-muted">Optional</span>
          </div>
        ) : (
          <label htmlFor={descId} className="mb-1 block text-xs text-neutral-400">
            Description
          </label>
        )}
        <input
          id={descId}
          type="text"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={v.descriptionPlaceholder}
          className={v.description}
        />
      </div>
    </>
  );
  return variant === "create" ? <div className="cq-form-two-col">{fields}</div> : fields;
}

export function AccentPills({
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
      className="flex flex-wrap items-center gap-2"
    >
      {ACCENT_OPTIONS.map((opt) => {
        const selected = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(opt.id)}
            className={`flex min-h-8 coarse:min-h-11 items-center rounded-full border py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
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
 * Weekly hours as typed (a string, so it can be cleared while editing), with
 * its "Weekly target: … h/wk" labels. The native required/min/max checks run
 * on submit; "any" step keeps fractional targets saved elsewhere editable.
 */
export function WeeklyTargetField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Classes of the row holding the labels and the input. */
  className: string;
}) {
  return (
    <div className={className}>
      <span>Weekly target:</span>
      <input
        type="number"
        required
        min={1}
        max={100}
        step="any"
        aria-label="Weekly target hours"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-16 min-h-8 coarse:min-h-11 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white focus:border-hud-cyan focus:outline-none"
      />
      <span>h/wk</span>
    </div>
  );
}

/** Armed text of a quest's Delete: deleting moves its tasks to Other work. */
function deleteQuestConfirmLabel(openTaskCount: number): string {
  if (openTaskCount === 0) return "Delete quest?";
  const tasks = openTaskCount === 1 ? "open task moves" : "open tasks move";
  return `Delete quest? ${openTaskCount} ${tasks} to Other work`;
}

/**
 * A quest card's inline Edit & Delete drawer: the shared Quest fields plus
 * Delete (apart on the left), Cancel and Save. Escape cancels.
 */
export function QuestEditDrawer({
  quest,
  openTaskCount,
  idPrefix,
  title,
  onTitleChange,
  description,
  onDescriptionChange,
  accent,
  onAccentChange,
  target,
  onTargetChange,
  saving,
  onSave,
  onCancel,
  onDelete,
}: {
  quest: Quest;
  /** Open tasks that Delete moves to Other work (named in its armed label). */
  openTaskCount: number;
  idPrefix: string;
  title: string;
  onTitleChange: (title: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  accent: QuestAccent;
  onAccentChange: (accent: QuestAccent) => void;
  target: string;
  onTargetChange: (target: string) => void;
  saving: boolean;
  onSave: (form: HTMLFormElement) => void;
  onCancel: () => void;
  onDelete: (questId: string) => Promise<void>;
}) {
  return (
    <form
      aria-label={`Edit quest ${quest.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
      className="mt-5 rounded-xl border border-white/10 bg-base p-4 space-y-3.5"
    >
      <QuestTextFields
        variant="drawer"
        idPrefix={idPrefix}
        title={title}
        onTitleChange={onTitleChange}
        description={description}
        onDescriptionChange={onDescriptionChange}
      />

      <AccentPills compact value={accent} onChange={onAccentChange} />

      <WeeklyTargetField
        value={target}
        onChange={onTargetChange}
        className="flex items-center gap-2 pt-1 text-xs text-neutral-400"
      />

      {/* Delete sits apart on the left (mr-auto): arming widens it into free
          space instead of pushing Save sideways under the cursor. */}
      <div className="flex w-full flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
        <ConfirmDeleteButton
          label="Delete quest"
          confirmLabel={deleteQuestConfirmLabel(openTaskCount)}
          onConfirm={() => onDelete(quest.id)}
          className="mr-auto flex min-h-8 coarse:min-h-11 min-w-0 max-w-full items-center gap-1 rounded-lg border border-danger/30 bg-danger/10 px-3 py-1.5 text-left text-xs text-danger hover:bg-danger/20 data-[state=armed]:bg-danger/20"
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          <span>Delete</span>
        </ConfirmDeleteButton>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs text-hud-muted hover:text-white transition-colors duration-150 ease-out active:opacity-80"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          aria-busy={saving}
          className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-neutral-200 transition-colors duration-150 ease-out active:opacity-80 disabled:opacity-60"
        >
          <Check className="h-3.5 w-3.5" />
          <span>Save</span>
        </button>
      </div>
    </form>
  );
}
