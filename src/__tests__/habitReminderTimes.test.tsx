// The desktop Habit card's reminder times (#31): add one or more times, remove one, and see them on
// the card. Each change saves right away (like a Task's reminder), asking for the notification
// permission the first time.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/db";
import type { Habit } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { HabitsView } from "@/components/HabitsView";

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, requestSync: s.requestSync };
})();

let permission: NotificationPermission;
const requestPermission = vi.fn(async () => {
  permission = "granted";
  return permission;
});

function habit(overrides: Partial<Habit> = {}): Habit {
  return { id: "hab-1", title: "Read", notes: "", questId: null, rank: 1000, createdAt: 10, ...overrides };
}

async function openEdit() {
  render(<HabitsView />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit habit Read" }));
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
  useCommandStore.setState({ syncNow: vi.fn(async () => true), requestSync: vi.fn() });
});

afterEach(() => {
  cleanup();
  useCommandStore.setState(realActions);
  vi.unstubAllGlobals();
});

describe("Habit reminder times (desktop)", () => {
  it("adds reminder times, kept in time order, asking for the permission the first time", async () => {
    await db.habits.put(habit());
    await openEdit();
    const input = await screen.findByLabelText("New reminder time for Read");
    fireEvent.change(input, { target: { value: "20:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    await waitFor(async () => expect((await db.habits.get("hab-1"))?.reminderTimes).toEqual(["20:00"]));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    await screen.findByRole("button", { name: "Remove reminder at 20:00" });
    expect(input).toHaveValue("");

    fireEvent.change(input, { target: { value: "07:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));
    await waitFor(async () =>
      expect((await db.habits.get("hab-1"))?.reminderTimes).toEqual(["07:30", "20:00"])
    );
    expect(await screen.findByLabelText("Reminders at 07:30, 20:00")).toBeInTheDocument();
  });

  it("removes one time, and the field when the last one goes", async () => {
    await db.habits.put(habit({ reminderTimes: ["07:30", "20:00"] }));
    await openEdit();
    fireEvent.click(await screen.findByRole("button", { name: "Remove reminder at 07:30" }));
    await waitFor(async () => expect((await db.habits.get("hab-1"))?.reminderTimes).toEqual(["20:00"]));
    fireEvent.click(await screen.findByRole("button", { name: "Remove reminder at 20:00" }));
    await waitFor(async () => expect(await db.habits.get("hab-1")).not.toHaveProperty("reminderTimes"));
  });

  it("keeps Add disabled until a time is chosen", async () => {
    await db.habits.put(habit());
    await openEdit();
    expect(await screen.findByRole("button", { name: "Add reminder" })).toBeDisabled();
  });

  it("says why no notification will come when they are blocked", async () => {
    permission = "denied";
    await db.habits.put(habit({ reminderTimes: ["20:00"] }));
    await openEdit();
    expect(await screen.findByText(/Notifications are blocked/)).toBeInTheDocument();
  });
});
