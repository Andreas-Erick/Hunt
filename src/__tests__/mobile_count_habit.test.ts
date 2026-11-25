// @vitest-environment node
// Count Habits on the phone (GLOSSARY: Habit Kind, Count Habit), through the same shared rules as
// the desktop: the Kind is chosen when the Habit is made and shown read-only after; a tap on the
// +1 adds one, a long press types an exact total, and rows show "n / target unit".
import { afterEach, describe, expect, it } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

type Page = MobileWindow & {
  openNewHabitSheet(): void;
  saveNewHabit(): void;
  openHabitEditorSheet(id: string): void;
};

const JOG = {
  id: "hab-jog",
  title: "Jog",
  notes: "",
  questId: null,
  rank: 1000,
  createdAt: 1,
  updatedAt: 1,
  kind: "count",
  target: 3,
  unit: "miles",
};

let w: Page | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

function boot(habits: unknown[] = [JOG], tasks: unknown[] = []): Page {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks,
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

const todayRow = (p: Page) => {
  const id = `habtsk-${p.toLocalDateKey()}-${JOG.id}`;
  return readState(p).tasks.find((t) => t.id === id);
};
const main = (p: Page) => p.document.getElementById("mainContainer")!;
const plusButton = (p: Page) => main(p).querySelector('[aria-label="Add 1 to Jog"]');

describe("Count Habits on the phone", () => {
  it("chooses the Kind in the new-habit sheet: Check by default, Count with a target and unit", () => {
    const p = boot([]);
    p.switchView("habits");
    p.openNewHabitSheet();
    const doc = p.document;
    const check = doc.querySelector('[role="radio"][data-habit-kind="check"]');
    expect(check?.getAttribute("aria-checked")).toBe("true");
    click(p, doc.querySelector('[role="radio"][data-habit-kind="count"]'));
    (doc.getElementById("newHabitTitleInput") as HTMLInputElement).value = "Jog";
    (doc.getElementById("newHabitTargetInput") as HTMLInputElement).value = "3";
    (doc.getElementById("newHabitUnitInput") as HTMLInputElement).value = "miles";
    p.saveNewHabit();
    const [habit] = readState(p).habits as Record<string, unknown>[];
    expect(habit).toMatchObject({ title: "Jog", kind: "count", target: 3, unit: "miles" });
    expect(main(p).textContent).toContain("0 / 3 miles");
    expect(pageErrors(p)).toEqual([]);
  });

  it("refuses a Count Habit without a positive target", () => {
    const p = boot([]);
    p.openNewHabitSheet();
    const doc = p.document;
    click(p, doc.querySelector('[role="radio"][data-habit-kind="count"]'));
    (doc.getElementById("newHabitTitleInput") as HTMLInputElement).value = "Jog";
    (doc.getElementById("newHabitTargetInput") as HTMLInputElement).value = "0";
    p.saveNewHabit();
    expect(readState(p).habits).toEqual([]);
  });

  it("stores a new Check Habit as Check", () => {
    const p = boot([]);
    p.openNewHabitSheet();
    (p.document.getElementById("newHabitTitleInput") as HTMLInputElement).value = "Stretch";
    p.saveNewHabit();
    expect((readState(p).habits as Record<string, unknown>[])[0].kind).toBe("check");
  });

  it("+1 on the Habits card adds one; reaching the target makes today Met", () => {
    const p = boot();
    p.switchView("habits");
    click(p, plusButton(p));
    expect(todayRow(p)).toMatchObject({ amount: 1, status: "queued" });
    expect(main(p).textContent).toContain("1 / 3 miles");
    click(p, plusButton(p));
    click(p, plusButton(p));
    expect(todayRow(p)).toMatchObject({ amount: 3, status: "completed" });
    expect(main(p).textContent).toContain("1 / 1 done today");
    click(p, plusButton(p)); // going over is allowed and shown
    expect(main(p).textContent).toContain("4 / 3 miles");
    expect(pageErrors(p)).toEqual([]);
  });

  it("a long press (the context menu a held touch opens) types an exact total", () => {
    const p = boot();
    p.switchView("habits");
    plusButton(p)!.dispatchEvent(new p.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const input = p.document.getElementById("habitAmountInput") as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = "2.5";
    click(p, p.document.querySelector('[data-action="save-habit-amount"]'));
    expect(todayRow(p)).toMatchObject({ amount: 2.5, status: "queued" });
    expect(main(p).textContent).toContain("2.5 / 3 miles");
  });

  it("a press held on +1 opens exact entry and the click that ends it adds nothing", async () => {
    const p = boot();
    p.switchView("habits");
    const plus = plusButton(p)!;
    plus.dispatchEvent(new p.Event("pointerdown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 650));
    plus.dispatchEvent(new p.Event("pointerup", { bubbles: true }));
    click(p, plus);
    expect(p.document.getElementById("habitAmountInput")).not.toBeNull();
    expect(todayRow(p)?.amount ?? 0).toBe(0);
  });

  it("the Today row of a Count Habit shows its progress and taps +1", () => {
    const p = boot();
    p.switchView("command");
    expect(main(p).textContent).toContain("0 / 3 miles");
    click(p, plusButton(p));
    expect(todayRow(p)).toMatchObject({ amount: 1, status: "queued" });
    expect(main(p).textContent).toContain("1 / 3 miles");
  });

  it("completing a Count Habit's day Task from anywhere counts +1 rather than ticking it", () => {
    const p = boot();
    const id = `habtsk-${p.toLocalDateKey()}-${JOG.id}`;
    p.completeTaskDirect(id);
    expect(todayRow(p)).toMatchObject({ amount: 1, status: "queued" });
  });

  it("shows the Kind read-only in the habit editor", () => {
    const p = boot();
    p.openHabitEditorSheet(JOG.id);
    const sheet = p.document.body.textContent ?? "";
    expect(sheet).toContain("Count Habit");
    expect(p.document.querySelector('[role="radio"][data-habit-kind]')).toBeNull();
  });
});
