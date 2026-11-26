"use client";

import React from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Shield, Undo2 } from "lucide-react";
import type { Habit, Task } from "@/lib/domainTypes";
import { avoidDayLabel, habitKindOf } from "@/lib/habitKind";
import { reads } from "@/lib/reads";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";
import { StableSlot } from "./StableSlot";

/**
 * An Avoid Habit card's mark where other Kinds have their tick (GLOSSARY: Avoid
 * Habit). It is not a target: the day is kept unless a Slip is logged, and a
 * Slip is logged only from its own labelled button (AvoidSlipControls).
 */
export function AvoidDayMark({ slipped, accentText }: { slipped: boolean; accentText: string }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center ${slipped ? "text-danger" : accentText}`}
    >
      <Shield className="h-4 w-4" />
    </span>
  );
}

/**
 * Today's state of an Avoid Habit ("Kept so far", "1 Slip") and its one action:
 * Log a Slip while there is none, Undo Slip once there is. Both the label and
 * the button keep the width of their widest state, so logging a Slip moves
 * nothing beside them.
 */
export function AvoidSlipControls({
  habit,
  slips,
  onLog,
  onUndo,
}: {
  habit: Habit;
  slips: number;
  onLog: () => void;
  onUndo: () => void;
}) {
  const slipped = slips > 0;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <StableSlot
        active={slipped ? "slipped" : "kept"}
        states={{
          kept: <span className="text-xs text-neutral-300">{avoidDayLabel(0)}</span>,
          slipped: <span className="text-xs text-danger">{avoidDayLabel(Math.max(slips, 1))}</span>,
        }}
      />
      <button
        type="button"
        onClick={slipped ? onUndo : onLog}
        aria-label={`${slipped ? "Undo Slip" : "Log a Slip"} on ${habit.title}`}
        className="-my-1 flex min-h-8 coarse:min-h-11 items-center rounded-full px-2.5 py-1 text-xs text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
      >
        <StableSlot
          active={slipped ? "undo" : "log"}
          states={{
            log: <span>Log a Slip</span>,
            undo: (
              <span className="flex items-center gap-1">
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Undo Slip</span>
              </span>
            ),
          }}
        />
      </button>
    </span>
  );
}

/** True when `task` is an Avoid Habit's day (its tick then logs a Slip). */
export function useIsAvoidDay(task: Pick<Task, "habitId">): boolean {
  const habitId = task.habitId;
  const habit = useLiveQuery(() => (habitId ? reads.habit(habitId) : undefined), [habitId]);
  return habitKindOf(habit) === "avoid";
}

/**
 * An Avoid Habit day's row in Today: "Kept so far" and a labelled Log a Slip
 * button where other rows have their tick, so the tick is never mistaken for
 * "kept". It calls the row's complete action, whose shared rule logs the Slip.
 */
export function AvoidRowSlip({ title, onSlip }: { title: string; onSlip: () => void }) {
  return (
    <>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 text-[11px] text-neutral-300">
        <Shield className="h-3 w-3" aria-hidden="true" />
        <span>Kept so far</span>
      </span>
      <button
        type="button"
        onClick={(e) => {
          if (e.detail > 1) return; // the second click of a double-click
          onSlip();
        }}
        aria-label={`Log a Slip on ${title}`}
        className="-my-1 flex min-h-8 coarse:min-h-11 items-center rounded-full px-2.5 py-1 text-xs text-hud-muted transition-colors duration-150 ease-out hover:bg-white/[0.05] hover:text-white active:opacity-80"
      >
        Log a Slip
      </button>
    </>
  );
}

/**
 * A task row's tick (`children`), or on an Avoid Habit's day "Kept so far" and
 * a labelled Log a Slip button in its place (AvoidRowSlip), for the lists that
 * show day Tasks outside Today: Plan the Week and the Quest panel. The Slip
 * goes through the store's complete action, whose shared rule logs it.
 */
export function TickOrSlip({
  task,
  children,
}: {
  task: Pick<Task, "id" | "title" | "habitId">;
  children: React.ReactNode;
}) {
  const completeTaskById = useCommandStore((s) => s.completeTaskById);
  const avoidDay = useIsAvoidDay(task);
  if (!avoidDay) return <>{children}</>;
  const slip = () => {
    hudAudio.playClick();
    void completeTaskById(task.id);
  };
  return <AvoidRowSlip title={task.title} onSlip={slip} />;
}

/** Logs or undoes a Slip on an Avoid Habit's `todayKey` through the store, with a click. */
export function useEditHabitSlip(todayKey: string) {
  const editHabitSlip = useCommandStore((s) => s.editHabitSlip);
  return (habit: Habit, edit: "log" | "undo") => {
    hudAudio.playClick();
    void editHabitSlip(habit.id, todayKey, edit);
  };
}
