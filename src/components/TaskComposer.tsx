"use client";

import { useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { accentStyle } from "@/lib/questAccents";
import type { Quest } from "@/lib/domainTypes";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";

interface TaskComposerProps {
  /** False while the quests are still loading. */
  questsLoaded: boolean;
  /** Quests a new task can join, in display order. */
  activeQuests: Quest[];
  activeQuestMap: Map<string, Quest>;
}

/**
 * Home's dashed quick-add box: title, optional description, the quest the
 * task joins, and Top / Bottom placement in the queue.
 */
export function TaskComposer({
  questsLoaded,
  activeQuests,
  activeQuestMap,
}: TaskComposerProps) {
  const createTask = useCommandStore((s) => s.createTask);

  // Input State
  const [newTitle, setNewTitle] = useState("");
  const [newNotes, setNewNotes] = useState("");
  // Set synchronously by the first add; drops activations that arrive before
  // React re-renders with the cleared input.
  const addingRef = useRef(false);
  // Explicit quest choice for new tasks: undefined = default (first quest),
  // null = Other work.
  const [questChoice, setQuestChoice] = useState<string | null | undefined>(
    undefined
  );

  // Default quest for new tasks = first active quest (never a hardcoded,
  // completed or deleted id); an explicit pick sticks while that quest is active.
  const selectedQuestId: string | null =
    questChoice === null
      ? null
      : questChoice !== undefined && activeQuestMap.has(questChoice)
      ? questChoice
      : activeQuests[0]?.id ?? null;
  const otherWorkSelected = questsLoaded && selectedQuestId === null;

  const handleAdd = async (promoteToTop: boolean) => {
    const title = newTitle.trim();
    const rawNotes = newNotes;
    const trimmedNotes = rawNotes.trim();
    // The input is cleared before the write, so a double click or a repeated
    // Enter cannot create the task twice.
    if (!title || addingRef.current) return;
    addingRef.current = true;
    setNewTitle("");
    setNewNotes("");
    hudAudio.playClick();
    let created = false;
    try {
      // Resolves false when the local write failed (the store reports it).
      created = await createTask({
        title,
        questId: selectedQuestId,
        promoteToTop,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      });
    } finally {
      addingRef.current = false;
      // Give the title & description back unless something new was typed meanwhile.
      if (!created) {
        setNewTitle((current) => (current === "" ? title : current));
        setNewNotes((current) => (current === "" ? rawNotes : current));
      }
    }
  };

  return (
    <div className="rounded-2xl border border-dashed border-white/[0.15] bg-surface/60 p-4 transition-colors focus-within:border-white/40">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd(true);
            }
          }}
          placeholder="Add quest work..."
          aria-label="Add quest work"
          className="min-h-8 coarse:min-h-11 flex-1 bg-transparent px-1 py-1 text-base text-white placeholder:text-hud-muted focus:outline-none"
        />

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={!newTitle.trim()}
            onClick={() => handleAdd(true)}
            className="flex min-h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10 active:opacity-80 disabled:cursor-not-allowed coarse:min-h-11 disabled:opacity-40 transition-[color,background-color,border-color,opacity] duration-150 ease-out"
          >
            <ArrowUpToLine className="h-3.5 w-3.5" />
            <span>Top</span>
          </button>
          <button
            type="button"
            disabled={!newTitle.trim()}
            onClick={() => handleAdd(false)}
            className="flex min-h-8 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-neutral-400 hover:bg-white/10 hover:text-white active:opacity-80 disabled:cursor-not-allowed coarse:min-h-11 disabled:opacity-40 transition-[color,background-color,border-color,opacity] duration-150 ease-out"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            <span>Bottom</span>
          </button>
        </div>
      </div>

      <div className="mt-2 border-t border-white/[0.05] pt-2">
        <input
          type="text"
          value={newNotes}
          onChange={(e) => setNewNotes(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd(true);
            }
          }}
          placeholder="Add description (optional)..."
          aria-label="Task description (optional)"
          className="w-full bg-transparent px-1 py-1 coarse:py-3 text-xs text-neutral-200 placeholder:text-hud-muted focus:outline-none"
        />
      </div>

      {/* Quest Selector Pills inside the Add Box */}
      <div
        role="group"
        aria-label="Quest for new task"
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3"
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
              className={`flex min-w-0 max-w-full sm:max-w-[230px] min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
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
          aria-pressed={otherWorkSelected}
          className={`flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
            otherWorkSelected
              ? "border-white/30 bg-white/[0.08] text-white font-medium"
              : "border-white/[0.07] text-hud-muted hover:text-neutral-300"
          }`}
        >
          <span className="h-2 w-2 rounded-full bg-neutral-500" />
          <span>Other work</span>
        </button>
      </div>
    </div>
  );
}
