// @vitest-environment node
// The desktop's reminder alarm: while the launcher runs it fires each due Task reminder once, at its
// time, from the shared dueReminders rule, and re-reads the Tasks first, so a Task finished here or
// on the phone (after a sync) stays quiet.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/domainTypes";
import type { DueReminder } from "@/lib/reminders";
import { startReminderAlarm, REMINDER_LATE_LIMIT_MS } from "@/lib/reminderAlarm";

const at = (hour: number, minute = 0, day = 25) => new Date(2026, 10, day, hour, minute).getTime();

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

let tasks: Task[];
let fired: DueReminder[];
let stop: (() => void) | null;

function start() {
  const alarm = startReminderAlarm({
    readSources: async () => ({ tasks }),
    notify: (r) => fired.push(r),
  });
  stop = alarm.stop;
  return alarm;
}

/** Lets the alarm's awaited reads settle at the current fake time. */
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(9));
  tasks = [task()];
  fired = [];
  stop = null;
});

afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe("startReminderAlarm", () => {
  it("notifies once at the reminder time, not before", async () => {
    start();
    await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired.map((r) => r.key)).toEqual(["task:tsk-1:2026-11-25T09:30"]);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it("stays quiet when the Task was done by the time the reminder is due (e.g. on the phone, then synced)", async () => {
    start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    tasks = [task({ status: "completed", completedAt: at(9, 10) })];
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toEqual([]);
  });

  it("re-plans on replan(): a reminder set or moved while running fires at its new time", async () => {
    tasks = [];
    const alarm = start();
    await settle();
    vi.setSystemTime(at(9, 0));
    tasks = [task({ reminderTime: "09:05" })];
    alarm.replan();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fired.map((r) => r.time)).toEqual(["09:05"]);
  });

  it("never fires reminders from before it started", async () => {
    vi.setSystemTime(at(10));
    start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toEqual([]);
  });

  it("fires a reminder it woke up late for only within the late limit (a PC back from sleep)", async () => {
    tasks = [task({ reminderTime: "09:30" }), task({ id: "tsk-2", reminderTime: "09:50" })];
    const alarm = start();
    await settle();
    // Sleep: no timer runs, the clock jumps past both reminders.
    vi.setSystemTime(at(9, 50) + REMINDER_LATE_LIMIT_MS - 1);
    alarm.replan();
    await settle();
    expect(fired.map((r) => r.itemId)).toEqual(["tsk-2"]);
  });

  it("stops: no notification after stop()", async () => {
    const alarm = start();
    await settle();
    alarm.stop();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toEqual([]);
  });

  it("keeps running when a read fails, and fires on the next successful one", async () => {
    let failing = true;
    const alarm = startReminderAlarm({
      readSources: async () => {
        if (failing) throw new Error("idb closed");
        return { tasks };
      },
      notify: (r) => fired.push(r),
      onError: () => {},
    });
    stop = alarm.stop;
    await settle();
    failing = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fired).toHaveLength(1);
  });
});
