// List rules (shared core, so the desktop and the phone edit a standalone List the same way).
import { describe, expect, it } from "vitest";
import {
  applyListEdit,
  buildList,
  listProgress,
  MAX_LIST_TITLE_LENGTH,
  newListId,
  sanitizeList,
} from "@/lib/lists";
import { isSafeSyncId, MAX_CHECKLIST_ITEMS } from "@/lib/syncTypes";
import type { List } from "@/lib/domainTypes";

const item = (id: string, text: string, done = false) => ({ id, text, done });

function list(overrides: Partial<List> = {}): List {
  return {
    id: "list-1763400000000-abcd",
    title: "Groceries",
    items: [item("chk-1", "Milk", true), item("chk-2", "Bread"), item("chk-3", "Eggs", true)],
    rank: 1000,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("creating a List", () => {
  it("has a trimmed title and no items, date, Quest or focus time", () => {
    const created = buildList({ id: "list-1-aaaa", title: "  Weekly shop  ", rank: 3000, now: 50 });
    expect(created).toEqual({ id: "list-1-aaaa", title: "Weekly shop", items: [], rank: 3000, createdAt: 50, updatedAt: 50 });
  });

  it("refuses a blank title and cuts a long one to the sync limit", () => {
    expect(buildList({ id: "list-1-aaaa", title: "   ", rank: 0, now: 1 })).toBeNull();
    const long = buildList({ id: "list-1-aaaa", title: "x".repeat(MAX_LIST_TITLE_LENGTH + 50), rank: 0, now: 1 });
    expect(long?.title).toHaveLength(MAX_LIST_TITLE_LENGTH);
  });

  it("gets a safe sync id", () => {
    const id = newListId(1763400000000, () => 0.5);
    expect(id).toMatch(/^list-1763400000000-[a-z0-9]{4}$/);
    expect(isSafeSyncId(id)).toBe(true);
  });
});

describe("editing a List's items", () => {
  it("adds, ticks, renames, reorders and deletes items with the Checklist rules", () => {
    let l = list({ items: [] });
    l = { ...l, items: applyListEdit(l, { kind: "add", id: "chk-9", text: " Apples " }) ?? l.items };
    expect(l.items).toEqual([item("chk-9", "Apples")]);
    l = { ...l, items: applyListEdit(l, { kind: "toggle", id: "chk-9" }) ?? l.items };
    expect(l.items).toEqual([item("chk-9", "Apples", true)]);
    expect(applyListEdit(list(), { kind: "rename", id: "chk-2", text: "Rye bread" })?.[1]).toEqual(item("chk-2", "Rye bread"));
    expect(applyListEdit(list(), { kind: "move", id: "chk-3", toIndex: 0 })?.map((i) => i.id)).toEqual(["chk-3", "chk-1", "chk-2"]);
    expect(applyListEdit(list(), { kind: "remove", id: "chk-1" })?.map((i) => i.id)).toEqual(["chk-2", "chk-3"]);
  });

  it("keeps a ticked item in place", () => {
    const ticked = applyListEdit(list(), { kind: "toggle", id: "chk-2" });
    expect(ticked).toEqual([item("chk-1", "Milk", true), item("chk-2", "Bread", true), item("chk-3", "Eggs", true)]);
  });

  it("Clear ticked removes only the ticked items, in order", () => {
    expect(applyListEdit(list(), { kind: "clearTicked" })).toEqual([item("chk-2", "Bread")]);
    expect(applyListEdit(list({ items: [item("chk-2", "Bread")] }), { kind: "clearTicked" })).toBeNull();
  });

  it("Untick all resets every item for reuse, keeping order and text", () => {
    expect(applyListEdit(list(), { kind: "untickAll" })).toEqual([
      item("chk-1", "Milk"),
      item("chk-2", "Bread"),
      item("chk-3", "Eggs"),
    ]);
    expect(applyListEdit(list({ items: [item("chk-2", "Bread")] }), { kind: "untickAll" })).toBeNull();
  });

  it("shows progress as ticked of total", () => {
    expect(listProgress(list())).toEqual({ done: 2, total: 3 });
    expect(listProgress(list({ items: [] }))).toEqual({ done: 0, total: 0 });
  });
});

describe("validating a synced List", () => {
  it("keeps a legitimate List unchanged", () => {
    expect(sanitizeList(list())).toEqual(list());
  });

  it("drops a List that cannot be legitimate", () => {
    expect(sanitizeList(null)).toBeNull();
    expect(sanitizeList([])).toBeNull();
    expect(sanitizeList({ ...list(), id: "bad id!" })).toBeNull();
    expect(sanitizeList({ ...list(), title: 7 })).toBeNull();
  });

  it("coerces the rest: bad items dropped, a missing item list read as empty, long text cut", () => {
    const raw = {
      ...list(),
      title: "t".repeat(MAX_LIST_TITLE_LENGTH + 1),
      items: [item("chk-1", "Milk"), { id: "chk-1", text: "dup" }, { id: 5 }, "x", { id: "chk-2", text: "Tea", done: "yes" }],
      rank: Number.NaN,
      createdAt: -1,
      extra: { nested: true },
      note: "kept",
    };
    expect(sanitizeList(raw)).toEqual({
      id: list().id,
      title: "t".repeat(MAX_LIST_TITLE_LENGTH),
      items: [item("chk-1", "Milk"), item("chk-2", "Tea")],
      updatedAt: 1,
      note: "kept",
    });
    expect(sanitizeList({ id: "list-2", title: "Empty" })).toEqual({ id: "list-2", title: "Empty", items: [] });
  });

  it("keeps at most the Checklist item limit", () => {
    const many = Array.from({ length: MAX_CHECKLIST_ITEMS + 5 }, (_, i) => item(`chk-${i}`, `i${i}`));
    expect(sanitizeList(list({ items: many }))?.items).toHaveLength(MAX_CHECKLIST_ITEMS);
  });
});
