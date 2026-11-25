// An Avoid Habit is judged day by day, so it may ask for every day or chosen weekdays, never
// N times a week (GLOSSARY: Avoid Habit, Frequency). The picker leaves "Times a week" out, the
// store refuses it, and the sync boundary drops such a change from an Avoid row's history.
import React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { db } from "@/lib/db";
import type { Habit } from "@/lib/domainTypes";
import { isFrequencyAllowedFor } from "@/lib/habitFrequency";
import { localStore } from "@/lib/localStore";
import { sanitizeHabit } from "@/lib/syncTypes";
import { HabitFrequencyPicker } from "@/components/HabitFrequencyPicker";
import { HabitsView } from "@/components/HabitsView";

const DRY: Habit = { id: "hab-dry", title: "No alcohol", notes: "", questId: null, rank: 1000, createdAt: 1, kind: "avoid" };
const THREE_A_WEEK = { type: "perWeek", times: 3 } as const;

beforeEach(async () => {
  await Promise.all([db.tasks.clear(), db.habits.clear(), db.quests.clear()]);
});

describe("Avoid Habits never ask N times a week", () => {
  it("the shared rule allows every day and chosen weekdays for Avoid, and N per week for the other Kinds", () => {
    expect(isFrequencyAllowedFor({ kind: "avoid" }, THREE_A_WEEK)).toBe(false);
    expect(isFrequencyAllowedFor({ kind: "avoid" }, { type: "everyDay" })).toBe(true);
    expect(isFrequencyAllowedFor({ kind: "avoid" }, { type: "weekdays", weekdays: [1] })).toBe(true);
    expect(isFrequencyAllowedFor({ kind: "check" }, THREE_A_WEEK)).toBe(true);
    expect(isFrequencyAllowedFor({ kind: "count" }, THREE_A_WEEK)).toBe(true);
    expect(isFrequencyAllowedFor({}, THREE_A_WEEK)).toBe(true);
  });

  it("sync drops an N per week change from an Avoid row's history, keeping the change before it", () => {
    const history = [
      { effectiveFrom: "2026-05-01", frequency: { type: "weekdays", weekdays: [1, 3] } },
      { effectiveFrom: "2026-05-08", frequency: THREE_A_WEEK },
    ];
    expect(sanitizeHabit({ ...DRY, frequencyHistory: history })?.frequencyHistory).toEqual([history[0]]);
    expect(sanitizeHabit({ ...DRY, frequencyHistory: [history[1]] })?.frequencyHistory).toBeUndefined();
    expect(sanitizeHabit({ ...DRY, kind: "check", frequencyHistory: history })?.frequencyHistory).toEqual(history);
  });

  it("the store refuses to make or edit an Avoid Habit to N times a week", async () => {
    expect(await localStore.createHabit({ title: "No sugar", questId: null, kind: "avoid", frequency: THREE_A_WEEK })).toBe(false);
    expect(await db.habits.count()).toBe(0);
    await db.habits.put(DRY);
    expect(await localStore.updateHabit(DRY.id, { frequency: THREE_A_WEEK })).toBe(false);
    expect((await db.habits.get(DRY.id))?.frequencyHistory).toBeUndefined();
  });

  it("the picker leaves Times a week out when it is not allowed", () => {
    const { rerender } = render(<HabitFrequencyPicker label="Frequency" value={{ type: "everyDay" }} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Times a week" })).toBeInTheDocument();
    rerender(<HabitFrequencyPicker label="Frequency" value={{ type: "everyDay" }} onChange={() => {}} allowPerWeek={false} />);
    expect(screen.queryByRole("button", { name: "Times a week" })).toBeNull();
    expect(screen.getByRole("button", { name: "Chosen days" })).toBeInTheDocument();
  });

  it("choosing Avoid in the new-habit form hides Times a week and falls back to every day", async () => {
    render(<HabitsView />);
    await screen.findByText(/No habits yet/);
    const picker = screen.getByRole("group", { name: "Frequency for new habit" });
    fireEvent.click(within(picker).getByRole("button", { name: "Times a week" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Habit Kind" })).getByRole("radio", { name: "Avoid" }));
    expect(within(picker).queryByRole("button", { name: "Times a week" })).toBeNull();
    expect(within(picker).getByRole("button", { name: "Every day" })).toHaveAttribute("aria-pressed", "true");
  });
});
