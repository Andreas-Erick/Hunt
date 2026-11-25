// A click on a desktop Task reminder (US 74) brings Hunt forward on Today with that Task's row
// open (its drawer), even when another view was showing.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { db } from "@/lib/db";
import type { Task } from "@/lib/domainTypes";
import { startDesktopReminders } from "@/lib/desktopReminders";
import { useCommandStore } from "@/store/useCommandStore";
import { CommandCenterView } from "@/components/CommandCenterView";

const REMINDER_AT = new Date(2026, 10, 25, 9, 30).getTime();

let shown: FakeNotification[];
let stop: (() => void) | null = null;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => "granted" as NotificationPermission;
  onclick: (() => void) | null = null;
  constructor(public title: string) {
    shown.push(this);
  }
  close() {}
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1",
    title: "Call the bank",
    notes: "",
    questId: "quest-1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: "2026-11-25",
    reminderTime: "09:30",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(REMINDER_AT - 2000);
  shown = [];
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(window, "focus").mockImplementation(() => {});
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
});

afterEach(() => {
  stop?.();
  stop = null;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("desktop Task reminder click", () => {
  it("opens Today with the Task's drawer open", async () => {
    await db.tasks.put(task());
    useCommandStore.setState({ activeView: "plan" });
    stop = startDesktopReminders();
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(() => expect(shown).toHaveLength(1));

    shown[0].onclick?.();
    expect(useCommandStore.getState().activeView).toBe("command");
    render(<CommandCenterView />);
    expect(await screen.findByLabelText("Notes for Call the bank")).toBeInTheDocument();
  });
});
