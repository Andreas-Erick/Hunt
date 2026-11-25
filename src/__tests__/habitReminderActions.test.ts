// @vitest-environment node
// Notification actions on Habit reminders (#31 + #32, ADR-0007): a Habit reminder's Reminder Plan
// entry carries the action its Kind picks (+1 for Count, Done for Check, none for an Avoid
// check-in), aimed at that day's habit Task, and the Pending Tick it writes ticks or counts that
// day once through HuntCore's applyPendingTicks.
import { describe, expect, it } from "vitest";
import { applyPendingTicks, reminderPlan } from "@/mobile/huntCore";
import { reminderActionTick } from "@/lib/reminderActions";
import type { Habit, Task } from "@/lib/domainTypes";
import type { SyncPayload } from "@/lib/syncTypes";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const DAY = "2026-11-25";
const NOW = at(25, 9);
const TAP = at(25, 20, 1);

function habit(id: string, overrides: Partial<Habit> = {}): Habit {
  return { id, title: `Habit ${id}`, notes: "", questId: null, rank: 1000, createdAt: at(1, 8), reminderTimes: ["20:00"], ...overrides };
}

const state = (tasks: Task[], habits: Habit[]): SyncPayload =>
  ({ tasks, habits, quests: [], timeLogs: [], activeFocus: null } as unknown as SyncPayload);

/** The plan's first entry for `habitId` on DAY. */
function entryFor(habits: Habit[], habitId: string) {
  const entry = reminderPlan({ tasks: [], habits }, NOW).reminders.find((r) => r.itemId === habitId && r.dateKey === DAY);
  expect(entry, `a plan entry for ${habitId}`).toBeDefined();
  return entry!;
}

describe("Reminder Plan entries for Habit reminders", () => {
  it("a Count Habit's entry carries +1 on that day's habit Task", () => {
    const count = habit("run", { kind: "count", target: 3, unit: "miles" });
    expect(entryFor([count], "run")).toMatchObject({ kind: "habit", action: { tick: "+1", taskId: `habtsk-${DAY}-run` } });
  });

  it("a Check Habit's entry carries Done on that day's habit Task", () => {
    expect(entryFor([habit("read")], "read")).toMatchObject({ kind: "habit", action: { tick: "done", taskId: `habtsk-${DAY}-read` } });
  });

  it("an Avoid Habit's check-in carries no Done (Snooze only)", () => {
    const entry = entryFor([habit("sugar", { kind: "avoid", reminderTimes: ["21:00"] })], "sugar");
    expect(entry.kind).toBe("habit");
    expect(entry.action).toBeUndefined();
  });
});

describe("a Habit reminder's action, applied through applyPendingTicks", () => {
  it("Done ticks the Check Habit's day Task once, making it when Hunt has not yet", () => {
    const check = habit("read");
    const entry = entryFor([check], "read");
    const tick = reminderActionTick(entry.action!, entry.dateKey, TAP);
    const once = applyPendingTicks(state([], [check]), [tick]);
    expect(once.skipped).toEqual([]);
    const day = once.state.tasks.filter((t) => t.id === `habtsk-${DAY}-read`);
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({ habitId: "read", status: "completed" });
    const twice = applyPendingTicks(once.state, [tick, tick]);
    expect(twice.state.tasks.filter((t) => t.id === `habtsk-${DAY}-read`)).toEqual(day);
    expect(twice.skipped.length).toBe(2);
  });

  it("+1 adds one to the Count Habit's day once, however often the same tap is read", () => {
    const count = habit("run", { kind: "count", target: 3, unit: "miles" });
    const entry = entryFor([count], "run");
    const tick = reminderActionTick(entry.action!, entry.dateKey, TAP);
    const once = applyPendingTicks(state([], [count]), [tick, tick]);
    const days = once.state.tasks.filter((t) => t.id === `habtsk-${DAY}-run`);
    expect(days).toHaveLength(1);
    expect(days[0].amount).toBe(1);
    const again = applyPendingTicks(once.state, [tick]);
    expect(again.state.tasks.find((t) => t.id === `habtsk-${DAY}-run`)?.amount).toBe(1);
  });
});
