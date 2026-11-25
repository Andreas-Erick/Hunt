// @vitest-environment node
// Due reminders (shared core): which reminders fall in a time window. Both apps plan their
// notifications from this one function, so these cases cover the desktop and the phone.
import { describe, expect, it } from "vitest";
import { dueReminders, isReminderTime } from "@/mobile/huntCore";
import type { Task } from "@/lib/domainTypes";

const DAY = "2026-11-25";
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
    scheduledDate: DAY,
    reminderTime: "09:30",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

describe("dueReminders", () => {
  it("returns a dated Task's reminder when its local time falls in the window", () => {
    const due = dueReminders({ tasks: [task()] }, { from: at(9), to: at(10) });
    expect(due).toEqual([
      {
        kind: "task",
        key: "task:tsk-1:2026-11-25T09:30",
        itemId: "tsk-1",
        title: "Call the bank",
        dateKey: DAY,
        time: "09:30",
        fireAt: at(9, 30),
      },
    ]);
  });

  it("treats the window as [from, to): a reminder exactly at `to` is left for the next window", () => {
    expect(dueReminders({ tasks: [task()] }, { from: at(9, 30), to: at(9, 31) })).toHaveLength(1);
    expect(dueReminders({ tasks: [task()] }, { from: at(9), to: at(9, 30) })).toEqual([]);
  });

  it("stays quiet for a Task that is done or archived", () => {
    const tasks = [
      task({ id: "done", status: "completed", completedAt: at(8) }),
      task({ id: "gone", status: "archived" }),
      task({ id: "open" }),
      task({ id: "focus", status: "active" }),
    ];
    const due = dueReminders({ tasks }, { from: at(0), to: at(23) });
    expect(due.map((r) => r.itemId)).toEqual(["focus", "open"]);
  });

  it("ignores Tasks with no date, no reminder time or a malformed one", () => {
    const tasks = [
      task({ id: "undated", scheduledDate: undefined }),
      task({ id: "date-only", reminderTime: undefined }),
      task({ id: "bad", reminderTime: "9:30" }),
      task({ id: "bad-date", scheduledDate: "tomorrow" }),
    ];
    expect(dueReminders({ tasks }, { from: at(0), to: at(23) })).toEqual([]);
  });

  it("reaches across days and sorts by fire time, then id", () => {
    const tasks = [
      task({ id: "b", scheduledDate: "2026-11-26", reminderTime: "08:00" }),
      task({ id: "z", reminderTime: "21:00" }),
      task({ id: "a", reminderTime: "21:00" }),
      task({ id: "later", scheduledDate: "2026-11-27", reminderTime: "08:00" }),
    ];
    const due = dueReminders({ tasks }, { from: at(20), to: at(20, 0, 26) });
    expect(due.map((r) => `${r.itemId}@${r.time}`)).toEqual(["a@21:00", "z@21:00", "b@08:00"]);
    expect(due[2].fireAt).toBe(at(8, 0, 26));
  });
});

describe("isReminderTime", () => {
  it("accepts a local 24-hour HH:MM and nothing else", () => {
    for (const ok of ["00:00", "09:05", "23:59"]) expect(isReminderTime(ok), ok).toBe(true);
    for (const bad of ["24:00", "9:30", "09:60", "09:30:00", "", " 09:30", 930, null, undefined]) {
      expect(isReminderTime(bad), String(bad)).toBe(false);
    }
  });
});
