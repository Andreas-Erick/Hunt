// @vitest-environment node
// Habit reminder times cross the sync boundary as well-formed "HH:MM" lists, so a bad row from
// the other device can never plan a reminder at a nonsense time.
import { describe, expect, it } from "vitest";
import { createEmptySyncPayload, validateSyncPayload } from "@/lib/syncTypes";
import { MAX_HABIT_REMINDER_TIMES } from "@/lib/reminderTime";

const habitRow = (overrides: Record<string, unknown> = {}) => ({
  id: "hab-1763400000000-a1b2",
  title: "Read",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

function syncedHabit(raw: Record<string, unknown>) {
  const check = validateSyncPayload({ ...createEmptySyncPayload(), habits: [raw] });
  if (!check.valid || !check.payload) throw new Error(`unexpectedly rejected: ${check.error}`);
  return check.payload.habits?.[0];
}

describe("Habit reminder times at the sync boundary", () => {
  it("keeps valid times, ascending and without repeats", () => {
    expect(syncedHabit(habitRow({ reminderTimes: ["20:00", "07:30", "20:00"] }))?.reminderTimes).toEqual([
      "07:30",
      "20:00",
    ]);
  });

  it("drops malformed times, and the field when none is left", () => {
    expect(syncedHabit(habitRow({ reminderTimes: ["8pm", "24:00", 7, "09:05"] }))?.reminderTimes).toEqual([
      "09:05",
    ]);
    expect(syncedHabit(habitRow({ reminderTimes: ["nope"] }))).not.toHaveProperty("reminderTimes");
    expect(syncedHabit(habitRow({ reminderTimes: "20:00" }))).not.toHaveProperty("reminderTimes");
    expect(syncedHabit(habitRow())).not.toHaveProperty("reminderTimes");
  });

  it("keeps at most MAX_HABIT_REMINDER_TIMES (the earliest)", () => {
    const times = Array.from({ length: 10 }, (_, i) => `${String(10 + i)}:00`);
    expect(syncedHabit(habitRow({ reminderTimes: times }))?.reminderTimes).toEqual(
      times.slice(0, MAX_HABIT_REMINDER_TIMES)
    );
  });
});
