"use client";

import React, { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useShallow } from "zustand/react/shallow";
import { Eraser, ListChecks, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { List } from "@/lib/domainTypes";
import { listItemsOf, listProgress, MAX_LIST_TITLE_LENGTH, type ListEdit } from "@/lib/lists";
import { reads } from "@/lib/reads";
import { useCommandStore } from "@/store/useCommandStore";
import { hudAudio } from "@/lib/hudAudio";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { ChecklistItemsEditor } from "./TaskChecklist";

const ACTION_BUTTON =
  "flex min-h-8 coarse:min-h-11 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-xs text-neutral-300 transition-[color,background-color,opacity] duration-150 ease-out hover:bg-white/[0.06] hover:text-white active:opacity-80 disabled:pointer-events-none disabled:opacity-30";

/**
 * The Lists section: standalone Lists (a name and items to tick; no date, no
 * Quest, no focus time), kept apart from Today. Items use the Checklist
 * editor; "Clear ticked" and "Untick all" act on the whole List. Every rule is
 * the shared one in lists.ts (the phone uses the same).
 */
export function ListsView() {
  const createList = useCommandStore((s) => s.createList);
  const lists = useLiveQuery(reads.lists, []);
  const [newTitle, setNewTitle] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    hudAudio.playClick();
    if (await createList(newTitle)) setNewTitle("");
  };

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      <div className="mb-8 sm:mb-10">
        <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium leading-tight tracking-tight text-white">
          Lists
        </h1>
        <p className="mt-2 max-w-[65ch] text-sm text-neutral-400">
          Shopping and reference lists, kept apart from your day. No dates, no Quests.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="mb-8 flex flex-col gap-3 rounded-2xl border border-dashed border-white/[0.15] bg-surface/60 p-4 transition-colors focus-within:border-white/40 sm:flex-row sm:items-center"
      >
        <input
          type="text"
          value={newTitle}
          maxLength={MAX_LIST_TITLE_LENGTH}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Name a new List..."
          aria-label="New List name"
          className="min-h-8 coarse:min-h-11 min-w-0 flex-1 bg-transparent px-1 py-1 text-base text-white placeholder:text-hud-muted focus:outline-none"
        />
        <button
          type="submit"
          disabled={!newTitle.trim()}
          aria-label="Create List"
          className="flex min-h-8 coarse:min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-black transition-[background-color,opacity,transform] duration-150 ease-out hover:bg-white active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>New List</span>
        </button>
      </form>

      {lists === undefined ? (
        <div aria-busy="true" className="h-32 animate-pulse rounded-2xl bg-white/[0.04]" />
      ) : lists.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/[0.08] py-16 text-center text-sm text-hud-muted">
          No Lists yet. Name one above, then add its items.
        </div>
      ) : (
        <div className="grid gap-3.5 md:grid-cols-2">
          {lists.map((list) => (
            <ListCard key={list.id} list={list} />
          ))}
        </div>
      )}
    </div>
  );
}

function ListCard({ list }: { list: List }) {
  const { renameList, editList, deleteList } = useCommandStore(
    useShallow((s) => ({ renameList: s.renameList, editList: s.editList, deleteList: s.deleteList }))
  );
  const titleId = `list-title-${list.id}`;
  const progress = listProgress(list);
  const edit = (change: ListEdit) => void editList(list.id, change);

  return (
    <section
      aria-labelledby={titleId}
      data-testid="list-card"
      className="cq-card min-w-0 space-y-2 rounded-2xl border border-white/[0.08] bg-surface p-4 sm:p-5"
    >
      <h2 id={titleId} className="sr-only">
        {list.title}
      </h2>
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 shrink-0 text-hud-muted" aria-hidden="true" />
        {/* Keyed by the stored title: a rename saved here or synced in resets the field. */}
        <ListTitleField key={list.title} list={list} onRename={(title) => void renameList(list.id, title)} />
        <span
          aria-label={`${progress.done} of ${progress.total} ticked`}
          className="shrink-0 whitespace-nowrap font-mono text-[11px] tabular-nums text-hud-muted"
        >
          <span aria-hidden="true">
            {progress.done}/{progress.total}
          </span>
        </span>
        <ConfirmDeleteButton
          label={`Delete List ${list.title}`}
          confirmLabel="Delete List?"
          onConfirm={() => deleteList(list.id)}
          className="flex h-8 min-w-8 coarse:h-11 coarse:min-w-11 shrink-0 items-center justify-center rounded-lg px-2 text-hud-muted hover:bg-white/[0.05] hover:text-danger"
        >
          <Trash2 className="h-4 w-4" />
        </ConfirmDeleteButton>
      </div>

      <ChecklistItemsEditor items={listItemsOf(list)} onEdit={edit} newItemLabel="New item" addLabel="Add item" />

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => edit({ kind: "clearTicked" })}
          disabled={progress.done === 0}
          className={ACTION_BUTTON}
        >
          <Eraser className="h-3.5 w-3.5" aria-hidden="true" />
          Clear ticked
        </button>
        <button
          type="button"
          onClick={() => edit({ kind: "untickAll" })}
          disabled={progress.done === 0}
          className={ACTION_BUTTON}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          Untick all
        </button>
      </div>
    </section>
  );
}

/** The List's name, edited in place; saved on blur or Enter, a blank edit puts the old name back. */
function ListTitleField({ list, onRename }: { list: List; onRename: (title: string) => void }) {
  const [title, setTitle] = useState(list.title);
  const commit = () => {
    if (!title.trim()) setTitle(list.title);
    else if (title.trim() !== list.title) onRename(title);
  };
  return (
    <input
      type="text"
      value={title}
      maxLength={MAX_LIST_TITLE_LENGTH}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      aria-label={`Rename ${list.title}`}
      className="min-h-8 coarse:min-h-11 min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent px-1.5 text-base font-medium text-white focus:border-white/15 focus:bg-black/40 focus:outline-none"
    />
  );
}
