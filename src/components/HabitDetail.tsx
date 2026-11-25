"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Habit, Quest } from "@/lib/domainTypes";
import type { HabitDaySummary } from "@/lib/habitDay";
import { HabitCalendar } from "./HabitCalendar";
import { confirmDiscardHabitEdit, HabitEditForm } from "./HabitEditForm";
import { HabitStatistics } from "./HabitStatistics";

/** The detail screen's tabs, in order. */
const TABS = [
  { id: "calendar", label: "Calendar" },
  { id: "statistics", label: "Statistics" },
  { id: "edit", label: "Edit" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A Habit's detail screen: a dialog with one tab per view of the Habit
 * (Calendar, Statistics, Edit). Escape, the close button and a press on the
 * backdrop close it, asking first while the Edit tab holds unsaved edits;
 * focus stays inside while it is open and returns to the opener.
 */
export function HabitDetail({
  habit,
  todayKey,
  summary,
  metClass,
  quests,
  onClose: close,
}: {
  habit: Habit;
  todayKey: string;
  /** The Habit's day summary: its Outcomes, Count totals and Habit Score. */
  summary: Pick<HabitDaySummary, "outcomeOn" | "amountOn" | "score" | "weekOn">;
  /** The Habit's accent background class for a Met day. */
  metClass: string;
  /** The active Quests the Edit tab can assign the Habit to. */
  quests: readonly Quest[];
  onClose: () => void;
}) {
  const ids = useId();
  const [tab, setTab] = useState<TabId>("calendar");
  const [editDirty, setEditDirty] = useState(false);
  const onClose = () => {
    if (confirmDiscardHabitEdit(tab === "edit" && editDirty)) close();
  };
  const selectTab = (next: TabId) => {
    if (next === tab || !confirmDiscardHabitEdit(tab === "edit" && editDirty)) return;
    setEditDirty(false);
    setTab(next);
  };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const pressOnBackdrop = useRef(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  // Portalled to <body>: a Habit card is a size container, which would trap a fixed overlay.
  return createPortal(
    <div
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressOnBackdrop.current) onClose();
        pressOnBackdrop.current = false;
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-start sm:p-4 sm:pt-[8vh]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        onKeyDown={onKeyDown}
        className="max-h-[100dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-white/[0.1] bg-surface px-3 pb-5 pt-3 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl sm:px-5"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id={`${ids}-title`}
            className="min-w-0 break-words pt-1.5 text-base font-semibold leading-snug text-white [overflow-wrap:anywhere]"
          >
            {habit.title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80 coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div role="tablist" aria-label="Habit views" className="mt-2 flex gap-2 border-b border-white/[0.08]">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`${ids}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${ids}-panel-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={`-mb-px min-h-9 border-b-2 px-3 text-sm transition-colors duration-150 ease-out coarse:min-h-11 ${
                tab === t.id ? "border-accent text-white" : "border-transparent text-hud-muted hover:text-white"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "calendar" && (
          <div id={`${ids}-panel-calendar`} role="tabpanel" aria-labelledby={`${ids}-tab-calendar`} className="pt-4">
            <HabitCalendar
              habit={habit}
              todayKey={todayKey}
              outcomeOn={summary.outcomeOn}
              amountOn={summary.amountOn}
              weekOn={summary.weekOn}
              metClass={metClass}
            />
          </div>
        )}
        {tab === "statistics" && (
          <div id={`${ids}-panel-statistics`} role="tabpanel" aria-labelledby={`${ids}-tab-statistics`} className="pt-4">
            <HabitStatistics
              habit={habit}
              todayKey={todayKey}
              score={summary.score()}
              amountOn={summary.amountOn}
              metClass={metClass}
            />
          </div>
        )}
        {tab === "edit" && (
          <div id={`${ids}-panel-edit`} role="tabpanel" aria-labelledby={`${ids}-tab-edit`} className="pt-4">
            <HabitEditForm habit={habit} todayKey={todayKey} quests={quests} onDirtyChange={setEditDirty} onSaved={close} onCancel={close} />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
