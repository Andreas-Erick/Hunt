// Phone: a Task's Checklist is edited inside Task Options with the shared rule, and the Task rows
// show its n/m progress.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
let w: MobileWindow | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function localKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

type Item = { id: string; text: string; done: boolean };
const item = (id: string, text: string, done = false): Item => ({ id, text, done });

function task(id: string, title: string, rank: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    notes: "",
    status: "queued",
    rank,
    questId: "quest-1",
    accumulatedSeconds: 0,
    scheduledDate: localKey(NOW),
    updatedAt: 1,
    ...extra,
  };
}

function load(tasks: unknown[]): MobileWindow {
  w = loadMobile({
    seedState: {
      quests: [{ id: "quest-1", slotIndex: 0, title: "Launch", description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1 }],
      tasks,
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
    },
  });
  return w;
}

const PACK = "tsk-pack";
const checklistOf = (p: MobileWindow, id = PACK) =>
  (readState(p).tasks.find((t) => t.id === id) as { checklist?: Item[] } | undefined)?.checklist;
const sheet = (p: MobileWindow) => p.document.getElementById("sheetContainer") as HTMLElement;

function typeAndSubmit(p: MobileWindow, input: Element | null, value: string): void {
  if (!(input instanceof p.HTMLInputElement)) throw new Error("input missing");
  input.value = value;
  input.dispatchEvent(new p.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function rename(p: MobileWindow, input: Element | null, value: string): void {
  if (!(input instanceof p.HTMLInputElement)) throw new Error("input missing");
  input.value = value;
  input.dispatchEvent(new p.Event("change", { bubbles: true }));
}

describe("the phone's Checklist", () => {
  it("shows n/m progress on the Task rows that have a Checklist", () => {
    const p = load([
      task("tsk-hero", "Hero", 1000, { checklist: [item("chk-1", "a", true), item("chk-2", "b")] }),
      task(PACK, "Pack for the trip", 2000, { checklist: [item("chk-1", "a"), item("chk-2", "b"), item("chk-3", "c")] }),
      task("tsk-plain", "Plain", 3000),
    ]);
    const labels = Array.from(p.document.querySelectorAll("[aria-label^='Checklist: ']")).map((el) => [
      el.getAttribute("aria-label"),
      el.textContent?.trim(),
    ]);
    expect(labels).toEqual([
      ["Checklist: 1 of 2 done", "1/2"],
      ["Checklist: 0 of 3 done", "0/3"],
    ]);
    expect(pageErrors(p)).toEqual([]);
  });

  it("adds, ticks, renames, reorders and deletes items in Task Options", () => {
    const p = load([task("tsk-hero", "Hero", 1000), task(PACK, "Pack for the trip", 2000)]);
    p.openTaskInspectorSheet(PACK);
    const q = (selector: string) => sheet(p).querySelector(selector);

    typeAndSubmit(p, q("[aria-label='New checklist item']"), "Passport");
    typeAndSubmit(p, q("[aria-label='New checklist item']"), "  Charger ");
    expect(checklistOf(p)?.map((i) => i.text)).toEqual(["Passport", "Charger"]);

    click(p, q("[role='checkbox'][aria-label='Passport']"));
    expect(checklistOf(p)?.map((i) => i.done)).toEqual([true, false]);
    expect(q("[role='checkbox'][aria-label='Passport']")?.getAttribute("aria-checked")).toBe("true");

    rename(p, q("[aria-label='Rename Charger']"), "USB-C charger");
    expect(checklistOf(p)?.[1].text).toBe("USB-C charger");

    click(p, q("[aria-label='Move USB-C charger up']"));
    expect(checklistOf(p)?.map((i) => i.text)).toEqual(["USB-C charger", "Passport"]);

    click(p, q("[aria-label='Delete Passport']"));
    expect(checklistOf(p)?.map((i) => i.text)).toEqual(["USB-C charger"]);

    click(p, q("[role='checkbox'][aria-label='USB-C charger']"));
    const row = readState(p).tasks.find((t) => t.id === PACK) as { status?: string; updatedAt?: number };
    expect(row.status).toBe("queued");
    expect(row.updatedAt).toBeGreaterThan(1);
    expect(pageErrors(p)).toEqual([]);
  });

  it("offers no Checklist in a habit day Task's options", () => {
    const habitDay = task("habtsk-x", "Stretch", 1000, { habitId: "hab-1" });
    const p = load([habitDay]);
    p.openTaskInspectorSheet("habtsk-x");
    expect(sheet(p).querySelector("[aria-label='New checklist item']")).toBeNull();
  });
});
