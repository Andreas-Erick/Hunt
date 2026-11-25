// Checklist rules (shared core, so the desktop and the phone edit a Task's Checklist the same way).
import { describe, expect, it } from "vitest";
import { applyChecklistEdit, canHoldChecklist, checklistProgress } from "@/lib/checklist";
import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT_LENGTH } from "@/lib/syncTypes";
import type { Task } from "@/lib/domainTypes";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1763400000000-abcd",
    title: "Pack for the trip",
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const item = (id: string, text: string, done = false) => ({ id, text, done });

describe("editing a Task's Checklist", () => {
  it("adds items at the end and shows progress as done of total", () => {
    let t = task();
    expect(checklistProgress(t)).toBeNull();
    t = { ...t, checklist: applyChecklistEdit(t, { kind: "add", id: "chk-1", text: "Passport" }) ?? undefined };
    t = { ...t, checklist: applyChecklistEdit(t, { kind: "add", id: "chk-2", text: "  Charger  " }) ?? undefined };
    expect(t.checklist).toEqual([item("chk-1", "Passport"), item("chk-2", "Charger")]);
    expect(checklistProgress(t)).toEqual({ done: 0, total: 2 });
  });

  const packed = () =>
    task({ checklist: [item("chk-1", "Passport"), item("chk-2", "Charger"), item("chk-3", "Socks")] });

  it("ticks and unticks one item", () => {
    const ticked = applyChecklistEdit(packed(), { kind: "toggle", id: "chk-2" });
    expect(ticked).toEqual([item("chk-1", "Passport"), item("chk-2", "Charger", true), item("chk-3", "Socks")]);
    expect(checklistProgress(task({ checklist: ticked ?? [] }))).toEqual({ done: 1, total: 3 });
    expect(applyChecklistEdit(task({ checklist: ticked ?? [] }), { kind: "toggle", id: "chk-2" })).toEqual(
      packed().checklist
    );
  });

  it("renames an item, refusing blank text and no-op renames", () => {
    expect(applyChecklistEdit(packed(), { kind: "rename", id: "chk-3", text: " Wool socks " })?.[2]).toEqual(
      item("chk-3", "Wool socks")
    );
    expect(applyChecklistEdit(packed(), { kind: "rename", id: "chk-3", text: "   " })).toBeNull();
    expect(applyChecklistEdit(packed(), { kind: "rename", id: "chk-3", text: "Socks" })).toBeNull();
  });

  it("reorders an item, clamping the target into the list", () => {
    const ids = (list: ReturnType<typeof applyChecklistEdit>) => list?.map((i) => i.id);
    expect(ids(applyChecklistEdit(packed(), { kind: "move", id: "chk-3", toIndex: 0 }))).toEqual(["chk-3", "chk-1", "chk-2"]);
    expect(ids(applyChecklistEdit(packed(), { kind: "move", id: "chk-1", toIndex: 99 }))).toEqual(["chk-2", "chk-3", "chk-1"]);
    expect(applyChecklistEdit(packed(), { kind: "move", id: "chk-1", toIndex: -5 })).toBeNull();
  });

  it("deletes an item; the last one leaves no progress to show", () => {
    expect(applyChecklistEdit(packed(), { kind: "remove", id: "chk-1" })?.map((i) => i.id)).toEqual(["chk-2", "chk-3"]);
    const last = applyChecklistEdit(task({ checklist: [item("chk-1", "Passport")] }), { kind: "remove", id: "chk-1" });
    expect(last).toEqual([]);
    expect(checklistProgress(task({ checklist: last ?? [] }))).toBeNull();
  });

  it("refuses unknown ids, blank or duplicate adds, and a full Checklist", () => {
    expect(applyChecklistEdit(packed(), { kind: "toggle", id: "chk-9" })).toBeNull();
    expect(applyChecklistEdit(packed(), { kind: "add", id: "chk-4", text: " " })).toBeNull();
    expect(applyChecklistEdit(packed(), { kind: "add", id: "chk-1", text: "Again" })).toBeNull();
    const full = task({
      checklist: Array.from({ length: MAX_CHECKLIST_ITEMS }, (_, n) => item(`chk-${n}`, `Item ${n}`)),
    });
    expect(applyChecklistEdit(full, { kind: "add", id: "chk-new", text: "One more" })).toBeNull();
  });

  it("cuts long item text to the sync limit", () => {
    const added = applyChecklistEdit(task(), { kind: "add", id: "chk-1", text: "x".repeat(MAX_CHECKLIST_TEXT_LENGTH + 50) });
    expect(added?.[0].text).toHaveLength(MAX_CHECKLIST_TEXT_LENGTH);
  });
});

describe("habit day Tasks have no Checklist", () => {
  const habitDay = task({ id: "habtsk-2026-11-18-hab-1", habitId: "hab-1", scheduledDate: "2026-11-18" });

  it("refuses every edit on a habit day Task", () => {
    expect(canHoldChecklist(habitDay)).toBe(false);
    expect(applyChecklistEdit(habitDay, { kind: "add", id: "chk-1", text: "Warm up" })).toBeNull();
    expect(canHoldChecklist(task())).toBe(true);
  });
});
