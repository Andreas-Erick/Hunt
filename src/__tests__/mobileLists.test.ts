// Phone: the Lists section (a bottom-nav tab) creates, renames and deletes standalone Lists, edits
// their items with the shared Checklist rules, and offers Clear ticked and Untick all. Lists live in
// the phone's saved state and sync as their own collection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, STATE_KEY, type MobileWindow } from "./helpers/loadMobile";

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

type Item = { id: string; text: string; done: boolean };
type ListRow = { id: string; title: string; items: Item[]; rank?: number; updatedAt?: number };
const item = (id: string, text: string, done = false): Item => ({ id, text, done });

const GROCERIES: ListRow = {
  id: "list-1763400000000-abcd",
  title: "Groceries",
  items: [item("chk-1", "Milk", true), item("chk-2", "Bread"), item("chk-3", "Eggs", true)],
  rank: 1000,
  updatedAt: 1,
};

function load(lists: ListRow[] = []): MobileWindow {
  w = loadMobile({
    seedState: { quests: [], tasks: [], timeLogs: [], lists, deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [] },
  });
  w.switchView("lists");
  return w;
}

const listsOf = (p: MobileWindow) => (readState(p) as unknown as { lists: ListRow[] }).lists;
const tombstonesOf = (p: MobileWindow) => (readState(p) as unknown as { deletedListIds?: string[] }).deletedListIds;
const card = (p: MobileWindow, title: string) => {
  const el = p.document.querySelector(`#mainContainer section[aria-label='${title}']`);
  if (!el) throw new Error(`no List card ${title}`);
  return el;
};

