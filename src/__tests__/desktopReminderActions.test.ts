// Desktop notification actions (#32, ADR-0007): where the launcher's Chromium window has a service
// worker, a reminder's Windows notification offers Done (or +1) and Snooze 10 min. The worker hands
// the tapped action to the window, which applies it through the command store; Snooze is kept on
// this device and folded into the shared dueReminders rule. Without a service worker the plain
// notification stays (desktopReminders.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import type { Habit, Task } from "@/lib/domainTypes";
import { startDesktopReminders } from "@/lib/desktopReminders";
import { REMINDER_ACTION_MESSAGE, reminderNotificationActions, runReminderAction } from "@/lib/desktopReminderActions";
import { localStore } from "@/lib/localStore";
import { useCommandStore } from "@/store/useCommandStore";

const REMINDER_AT = new Date(2026, 10, 25, 9, 30).getTime();
const KEY = "task:tsk-1:2026-11-25T09:30";

interface Shown {
  title: string;
  options: NotificationOptions & { actions?: { action: string; title: string }[]; data?: unknown };
}

let shown: Shown[];
let stop: (() => void) | null = null;
let messages: EventTarget;

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = async () => "granted" as NotificationPermission;
  constructor() {
    throw new Error("the worker shows notifications when there is one");
  }
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

const noDeps = {
  completeTask: vi.fn(async () => undefined),
  ensureHabitDay: vi.fn(async () => undefined),
  addCount: vi.fn(async () => undefined),
};

/** What the worker posts to the window when a notification button is pressed. */
function press(action: string, index = shown.length - 1) {
  messages.dispatchEvent(new MessageEvent("message", { data: { type: REMINDER_ACTION_MESSAGE, action, data: shown[index].options.data } }));
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(REMINDER_AT - 2000);
  shown = [];
  messages = new EventTarget();
  const registration = { showNotification: async (title: string, options: Shown["options"]) => void shown.push({ title, options }) };
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      addEventListener: (type: string, fn: EventListener) => messages.addEventListener(type, fn),
      removeEventListener: (type: string, fn: EventListener) => messages.removeEventListener(type, fn),
    },
  });
  localStorage.clear();
  await db.tasks.clear();
  await db.habits.clear();
});

afterEach(() => {
  stop?.();
  stop = null;
  Reflect.deleteProperty(navigator, "serviceWorker");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function waitUntil(at: number) {
  await vi.advanceTimersByTimeAsync(at - Date.now() + 1000);
  await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(at));
}

describe("desktop notification actions", () => {
  it("offers Done and Snooze 10 min on a Task reminder; +1 on a Count Habit's; only Snooze without a tick", () => {
    expect(reminderNotificationActions({ tick: "done", taskId: "t" })).toEqual([
      { action: "tick", title: "Done" },
      { action: "snooze", title: "Snooze 10 min" },
    ]);
    expect(reminderNotificationActions({ tick: "+1", taskId: "t" })[0]).toEqual({ action: "tick", title: "+1" });
    expect(reminderNotificationActions(null)).toEqual([{ action: "snooze", title: "Snooze 10 min" }]);
  });

  it("Done completes the Task through the command store", async () => {
    await db.tasks.put(task());
    const completeTask = vi.fn(async (id: string) => void (await localStore.completeTask(id)));
    stop = startDesktopReminders({ ...noDeps, completeTask });
    await waitUntil(REMINDER_AT);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].title).toBe("Call the bank");
    expect(shown[0].options).toMatchObject({ tag: KEY, actions: reminderNotificationActions({ tick: "done", taskId: "tsk-1" }) });
    press("tick");
    await vi.waitFor(() => expect(completeTask).toHaveBeenCalledWith("tsk-1"));
    await vi.waitFor(async () => expect((await db.tasks.get("tsk-1"))?.status).toBe("completed"));
  });

  it("Snooze shows the reminder again 10 minutes later, and not once the Task is done meanwhile", async () => {
    await db.tasks.put(task());
    stop = startDesktopReminders(noDeps);
    await waitUntil(REMINDER_AT);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    press("snooze");
    const snoozedAt = Date.now();
    await waitUntil(snoozedAt + 10 * 60_000);
    await vi.waitFor(() => expect(shown).toHaveLength(2));
    expect(shown[1].title).toBe("Call the bank");
    expect(shown[1].options.tag).toBe(`${KEY}~${snoozedAt + 10 * 60_000}`);

    press("snooze", 1);
    await localStore.completeTask("tsk-1");
    await waitUntil(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown).toHaveLength(2);
  });

  it("a Habit reminder through the worker reads as one, offers its Done, and a plain click opens Habits", async () => {
    const check: Habit = { id: "hab-1", title: "Read", notes: "", questId: null, rank: 1000, createdAt: 10, reminderTimes: ["09:30"] };
    await db.habits.put(check);
    useCommandStore.setState({ activeView: "command" });
    stop = startDesktopReminders(noDeps);
    await waitUntil(REMINDER_AT);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0].options).toMatchObject({
      body: "Habit reminder · 09:30",
      actions: reminderNotificationActions({ tick: "done", taskId: "habtsk-2026-11-25-hab-1" }),
    });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    press("open");
    expect(useCommandStore.getState().activeView).toBe("habits");
  });

  it("routes a Habit reminder's Done to that day's habit Task and +1 to the Count rule", async () => {
    const deps = {
      completeTask: vi.fn(async () => undefined),
      ensureHabitDay: vi.fn(async (habitId: string, dateKey: string) => task({ id: `habtsk-${dateKey}-${habitId}`, habitId })),
      addCount: vi.fn(async () => undefined),
    };
    const habitReminder = { kind: "habit", itemId: "h1", dateKey: "2026-11-25" };
    await runReminderAction({ tick: "done", taskId: "habtsk-2026-11-25-h1" }, habitReminder, deps);
    expect(deps.ensureHabitDay).toHaveBeenCalledWith("h1", "2026-11-25");
    expect(deps.completeTask).toHaveBeenCalledWith("habtsk-2026-11-25-h1");
    await runReminderAction({ tick: "+1", taskId: "habtsk-2026-11-25-h1" }, habitReminder, deps);
    expect(deps.addCount).toHaveBeenCalledWith("h1", "2026-11-25");
    await runReminderAction({ tick: "done", taskId: "habtsk-2026-11-25-h1" }, habitReminder, {
      ...deps,
      ensureHabitDay: vi.fn(async () => task({ status: "completed" })),
      completeTask: vi.fn(async () => {
        throw new Error("an already-done day is not completed again");
      }),
    });
  });
});
