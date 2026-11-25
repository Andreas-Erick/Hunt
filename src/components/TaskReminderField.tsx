"use client";

import React, { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  ensureNotificationAccess,
  notificationAccess,
  type NotificationAccess,
} from "@/lib/desktopReminders";
import { useCommandStore } from "@/store/useCommandStore";

/** The reminder time on a Task row's metadata line. */
export function ReminderBadge({ time }: { time: string }) {
  return (
    <span
      aria-label={`Reminder at ${time}`}
      title={`Reminder at ${time}`}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-white/[0.07] bg-white/[0.02] px-2 py-0.5 font-mono text-[11px] tabular-nums text-hud-muted"
    >
      <Bell className="h-3 w-3" aria-hidden="true" />
      <span>{time}</span>
    </span>
  );
}

const ACCESS_NOTE: Partial<Record<NotificationAccess, string>> = {
  denied:
    "Notifications are blocked for Hunt, so this reminder will not show here. Allow notifications in the site settings (the icon left of the address), then reload.",
  unsupported: "Reminders show as notifications on the Hunt desktop app.",
};

/**
 * One reminder time on a dated Task (ADR-0007). Setting it asks for the
 * notification permission the first time; clearing it leaves the Task
 * date-only.
 */
export function TaskReminderField({
  taskId,
  taskTitle,
  reminderTime,
}: {
  taskId: string;
  taskTitle: string;
  reminderTime?: string;
}) {
  const updateTask = useCommandStore((s) => s.updateTask);
  // Read after mount: the server render has no Notification API.
  const [access, setAccess] = useState<NotificationAccess | null>(null);
  useEffect(() => setAccess(notificationAccess()), []);

  const save = (value: string) => {
    void updateTask(taskId, { reminderTime: value || null });
    if (value) void ensureNotificationAccess().then(setAccess);
  };

  const note = reminderTime && access ? ACCESS_NOTE[access] : undefined;

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-8 coarse:min-h-11 items-center gap-2 text-hud-muted">
          <Bell className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="whitespace-nowrap">Reminder</span>
          <input
            type="time"
            value={reminderTime ?? ""}
            onChange={(e) => save(e.target.value)}
            aria-label={`Reminder time for ${taskTitle}`}
            className="min-h-8 coarse:min-h-11 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1 font-mono tabular-nums text-neutral-200 focus:border-accent/50 focus:outline-none"
          />
        </label>
        {reminderTime && (
          <button
            type="button"
            onClick={() => save("")}
            aria-label="Clear reminder"
            className="flex min-h-8 coarse:min-h-11 items-center gap-1 rounded-lg px-2.5 py-1.5 text-hud-muted hover:bg-white/[0.06] hover:text-neutral-300 transition-colors duration-150 ease-out active:opacity-80"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Clear</span>
          </button>
        )}
      </div>
      {note && <p className="min-w-0 break-words text-hud-amber">{note}</p>}
    </div>
  );
}