function typeAndSubmit(p: MobileWindow, input: Element | null, value: string): void {
  if (!(input instanceof p.HTMLInputElement)) throw new Error("input missing");
  input.value = value;
  input.dispatchEvent(new p.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function change(p: MobileWindow, input: Element | null, value: string): void {
  if (!(input instanceof p.HTMLInputElement)) throw new Error("input missing");
  input.value = value;
  input.dispatchEvent(new p.Event("change", { bubbles: true }));
}

describe("the phone's Lists section", () => {
  it("is a bottom-nav tab of its own, apart from Today", () => {
    const p = load();
    p.switchView("command");
    click(p, p.document.getElementById("nav-lists"));
    expect(p.document.body.getAttribute("data-view")).toBe("lists");
    expect(p.document.getElementById("nav-lists")?.getAttribute("aria-current")).toBe("page");
    expect(p.document.querySelector("#mainContainer h1")?.textContent).toBe("Lists");
    expect(pageErrors(p)).toEqual([]);
  });

  it("creates a List from its name, with no date, Quest or focus time", () => {
    const p = load();
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("No Lists yet");
    typeAndSubmit(p, p.document.querySelector("[aria-label='New List name']"), "  Weekly shop ");
    const [created] = listsOf(p);
    expect(created).toMatchObject({ title: "Weekly shop", items: [] });
    expect(created.id).toMatch(/^list-\d+-[a-z0-9]{4}$/);
    expect(Object.keys(created).sort()).toEqual(["createdAt", "id", "items", "rank", "title", "updatedAt"]);
    expect(card(p, "Weekly shop")).toBeTruthy();
  });

  it("shows ticked items in place, struck through, with progress", () => {
    const p = load([GROCERIES]);
    const c = card(p, "Groceries");
    const ticks = Array.from(c.querySelectorAll("[role='checkbox']"));
    expect(ticks.map((t) => [t.getAttribute("aria-label"), t.getAttribute("aria-checked")])).toEqual([
      ["Milk", "true"],
      ["Bread", "false"],
      ["Eggs", "true"],
    ]);
    expect(c.querySelector("[aria-label='2 of 3 ticked']")?.textContent?.trim()).toBe("2/3");
  });

  it("adds, ticks, renames, reorders and deletes items with the Checklist editor", () => {
    const p = load([{ ...GROCERIES, items: [] }]);
    typeAndSubmit(p, card(p, "Groceries").querySelector("[aria-label='New item']"), "Apples");
    typeAndSubmit(p, card(p, "Groceries").querySelector("[aria-label='New item']"), "Pears");
    expect(listsOf(p)[0].items.map((i) => i.text)).toEqual(["Apples", "Pears"]);

    click(p, card(p, "Groceries").querySelector("[role='checkbox'][aria-label='Apples']"));
    expect(listsOf(p)[0].items.map((i) => i.done)).toEqual([true, false]);

    change(p, card(p, "Groceries").querySelector("[aria-label='Rename Pears']"), "Conference pears");
    click(p, card(p, "Groceries").querySelector("[aria-label='Move Conference pears up']"));
    expect(listsOf(p)[0].items.map((i) => i.text)).toEqual(["Conference pears", "Apples"]);

    click(p, card(p, "Groceries").querySelector("[aria-label='Delete Apples']"));
    expect(listsOf(p)[0].items.map((i) => i.text)).toEqual(["Conference pears"]);
    expect(listsOf(p)[0].updatedAt).toBeGreaterThan(1);
    expect(pageErrors(p)).toEqual([]);
  });

  it("Clear ticked removes the ticked items; Untick all resets the List", () => {
    const p = load([GROCERIES]);
    click(p, card(p, "Groceries").querySelector("button[aria-label='Untick all']"));
    expect(listsOf(p)[0].items.map((i) => i.done)).toEqual([false, false, false]);
    expect(card(p, "Groceries").querySelector("button[aria-label='Clear ticked']")?.hasAttribute("disabled")).toBe(true);

    click(p, card(p, "Groceries").querySelector("[role='checkbox'][aria-label='Eggs']"));
    click(p, card(p, "Groceries").querySelector("button[aria-label='Clear ticked']"));
    expect(listsOf(p)[0].items.map((i) => i.text)).toEqual(["Milk", "Bread"]);
  });

  it("renames a List, keeping the old name for a blank one", () => {
    const p = load([GROCERIES]);
    change(p, card(p, "Groceries").querySelector("[aria-label='Rename Groceries']"), "   ");
    expect(listsOf(p)[0].title).toBe("Groceries");
    change(p, card(p, "Groceries").querySelector("[aria-label='Rename Groceries']"), "Market");
    expect(listsOf(p)[0].title).toBe("Market");
    expect(card(p, "Market")).toBeTruthy();
  });

  it("deletes a List with a tombstone, and Undo brings it back", () => {
    const p = load([GROCERIES]);
    click(p, card(p, "Groceries").querySelector("[aria-label='Delete List Groceries']"));
    expect(listsOf(p)).toEqual([]);
    expect(tombstonesOf(p)).toEqual([GROCERIES.id]);
    click(p, p.document.querySelector("#toastHost .toast button"));
    expect(listsOf(p).map((l) => l.id)).toEqual([GROCERIES.id]);
    expect(tombstonesOf(p)).toEqual([]);
  });

  it("keeps Lists in the saved state, guarded like every synced collection", () => {
    const p = load([GROCERIES]);
    const guarded = p.guardSyncState({
      lists: [GROCERIES, { id: "<b>", title: "x", items: [] }, { ...GROCERIES, id: "list-2", items: [null, item("chk-1", "ok")] }],
      deletedListIds: ["list-9", "<script>"],
    });
    expect(guarded.value.lists).toEqual([GROCERIES, { ...GROCERIES, id: "list-2", items: [item("chk-1", "ok")] }]);
    expect(guarded.value.deletedListIds).toEqual(["list-9"]);
    expect(guarded.dropped).toBe(3);

    p.persistState();
    const saved = JSON.parse(p.localStorage.getItem(STATE_KEY) ?? "{}") as { lists?: ListRow[] };
    expect(saved.lists).toEqual([GROCERIES]);
  });

  it("merges Lists from a sync answer by the shared rules", () => {
    const p = load([GROCERIES]);
    const newer = { ...GROCERIES, title: "Groceries (laptop)", updatedAt: 50 };
    expect(p.applyRemotePayload({ quests: [], tasks: [], timeLogs: [], lists: [newer], deletedListIds: [] })).toBe(true);
    expect(listsOf(p)).toEqual([newer]);
    p.applyRemotePayload({ quests: [], tasks: [], timeLogs: [], lists: [], deletedListIds: [GROCERIES.id] });
    expect(listsOf(p)).toEqual([]);
  });
});
