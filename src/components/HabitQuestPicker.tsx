"use client";

import React from "react";
import type { Quest } from "@/lib/domainTypes";
import { accentStyle } from "@/lib/questAccents";
import { hudAudio } from "@/lib/hudAudio";

/** The new-habit form's Quest choice: active Quests, then Other work (null). */
export function NewHabitQuestPicker({
  quests,
  selectedQuestId,
  otherSelected,
  onSelect,
}: {
  quests: readonly Quest[];
  selectedQuestId: string | null;
  otherSelected: boolean;
  onSelect: (questId: string | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Quest for new habit"
      className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3"
    >
      {quests.map((q) => {
        const st = accentStyle(q.accentColor);
        const isSelected = selectedQuestId === q.id;
        return (
          <button
            key={q.id}
            type="button"
            onClick={() => {
              hudAudio.playClick();
              onSelect(q.id);
            }}
            aria-pressed={isSelected}
            className={`flex min-w-0 max-w-full sm:max-w-[230px] items-center gap-2 rounded-full border min-h-8 coarse:min-h-11 px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
              isSelected
                ? `${st.border} bg-white/[0.06] text-white`
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
          onSelect(null);
        }}
        aria-pressed={otherSelected}
        className={`flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-[color,background-color,border-color,opacity] duration-150 ease-out active:opacity-80 ${
          otherSelected
            ? "border-white/30 bg-white/[0.08] text-white"
            : "border-white/[0.07] text-hud-muted hover:text-neutral-300"
        }`}
      >
        <span className="h-2 w-2 rounded-full bg-neutral-500" />
        <span>Other work</span>
      </button>
    </div>
  );
}

/** The habit edit form's Quest choice: active Quests, then Other work (null). */
export function EditHabitQuestPicker({
  quests,
  questId,
  onSelect,
}: {
  quests: readonly Quest[];
  questId: string | null;
  onSelect: (questId: string | null) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Habit quest"
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      {quests.map((q) => {
        const qStyle = accentStyle(q.accentColor);
        const active = questId === q.id;
        return (
          <button
            key={q.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(q.id)}
            className={`flex min-h-8 coarse:min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
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
        aria-pressed={questId === null}
        onClick={() => onSelect(null)}
        className={`min-h-8 coarse:min-h-11 rounded-full border px-3 py-1.5 text-xs transition-colors duration-150 ease-out active:opacity-80 ${
          questId === null
            ? "border-white/25 bg-white/10 text-white"
            : "border-transparent text-hud-muted hover:text-neutral-300"
        }`}
      >
        Other work
      </button>
    </div>
  );
}
