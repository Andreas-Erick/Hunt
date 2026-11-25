// @vitest-environment node
// Snooze 10 min (#32, ADR-0007): a snoozed reminder fires again 10 minutes after the tap, and is
// folded into the shared dueReminders rule, so it stays quiet when its item was finished meanwhile.
import { describe, expect, it } from "vitest";
import { dueReminders } from "@/mobile/huntCore";
import { REMINDER_SNOOZE_MS, sanitizeReminderSnoozes, snoozeReminder } from "@/lib/reminderSnooze";
import type { Task } from "@/lib/domainTypes";

const at = (hour: number, minute = 0) => new Date(2026, 10, 25, hour, minute).getTime();
const KEY = "task:t1:2026-11-25T09:00";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Call the bank",
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: "2026-11-25",
    reminderTime: "09:00",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

const original = () => dueReminders({ tasks: [task()] }, { from: at(9), to: at(9) + 1 })[0];

describe("Snooze 10 min", () => {
  it("snoozes for 10 minutes from the tap", () => {
    expect(REMINDER_SNOOZE_MS).toBe(10 * 60_000);
    expect(snoozeReminder(original(), at(9, 2))).toEqual({ key: KEY, fireAt: at(9), until: at(9, 12) });
  });

  it("fires again at the snooze's end, as its own reminder that names the one it snoozes", () => {
    const snoozes = [snoozeReminder(original(), at(9, 2))];
    const due = dueReminders({ tasks: [task()], snoozes }, { from: at(9, 5), to: at(10) });
    expect(due).toEqual([
      {
        kind: "task",
        key: `${KEY}~${at(9, 12)}`,
        itemId: "t1",
        title: "Call the bank",
        dateKey: "2026-11-25",
        time: "09:00",
        fireAt: at(9, 12),
        snoozeOf: { key: KEY, fireAt: at(9) },
      },
    ]);
  });

  it("stays quiet when the item was finished meanwhile, here or synced from the other device", () => {
    const snoozes = [snoozeReminder(original(), at(9, 2))];
    expect(dueReminders({ tasks: [task({ status: "completed" })], snoozes }, { from: at(9, 5), to: at(10) })).toEqual([]);
    expect(dueReminders({ tasks: [task({ reminderTime: "10:30" })], snoozes }, { from: at(9, 5), to: at(10) })).toEqual([]);
  });

  it("snoozing a snoozed reminder again moves the same snooze, from the original reminder", () => {
    const first = snoozeReminder(original(), at(9, 2));
    const [again] = dueReminders({ tasks: [task()], snoozes: [first] }, { from: at(9, 12), to: at(9, 12) + 1 });
    expect(snoozeReminder(again, at(9, 13))).toEqual({ key: KEY, fireAt: at(9), until: at(9, 23) });
  });

  it("only counts a snooze whose end falls in the window", () => {
    const snoozes = [snoozeReminder(original(), at(9, 2))];
    expect(dueReminders({ tasks: [task()], snoozes }, { from: at(9, 13), to: at(10) })).toEqual([]);
  });

  it("treats the window as [from, to): a snooze ending exactly at `to` waits for the next window", () => {
    const snoozes = [snoozeReminder(original(), at(9, 2))]; // ends 09:12
    expect(dueReminders({ tasks: [task()], snoozes }, { from: at(9, 5), to: at(9, 12) })).toEqual([]);
    expect(dueReminders({ tasks: [task()], snoozes }, { from: at(9, 12), to: at(9, 20) })).toHaveLength(1);
  });

  it("reads stored snoozes defensively: malformed ones are dropped, and one snooze per reminder (the latest) is kept", () => {
    const raw = [
      { key: KEY, fireAt: at(9), until: at(9, 12) },
      { key: KEY, fireAt: at(9), until: at(9, 20) },
      { key: "", fireAt: at(9), until: at(9, 12) },
      { key: "k", fireAt: "soon", until: at(9, 12) },
      7,
    ];
    expect(sanitizeReminderSnoozes(raw)).toEqual([{ key: KEY, fireAt: at(9), until: at(9, 20) }]);
    expect(sanitizeReminderSnoozes("nope")).toEqual([]);
  });
});
