"use client";

import React from "react";
import { Check } from "lucide-react";
import type { Task } from "@/lib/domainTypes";
import { TickOrSlip } from "./AvoidHabitControls";

/**
 * The small round "Mark complete" tick of a Plan the Week card or a Quest
 * panel step, or on an Avoid Habit's day its labelled Log a Slip button
 * (TickOrSlip). `className` sizes and colours the tick; its touch target comes
 * from a padded ::before.
 */
export function RowTick({
  task,
  onComplete,
  className,
}: {
  task: Pick<Task, "id" | "title" | "habitId">;
  onComplete: () => void;
  className: string;
}) {
  return (
    <TickOrSlip task={task}>
      <button
        type="button"
        onClick={(e) => {
          // The second click of a double-click would hit the next row,
          // which slides up under the cursor.
          if (e.detail > 1) return;
          onComplete();
        }}
        title="Mark complete"
        aria-label="Mark complete"
        className={className}
      >
        <Check className="h-2.5 w-2.5" />
      </button>
    </TickOrSlip>
  );
}
