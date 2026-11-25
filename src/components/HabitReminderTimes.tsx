"use client";

import React, { useEffect, useId, useState } from "react";
import { Bell, Plus, X } from "lucide-react";
import {
  ensureNotificationAccess,
  notificationAccess,
  type NotificationAccess,
} from "@/lib/desktopReminders";
import { MAX_HABIT_REMINDER_TIMES, sanitizeHabitReminderTimes } from "@/lib/reminderTime";
import { useCommandStore } from "@/store/useCommandStore";
import { REMINDER_ACCESS_NOTE } from "./TaskReminderField";

/** A Habit's reminder times on its card's metadata line; nothing when it has none. */
export function HabitReminderBadge({ times }: { times?: readonly string[] }) {
  const list = sanitizeHabitReminderTimes(times);
  if (!list) return null;
  const label = `Reminders at ${list.join(", ")}`;
  return (
    <span
      aria-label={label}
      title={label}
      className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.02] px-2.5 py-0.5 font-mono text-[11px] tabular-nums text-hud-muted"
    >
      <Bell className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{list.join(" · ")}</span>
    </span>
  );
}

/**
 * A Habit's reminder times (ADR-0007), in its edit panel. Each change saves
 * right away, as a Task's reminder does; the first one set asks for the
 * notification permission. A reminder rings only on scheduled days still Open.
 */
export function HabitReminderTimes({
  habitId,
  habitTitle,
  times,
}: {
  habitId: string;
  habitTitle: string;
  times?: readonly string[];
}) {
  const updateHabit = useCommandStore((s) => s.updateHabit);
  const [draft, setDraft] = useState("");
  // Read after mount: the server render has no Notification API.
  const [access, setAccess] = useState<NotificationAccess | null>(null);
  useEffect(() => setAccess(notificationAccess()), []);
  const labelId = useId();

  const list = sanitizeHabitReminderTimes(times) ?? [];
  const full = list.length >= MAX_HABIT_REMINDER_TIMES;
  const save = (next: string[]) => void updateHabit(habitId, { reminderTimes: next });
  const add = () => {
    if (!draft) return;
    save([...list, draft]);
    setDraft("");
    void ensureNotificationAccess().then(setAccess);
  };

  const note = list.length > 0 && access ? REMINDER_ACCESS_NOTE[access] : undefined;

  return (
    <div role="group" aria-labelledby={labelId} className="space-y-1.5 text-xs">
      <span id={labelId} className="block text-neutral-400">
        Reminders (on scheduled days still open; saved right away)
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {list.map((time) => (
          <span
            key={time}
            className="inline-flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg border border-white/10 bg-black/40 pl-2.5 font-mono tabular-nums text-neutral-200"
          >
            <Bell className="h-3.5 w-3.5 shrink-0 text-hud-muted" aria-hidden="true" />
            <span>{time}</span>
            <button
              type="button"
              onClick={() => save(list.filter((t) => t !== time))}
              aria-label={`Remove reminder at ${time}`}
              className="grid h-8 w-8 coarse:h-11 coarse:w-11 place-items-center rounded-lg text-hud-muted hover:bg-white/[0.06] hover:text-neutral-300 transition-colors duration-150 ease-out active:opacity-80"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </span>
        ))}
        {!full && (
          <span className="inline-flex items-center gap-1.5">
            <input
              type="time"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault(); // Enter adds the time; it never submits the edit form
                add();
              }}
              aria-label={`New reminder time for ${habitTitle}`}
              className="min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 font-mono tabular-nums text-neutral-200 focus:border-accent/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={add}
              disabled={!draft}
              aria-label="Add reminder"
              className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg px-2.5 py-1.5 text-hud-muted hover:bg-white/[0.06] hover:text-neutral-300 transition-colors duration-150 ease-out active:opacity-80 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Add</span>
            </button>
          </span>
        )}
      </div>
      {note && <p className="min-w-0 break-words text-hud-amber">{note}</p>}
    </div>
  );
}
