"use client";

import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Filter } from "lucide-react";
import type { Quest } from "@/lib/domainTypes";
import { accentStyle, type QuestAccentStyle } from "@/lib/questAccents";
import type { ReviewScope } from "@/lib/reviewAnalytics";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";

/** A Review scope's display name and accent (null: the aggregate "All Quests"). */
export function describeReviewScope(
  scope: ReviewScope,
  selectedQuest: Quest | null
): { title: string; style: QuestAccentStyle | null } {
  const title =
    scope === "ALL" ? "All Quests" : scope === "OTHER" ? "Other work" : selectedQuest?.title ?? "All Quests";
  const style = selectedQuest
    ? accentStyle(selectedQuest.accentColor)
    : scope === "OTHER"
    ? accentStyle("slate")
    : null;
  return { title, style };
}

/**
 * The Review's Quest scope picker: a pill that opens a listbox of All Quests,
 * every Quest, and Other work. Outside press and Escape close it; opening
 * focuses the selected option; arrows, Home and End move between options.
 */
export function ReviewScopePicker({
  quests,
  value,
  onChange,
}: {
  quests: readonly Quest[];
  /** The scope in effect (already ALL when the chosen Quest is gone). */
  value: ReviewScope;
  onChange: (scope: ReviewScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);

  const selectedQuest = value === "ALL" || value === "OTHER" ? null : quests.find((q) => q.id === value) ?? null;
  const { title: scopeTitle, style: scopeStyle } = describeReviewScope(value, selectedQuest);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      // The focused option unmounts with the list: hand focus back to the trigger.
      triggerRef.current?.focus();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Opening the list moves focus to the selected option (or the first one).
  useEffect(() => {
    if (!open) return;
    const listbox = listboxRef.current;
    const target =
      listbox?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      listbox?.querySelector<HTMLElement>('[role="option"]');
    target?.focus();
  }, [open]);

  /** Picking an option closes the list; focus returns to the trigger instead of <body>. */
  const handleOptionSelect = (next: ReviewScope) => {
    setOpen(false);
    onChange(next);
    triggerRef.current?.focus();
  };

  /** ArrowUp / ArrowDown (wrapping), Home and End move focus between the options. */
  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')
    );
    if (options.length === 0) return;
    e.preventDefault();
    const current = options.findIndex((el) => el === document.activeElement);
    const last = options.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
        ? last
        : e.key === "ArrowDown"
        ? current < 0 || current === last
          ? 0
          : current + 1
        : current <= 0
        ? last
        : current - 1;
    options[next].focus();
  };

  return (
    <div ref={menuRef} className="relative max-w-full">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter review scope: ${scopeTitle}`}
        className={`flex max-w-full coarse:min-h-11 items-center gap-2 rounded-full border border-white/10 bg-surface px-3.5 py-2 text-xs font-medium text-neutral-200 hover:border-white/25 ${PRESSABLE}`}
      >
        {scopeStyle ? (
          <span className={`h-2 w-2 shrink-0 rounded-full ${scopeStyle.bg}`} />
        ) : (
          <Filter className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
        )}
        <span className="max-w-[160px] truncate">
          {value === "ALL" ? "All Quests" : scopeTitle}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-hud-muted" />
      </button>

      {open && (
        <div
          ref={listboxRef}
          role="listbox"
          aria-label="Quest filter options"
          onKeyDown={handleListKeyDown}
          className="absolute left-0 lg:left-auto lg:right-0 z-30 mt-2 max-h-[min(22rem,70dvh)] w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/12 bg-raised p-1 shadow-2xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === "ALL"}
            tabIndex={value === "ALL" ? 0 : -1}
            onClick={() => handleOptionSelect("ALL")}
            className={`flex w-full coarse:min-h-11 items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
              value === "ALL"
                ? "bg-white/10 font-medium text-white"
                : "text-neutral-300 hover:bg-white/[0.05]"
            } ${PRESSABLE}`}
          >
            <span>All Quests</span>
            <span className="text-[11px] text-hud-muted">Aggregate</span>
          </button>

          {quests.map((q) => {
            const st = accentStyle(q.accentColor);
            const active = value === q.id;
            return (
              <button
                key={q.id}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => handleOptionSelect(q.id)}
                className={`mt-0.5 flex w-full coarse:min-h-11 items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs ${
                  active
                    ? "bg-white/10 font-medium text-white"
                    : "text-neutral-300 hover:bg-white/[0.05]"
                } ${PRESSABLE}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${st.bg}`} />
                  <span className="truncate">{q.title}</span>
                </span>
                {q.archived && (
                  <span className="shrink-0 text-[10px] text-hud-muted">Done</span>
                )}
              </button>
            );
          })}

          <div className="my-1 border-t border-white/[0.06]" />
          <button
            type="button"
            role="option"
            aria-selected={value === "OTHER"}
            tabIndex={value === "OTHER" ? 0 : -1}
            onClick={() => handleOptionSelect("OTHER")}
            className={`flex w-full coarse:min-h-11 items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
              value === "OTHER"
                ? "bg-white/10 font-medium text-white"
                : "text-neutral-300 hover:bg-white/[0.05]"
            } ${PRESSABLE}`}
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-slate-500" />
              <span>Other work</span>
            </span>
            <span className="text-[11px] text-hud-muted">Unassigned</span>
          </button>
        </div>
      )}
    </div>
  );
}
