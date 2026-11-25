"use client";

import React, { useState } from "react";
import { Check, ChevronDown, ChevronUp, ListChecks, Plus, X } from "lucide-react";
import {
  canHoldChecklist,
  checklistOf,
  checklistProgress,
  newChecklistItemId,
  type ChecklistEdit,
} from "@/lib/checklist";
import type { ChecklistItem, Task } from "@/lib/domainTypes";
import { MAX_CHECKLIST_TEXT_LENGTH } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";

type ChecklistTask = Pick<Task, "id" | "habitId" | "checklist">;

/** "2/5" on a Task row; nothing when the Task has no Checklist items. */
export function ChecklistProgressBadge({ task }: { task: ChecklistTask }) {
  const progress = checklistProgress(task);
  if (!progress) return null;
  const complete = progress.done === progress.total;
  return (
    <span
      aria-label={`Checklist: ${progress.done} of ${progress.total} done`}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 font-mono text-[11px] tabular-nums ${
        complete ? "text-success" : "text-hud-muted"
      }`}
    >
      <ListChecks className="h-3 w-3" aria-hidden="true" />
      <span aria-hidden="true">
        {progress.done}/{progress.total}
      </span>
    </span>
  );
}

const ICON_BUTTON =
  "flex h-8 w-8 coarse:h-11 coarse:w-11 shrink-0 items-center justify-center rounded-lg text-hud-muted transition-[color,background-color,opacity] duration-150 ease-out hover:bg-white/[0.06] hover:text-neutral-200 active:opacity-80 disabled:pointer-events-none disabled:opacity-30";

/**
 * The Checklist editor inside a Task: tick, rename (edit the text in place),
 * reorder (up / down, no drag, so it works by finger), delete and add items.
 * Every edit goes through the shared rule (editChecklist). Renders nothing for
 * a habit day Task, which never holds a Checklist.
 */
export function TaskChecklistEditor({ task, className = "" }: { task: ChecklistTask; className?: string }) {
  const editChecklist = useCommandStore((s) => s.editChecklist);
  if (!canHoldChecklist(task)) return null;
  return (
    <div role="group" aria-label="Checklist" className={`space-y-1.5 ${className}`}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-hud-muted">Checklist</div>
      <ChecklistItemsEditor
        items={checklistOf(task)}
        onEdit={(change) => void editChecklist(task.id, change)}
        newItemLabel="New checklist item"
        addLabel="Add checklist item"
      />
    </div>
  );
}

interface ChecklistItemsEditorProps {
  items: readonly ChecklistItem[];
  /** Applies one edit with the shared rule (a Task's Checklist, or a List's items). */
  onEdit: (edit: ChecklistEdit) => void;
  /** Accessible names of the add field and its button. */
  newItemLabel: string;
  addLabel: string;
}

/**
 * The item rows and the add field, shared by a Task's Checklist and a
 * standalone List: tick (ticked items stay in place, struck through), rename in
 * place, up / down, delete, add.
 */
export function ChecklistItemsEditor({ items, onEdit: edit, newItemLabel, addLabel }: ChecklistItemsEditorProps) {
  const [draft, setDraft] = useState("");
  const add = () => {
    if (!draft.trim()) return;
    edit({ kind: "add", id: newChecklistItemId(), text: draft });
    setDraft("");
  };

  return (
    <>
      {items.length > 0 && (
        <ul className="space-y-0.5">
          {items.map((item, index) => (
            <ChecklistItemRow
              key={item.id}
              item={item}
              isFirst={index === 0}
              isLast={index === items.length - 1}
              onEdit={edit}
              index={index}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          maxLength={MAX_CHECKLIST_TEXT_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add an item..."
          aria-label={newItemLabel}
          className="min-h-8 coarse:min-h-11 min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 text-xs text-neutral-200 placeholder:text-hud-muted focus:border-accent/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          aria-label={addLabel}
          className={`${ICON_BUTTON} border border-white/10`}
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </>
  );
}

interface ChecklistItemRowProps {
  item: ChecklistItem;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onEdit: (edit: ChecklistEdit) => void;
}

function ChecklistItemRow({ item, index, isFirst, isLast, onEdit }: ChecklistItemRowProps) {
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.text}
        onClick={() => onEdit({ kind: "toggle", id: item.id })}
        className="group/tick flex h-8 w-8 coarse:h-11 coarse:w-11 shrink-0 items-center justify-center rounded-lg transition-opacity duration-150 ease-out active:opacity-80"
      >
        <span
          className={`flex h-4 w-4 items-center justify-center rounded border transition-[color,background-color,border-color] duration-150 ease-out ${
            item.done
              ? "border-transparent bg-success text-black"
              : "border-white/40 text-transparent group-hover/tick:border-success"
          }`}
        >
          <Check className="h-3 w-3 stroke-[3]" />
        </span>
      </button>

      {/* Keyed by the stored text: an edit saved here or synced in resets the field. */}
      <ChecklistItemText key={item.text} item={item} onEdit={onEdit} />

      <button
        type="button"
        onClick={() => onEdit({ kind: "move", id: item.id, toIndex: index - 1 })}
        disabled={isFirst}
        aria-label={`Move ${item.text} up`}
        className={ICON_BUTTON}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onEdit({ kind: "move", id: item.id, toIndex: index + 1 })}
        disabled={isLast}
        aria-label={`Move ${item.text} down`}
        className={ICON_BUTTON}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => onEdit({ kind: "remove", id: item.id })}
        aria-label={`Delete ${item.text}`}
        className={`${ICON_BUTTON} hover:bg-danger/10 hover:text-danger`}
      >
        <X className="h-4 w-4" />
      </button>
    </li>
  );
}

/** The item's text, edited in place; saved on blur or Enter, a blank edit puts the old text back. */
function ChecklistItemText({ item, onEdit }: { item: ChecklistItem; onEdit: (edit: ChecklistEdit) => void }) {
  const [text, setText] = useState(item.text);
  const commit = () => {
    if (!text.trim()) setText(item.text);
    else if (text.trim() !== item.text) onEdit({ kind: "rename", id: item.id, text });
  };
  return (
    <input
      type="text"
      value={text}
      maxLength={MAX_CHECKLIST_TEXT_LENGTH}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      aria-label={`Rename ${item.text}`}
      className={`min-h-8 coarse:min-h-11 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 text-xs focus:border-white/15 focus:bg-black/40 focus:outline-none ${
        item.done ? "text-hud-muted line-through" : "text-neutral-200"
      }`}
    />
  );
}
