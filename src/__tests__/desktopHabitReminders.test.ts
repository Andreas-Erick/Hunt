// Desktop Habit reminders end to end in the browser: a Habit with a reminder time shows a Windows
// (Web) notification on an Open scheduled day, stays quiet once the day is Met, and a click
// opens Hunt on Habits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Habit } from "@/lib/domainTypes";
import { startDesktopReminders } from "@/lib/desktopReminders";
import { localStore } from "@/lib/localStore";
import { useCommandStore } from "@/store/useCommandStore";

const REMINDER_AT = new Date(2026, 10, 25, 9, 30).getTime();

interface Shown {
  title: string;
  options?: NotificationOptions;
  note: FakeNotification;
}

let shown: Shown[];
let stop: (() => void) | null = null;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => "granted" as NotificationPermission;
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    shown.push({ title, options, note: this });
  }
  close() {}
}

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: "hab-1",
    title: "Read",
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: new Date(2026, 10, 1).getTime(),
    reminderTimes: ["09:30"],
    ...overrides,
  };
}

async function waitPastReminder() {
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(REMINDER_AT));
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(REMINDER_AT - 2000);
  shown = [];
  vi.stubGlobal("Notification", FakeNotification);
  await db.tasks.clear();
  await db.habits.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("desktop Habit reminders", () => {
  it("shows a notification titled with the Habit at its reminder time", async () => {
    await db.habits.put(habit());
    stop = startDesktopReminders();
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].title).toBe("Read");
    expect(shown[0].options).toMatchObject({ body: "Habit reminder · 09:30", tag: "habit:hab-1:2026-11-25T09:30" });
  });

  it("stays quiet once today is Met", async () => {
    await db.habits.put(habit());
    stop = startDesktopReminders();
    const day = await localStore.ensureHabitTaskForDay("hab-1", "2026-11-25");
    await localStore.completeTask(day!.id);
    await waitPastReminder();
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toEqual([]);
  });

  it("picks up reminder times set on the Habit while running", async () => {
    await db.habits.put(habit({ reminderTimes: undefined }));
    stop = startDesktopReminders();
    await localStore.updateHabit("hab-1", { reminderTimes: ["09:30"] });
    expect((await db.habits.get("hab-1"))?.reminderTimes).toEqual(["09:30"]);
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });

  it("opens Habits when the notification is clicked", async () => {
    await db.habits.put(habit());
    useCommandStore.setState({ activeView: "command" });
    stop = startDesktopReminders();
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    vi.spyOn(window, "focus").mockImplementation(() => {});
    shown[0].note.onclick?.();
    expect(useCommandStore.getState().activeView).toBe("habits");
  });

  it("asks an Avoid Habit's check-in whether there was a Slip, and opens Habits when clicked", async () => {
    await db.habits.put(habit({ kind: "avoid", title: "No alcohol" }));
    useCommandStore.setState({ activeView: "command" });
    stop = startDesktopReminders();
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].options?.body).toBe("Check-in: did you slip? Log a Slip in Hunt · 09:30");
    vi.spyOn(window, "focus").mockImplementation(() => {});
    shown[0].note.onclick?.();
    expect(useCommandStore.getState().activeView).toBe("habits");
  });
});
