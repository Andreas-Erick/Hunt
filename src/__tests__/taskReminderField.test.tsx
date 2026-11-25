// The desktop Task drawer's reminder control: a dated Task gets one reminder time, which can be
// cleared again; setting one asks for the notification permission the first time, and says plainly
// when notifications are blocked or unavailable on this device.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/db";
import { toLocalDateKey } from "@/lib/dateUtils";
import type { Task } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { CommandCenterView } from "@/components/CommandCenterView";
import { TaskReminderField } from "@/components/TaskReminderField";

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, requestSync: s.requestSync };
})();

let permission: NotificationPermission;
const requestPermission = vi.fn(async () => {
  permission = "granted";
  return permission;
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1",
    title: "Call the bank",
    notes: "",
    questId: "quest-1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: toLocalDateKey(Date.now()),
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

beforeEach(async () => {
  permission = "default";
  requestPermission.mockClear();
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  await Promise.all([db.tasks.clear(), db.quests.clear(), db.habits.clear()]);
  await db.quests.put({
    id: "quest-1",
    slotIndex: 0,
    code: "CORE",
    title: "Launch my idea",
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 5,
    archived: false,
    createdAt: 1,
  });
  useCommandStore.setState({ syncNow: vi.fn(async () => true), requestSync: vi.fn() });
});

afterEach(() => {
  cleanup();
  useCommandStore.setState(realActions);
  vi.unstubAllGlobals();
});

describe("TaskReminderField", () => {
  it("saves a reminder time, asking for the notification permission the first time", async () => {
    await db.tasks.put(task());
    render(<TaskReminderField taskId="tsk-1" taskTitle="Call the bank" />);
    fireEvent.change(screen.getByLabelText("Reminder time for Call the bank"), { target: { value: "16:45" } });
    await waitFor(async () => expect((await db.tasks.get("tsk-1"))?.reminderTime).toBe("16:45"));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("clears the reminder, leaving the Task date-only", async () => {
    await db.tasks.put(task({ reminderTime: "16:45" }));
    render(<TaskReminderField taskId="tsk-1" taskTitle="Call the bank" reminderTime="16:45" />);
    fireEvent.click(screen.getByRole("button", { name: "Clear reminder" }));
    await waitFor(async () => expect(await db.tasks.get("tsk-1")).not.toHaveProperty("reminderTime"));
  });

  it("says why no notification will come when they are blocked", async () => {
    permission = "denied";
    render(<TaskReminderField taskId="tsk-1" taskTitle="Call the bank" reminderTime="16:45" />);
    expect(await screen.findByText(/Notifications are blocked/)).toBeInTheDocument();
  });

  it("says where reminders arrive on a device without notifications", async () => {
    vi.stubGlobal("Notification", undefined);
    render(<TaskReminderField taskId="tsk-1" taskTitle="Call the bank" reminderTime="16:45" />);
    expect(await screen.findByText(/on the Hunt desktop app/)).toBeInTheDocument();
  });
});

describe("Task drawer", () => {
  it("offers a reminder on a dated Task, and shows the time on the row once set", async () => {
    await db.tasks.put(task({ reminderTime: "16:45" }));
    render(<CommandCenterView />);
    expect(await screen.findByLabelText("Reminder at 16:45")).toBeInTheDocument();
    fireEvent.click(await screen.findByTitle("Task notes & options"));
    expect(await screen.findByLabelText("Reminder time for Call the bank")).toHaveValue("16:45");
  });

  it("offers no reminder on an undated Task", async () => {
    await db.tasks.put(task({ scheduledDate: undefined }));
    render(<CommandCenterView />);
    fireEvent.click(await screen.findByTitle("Task notes & options"));
    await screen.findByPlaceholderText("Add session notes...");
    expect(screen.queryByLabelText("Reminder time for Call the bank")).toBeNull();
  });
});
