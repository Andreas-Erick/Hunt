// Desktop Task reminders end to end in the browser: a Task saved with a reminder time shows a
// Windows (Web) notification at that time; a Task completed first stays quiet; a device without the
// Notification API (a tablet on the plain-http LAN URL) never tries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Task } from "@/lib/domainTypes";
import { ensureNotificationAccess, notificationAccess, startDesktopReminders } from "@/lib/desktopReminders";
import { localStore } from "@/lib/localStore";

const REMINDER_AT = new Date(2026, 10, 25, 9, 30).getTime();

interface Shown {
  title: string;
  options?: NotificationOptions;
}

let shown: Shown[];
let permission: NotificationPermission;
let stop: (() => void) | null = null;

class FakeNotification {
  static get permission() {
    return permission;
  }
  static requestPermission = vi.fn(async () => {
    permission = "granted";
    return permission;
  });
  onclick: (() => void) | null = null;
  constructor(title: string, options?: NotificationOptions) {
    shown.push({ title, options });
  }
  close() {}
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1",
    title: "Call the bank",
    notes: "",
    questId: null,
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

/** Real time keeps running (Dexie needs it); the clock starts 2 s before the reminder. */
async function waitPastReminder() {
  await vi.advanceTimersByTimeAsync(3000);
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(REMINDER_AT));
}

beforeEach(async () => {
  // IndexedDB (fake-indexeddb) schedules on setImmediate, so only the timers the alarm uses are faked.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(REMINDER_AT - 2000);
  shown = [];
  permission = "granted";
  FakeNotification.requestPermission.mockClear();
  vi.stubGlobal("Notification", FakeNotification);
  await db.tasks.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("desktop Task reminders", () => {
  it("shows a notification titled with the Task at its reminder time", async () => {
    await db.tasks.put(task());
    stop = startDesktopReminders();
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].title).toBe("Call the bank");
    expect(shown[0].options).toMatchObject({ body: "Reminder · 09:30", tag: "task:tsk-1:2026-11-25T09:30" });
  });

  it("stays quiet when the Task is completed before its reminder time", async () => {
    await db.tasks.put(task());
    stop = startDesktopReminders();
    await localStore.completeTask("tsk-1");
    await waitPastReminder();
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toEqual([]);
  });

  it("picks up a reminder set while running (each save re-plans)", async () => {
    await db.tasks.put(task({ reminderTime: undefined }));
    stop = startDesktopReminders();
    await localStore.updateTask("tsk-1", { reminderTime: "09:30" });
    await waitPastReminder();
    await vi.waitFor(() => expect(shown).toHaveLength(1));
  });

  it("shows nothing without the permission, and asks for it only while it was never asked", async () => {
    permission = "denied";
    await db.tasks.put(task());
    stop = startDesktopReminders();
    await waitPastReminder();
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toEqual([]);
    expect(await ensureNotificationAccess()).toBe("denied");
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();

    permission = "default";
    expect(await ensureNotificationAccess()).toBe("granted");
    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("is unsupported (and starts nothing) where the Notification API is missing", () => {
    vi.stubGlobal("Notification", undefined);
    expect(notificationAccess()).toBe("unsupported");
    expect(() => startDesktopReminders()()).not.toThrow();
  });
});
