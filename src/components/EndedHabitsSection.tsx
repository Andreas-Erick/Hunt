"use client";

import React, { useId, useState } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import type { Habit, Quest } from "@/lib/domainTypes";
import type { HabitDaySummary } from "@/lib/habitDay";
import { habitEndDateLabel } from "@/lib/habitEnd";
import { hudAudio } from "@/lib/hudAudio";
import { accentStyle } from "@/lib/questAccents";
import { useCommandStore } from "@/store/useCommandStore";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { HabitCardStats } from "./HabitCardStats";
import { HeightReveal } from "./HeightReveal";

const BUTTON =
  "min-h-8 coarse:min-h-11 rounded-lg px-3 py-1.5 text-xs transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80";

/**
 * The Habits view's collapsed "Ended" section (GLOSSARY: Ended Habit). Each
 * Ended Habit keeps its last week up to the end date, its final Streak and
 * Success Rate (HabitCardStats), and can be restarted (end date cleared), have
 * its end date moved, or be deleted with all its history. Renders nothing without Ended Habits.
 */
export function EndedHabitsSection({
  habits,
  summaryFor,
  todayKey,
  questMap,
}: {
  habits: readonly Habit[];
  summaryFor: (habitId: string) => HabitDaySummary;
  todayKey: string;
  questMap: ReadonlyMap<string, Quest>;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (habits.length === 0) return null;
  return (
    <section className="mt-8" aria-label="Ended habits">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          hudAudio.playClick();
          setOpen((v) => !v);
        }}
        className="flex min-h-8 coarse:min-h-11 items-center gap-2 rounded-lg px-1 text-sm text-hud-muted transition-colors duration-150 ease-out hover:text-white active:opacity-80"
      >
        <ChevronDown
          className={`h-4 w-4 transition-transform duration-150 ease-out ${open ? "" : "-rotate-90"}`}
          aria-hidden="true"
        />
        <span>Ended ({habits.length})</span>
      </button>
      <HeightReveal show={open}>
        <div id={listId} className="mt-3 space-y-3">
          {habits.map((habit) => (
            <EndedHabitCard
              key={habit.id}
              habit={habit}
              summary={summaryFor(habit.id)}
              todayKey={todayKey}
              quest={habit.questId ? questMap.get(habit.questId) : undefined}
            />
          ))}
        </div>
      </HeightReveal>
    </section>
  );
}

function EndedHabitCard({
  habit,
  summary,
  todayKey,
  quest,
}: {
  habit: Habit;
  summary: HabitDaySummary;
  todayKey: string;
  quest: Quest | undefined;
}) {
  const updateHabit = useCommandStore((s) => s.updateHabit);
  const deleteHabit = useCommandStore((s) => s.deleteHabit);
  const endDate = habit.endDate ?? todayKey;
  const [moveTo, setMoveTo] = useState(endDate);
  const style = accentStyle(quest?.accentColor ?? "slate");
  const { title } = habit;

  const setEndDate = (next: string | null) => {
    hudAudio.playClick();
    void updateHabit(habit.id, { endDate: next });
  };

  return (
    <div
      data-testid="ended-habit-row"
      className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-surface/70 p-4 pl-5 sm:pl-6"
    >
      <div className={`absolute bottom-3.5 left-0 top-3.5 w-1 rounded-r-full opacity-45 ${style.bg}`} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="break-words [overflow-wrap:anywhere] text-base font-medium leading-snug text-neutral-300">{title}</div>
          <div className="mt-1 break-words [overflow-wrap:anywhere] text-xs text-hud-muted">
            Ended {habitEndDateLabel(endDate, todayKey)} · {quest ? quest.title : "Other work"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setEndDate(null)}
            aria-label={`Restart habit ${title}`}
            className={`${BUTTON} text-neutral-300`}
          >
            Restart
          </button>
          <ConfirmDeleteButton
            label={`Delete habit ${title}`}
            confirmLabel="Delete habit?"
            onConfirm={() => deleteHabit(habit.id)}
            className="ml-1 flex h-9 min-w-9 coarse:h-11 coarse:min-w-11 items-center justify-center rounded-lg px-2 text-hud-muted hover:bg-white/[0.05] hover:text-danger data-[state=armed]:opacity-100"
          >
            <Trash2 className="h-4 w-4" />
          </ConfirmDeleteButton>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* The week up to the end date, the final Streak and Success Rate; no Habit Week progress. */}
          <HabitCardStats
            summary={{ outcomeOn: summary.outcomeOn, streak: summary.streak, streakUnit: summary.streakUnit, successRate: summary.successRate }}
            todayKey={todayKey}
            lastKey={endDate}
            metClass={style.bg}
          />
        </div>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (moveTo && moveTo !== endDate) setEndDate(moveTo);
          }}
        >
          <input
            type="date"
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            aria-label={`End date of ${title}`}
            className="min-h-8 coarse:min-h-11 rounded-xl border border-white/15 bg-black/40 px-3 py-1.5 text-xs text-neutral-200 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!moveTo || moveTo === endDate}
            aria-label={`Move end date of ${title}`}
            className={`${BUTTON} text-neutral-300 disabled:opacity-40`}
          >
            Move
          </button>
        </form>
      </div>
    </div>
  );
}
