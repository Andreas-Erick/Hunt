// @vitest-environment node
// Avoid Habits on the phone (GLOSSARY: Avoid Habit, Slip), through the same shared rules as the
// desktop: Avoid is chosen when the Habit is made; its rows read "Kept so far" until a Slip is
// logged from a labelled button, and a Slip can be undone.
import { afterEach, describe, expect, it } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

type Page = MobileWindow & {
  openNewHabitSheet(): void;
  saveNewHabit(): void;
  openHabitEditorSheet(id: string): void;
  reopenTaskDirect(id: string): void;
};

const DRY = {
  id: "hab-dry",
  title: "No alcohol",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1,
  updatedAt: 1,
  kind: "avoid",
};

let w: Page | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

function boot(habits: unknown[] = [DRY]): Page {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks: [],
      habits,
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 0,
    },
  }) as Page;
  return w;
}

const todayId = (p: Page) => `habtsk-${p.toLocalDateKey()}-${DRY.id}`;
const todayRow = (p: Page) => readState(p).tasks.find((t) => t.id === todayId(p));
const main = (p: Page) => p.document.getElementById("mainContainer")!;
const button = (p: Page, label: string) => main(p).querySelector(`[aria-label="${label}"]`);

describe("Avoid Habits on the phone", () => {
  it("offers Avoid in the new-habit sheet", () => {
    const p = boot([]);
    p.switchView("habits");
    p.openNewHabitSheet();
    click(p, p.document.querySelector('[role="radio"][data-habit-kind="avoid"]'));
    (p.document.getElementById("newHabitTitleInput") as HTMLInputElement).value = "No alcohol";
    p.saveNewHabit();
    const [habit] = readState(p).habits as Record<string, unknown>[];
    expect(habit).toMatchObject({ title: "No alcohol", kind: "avoid" });
    expect(main(p).textContent).toContain("Kept so far");
    expect(pageErrors(p)).toEqual([]);
  });

  it("logs a Slip on the Habits card, which makes today Missed, and undoes it", () => {
    const p = boot();
    p.switchView("habits");
    expect(main(p).textContent).toContain("Kept so far");
    click(p, button(p, "Log a Slip on No alcohol"));
    expect(todayRow(p)).toMatchObject({ slips: 1, status: "queued" });
    expect(main(p).textContent).toContain("1 Slip");
    click(p, button(p, "Undo Slip on No alcohol"));
    expect(todayRow(p)?.slips).toBeUndefined();
    expect(main(p).textContent).toContain("Kept so far");
    expect(pageErrors(p)).toEqual([]);
  });

  it("the Today row reads Kept so far, with a labelled Slip button instead of a tick", () => {
    const p = boot();
    p.switchView("command");
    expect(main(p).textContent).toContain("Kept so far");
    expect(button(p, "Complete No alcohol")).toBeNull();
    click(p, button(p, "Log a Slip on No alcohol"));
    expect(todayRow(p)).toMatchObject({ slips: 1 });
    expect(main(p).textContent).not.toContain("Kept so far"); // a slipped day is no longer open work
  });

  it("as Today's Next up card, an Avoid day has its labelled Slip button instead of a tick", () => {
    const quest = { id: "qst-calm", slotIndex: 0, code: "Q-1", title: "Stay calm", description: "", accentColor: "cyan", targetWeeklyHours: 1, archived: false, createdAt: 1 };
    w = loadMobile({
      seedState: { quests: [quest], tasks: [], habits: [{ ...DRY, questId: quest.id }], timeLogs: [], deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 }, lastSyncedAt: 0 },
    }) as Page;
    const p = w;
    p.switchView("command");
    expect(main(p).querySelector(".spotlight-card")?.textContent).toContain("No alcohol");
    expect(button(p, "Complete No alcohol")).toBeNull();
    click(p, button(p, "Log a Slip on No alcohol"));
    expect(todayRow(p)).toMatchObject({ slips: 1, status: "queued" });
    expect(pageErrors(p)).toEqual([]);
  });

  it("completing an Avoid day from anywhere logs a Slip; reopening it clears its Slips", () => {
    const p = boot();
    p.completeTaskDirect(todayId(p));
    expect(todayRow(p)).toMatchObject({ slips: 1, status: "queued" });
    p.reopenTaskDirect(todayId(p));
    expect(todayRow(p)?.slips).toBeUndefined();
  });

  it("shows the Kind read-only in the habit editor", () => {
    const p = boot();
    p.openHabitEditorSheet(DRY.id);
    expect(p.document.body.textContent ?? "").toContain("Avoid Habit");
  });

  it("never offers Times a week for an Avoid Habit, so it stays judged day by day", () => {
    const p = boot([]);
    const picker = () => p.document.getElementById("habitFrequencyPicker")!;
    const timesAWeek = () => picker().querySelector('[aria-label="Times a week"]') as HTMLElement | null;
    p.openNewHabitSheet();
    click(p, timesAWeek());
    click(p, p.document.querySelector('[role="radio"][data-habit-kind="avoid"]'));
    expect(timesAWeek()).toBeNull();
    expect(picker().querySelector('[aria-label="Every day"]')?.getAttribute("aria-pressed")).toBe("true");
    (p.document.getElementById("newHabitTitleInput") as HTMLInputElement).value = "No alcohol";
    p.saveNewHabit();
    const [habit] = readState(p).habits as Record<string, unknown>[];
    expect(habit.frequencyHistory).toBeUndefined();

    p.openHabitEditorSheet(habit.id as string);
    expect(timesAWeek()).toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });
});
