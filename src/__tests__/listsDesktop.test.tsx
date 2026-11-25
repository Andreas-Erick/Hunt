// Desktop Lists section: create, rename and delete Lists; item edits through the shared
// Checklist editor; Clear ticked and Untick all. Reached from the top navigation.
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ListsView } from "@/components/ListsView";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { db } from "@/lib/db";
import type { List } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

const item = (id: string, text: string, done = false) => ({ id, text, done });

function seedList(overrides: Partial<List> = {}): List {
  return {
    id: "list-1763400000000-abcd",
    title: "Groceries",
    items: [item("chk-1", "Milk", true), item("chk-2", "Bread"), item("chk-3", "Eggs", true)],
    rank: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function listRow(id = "list-1763400000000-abcd"): Promise<List | undefined> {
  return db.lists.get(id);
}

describe("the Lists section", () => {
  it("is reachable from the top navigation", () => {
    render(<TopTelemetryBar />);
    fireEvent.click(screen.getAllByRole("button", { name: "Lists" })[0]);
    expect(useCommandStore.getState().activeView).toBe("lists");
  });

  it("creates a List from its name", async () => {
    render(<ListsView />);
    expect(await screen.findByText(/No Lists yet/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("New List name"), { target: { value: "Weekly shop" } });
    fireEvent.click(screen.getByRole("button", { name: "New List" }));
    await waitFor(async () => expect((await db.lists.toArray()).map((l) => l.title)).toEqual(["Weekly shop"]));
    expect(await screen.findByRole("region", { name: "Weekly shop" })).toBeTruthy();
  });

  it("shows items struck through in place, with progress", async () => {
    await db.lists.put(seedList());
    render(<ListsView />);
    const card = await screen.findByRole("region", { name: "Groceries" });
    const ticks = within(card).getAllByRole("checkbox");
    expect(ticks.map((t) => t.getAttribute("aria-label"))).toEqual(["Milk", "Bread", "Eggs"]);
    expect(ticks.map((t) => t.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
    expect(within(card).getByLabelText("2 of 3 ticked")).toBeTruthy();
  });

  it("adds and ticks items with the Checklist editor", async () => {
    await db.lists.put(seedList({ items: [] }));
    render(<ListsView />);
    const card = await screen.findByRole("region", { name: "Groceries" });
    fireEvent.change(within(card).getByLabelText("New item"), { target: { value: "Apples" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add item" }));
    await waitFor(async () => expect((await listRow())?.items.map((i) => i.text)).toEqual(["Apples"]));
    fireEvent.click(await within(card).findByRole("checkbox", { name: "Apples" }));
    await waitFor(async () => expect((await listRow())?.items[0].done).toBe(true));
  });

  it("Clear ticked removes the ticked items; Untick all resets the rest", async () => {
    await db.lists.put(seedList());
    render(<ListsView />);
    const card = await screen.findByRole("region", { name: "Groceries" });
    fireEvent.click(within(card).getByRole("button", { name: "Untick all" }));
    await waitFor(async () => expect((await listRow())?.items.every((i) => !i.done)).toBe(true));

    await db.lists.put(seedList({ updatedAt: 9_999_999_999_999 }));
    // Clear ticked stays disabled until the live query shows the ticked items again; a click on
    // the still-disabled button would do nothing (the flake this wait removes).
    const clear = within(card).getByRole("button", { name: "Clear ticked" });
    await waitFor(() => expect(clear.hasAttribute("disabled")).toBe(false));
    // Two steps: the first click only arms it, so one stray tap deletes nothing.
    fireEvent.click(clear);
    expect((await listRow())?.items).toHaveLength(seedList().items.length);
    fireEvent.click(within(card).getByRole("button", { name: /^Delete \d+ ticked\?$/ }));
    await waitFor(async () => expect((await listRow())?.items).toEqual([item("chk-2", "Bread")]));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Clear ticked" }).hasAttribute("disabled")).toBe(true));
  });

  it("renames a List in place and deletes it with confirmation", async () => {
    await db.lists.put(seedList());
    render(<ListsView />);
    const card = await screen.findByRole("region", { name: "Groceries" });
    const name = within(card).getByLabelText("Rename Groceries");
    fireEvent.change(name, { target: { value: "Market" } });
    fireEvent.blur(name);
    await waitFor(async () => expect((await listRow())?.title).toBe("Market"));

    fireEvent.click(within(card).getByRole("button", { name: /Delete List/ }));
    fireEvent.click(await within(card).findByRole("button", { name: "Delete List?" }));
    await waitFor(async () => expect(await listRow()).toBeUndefined());
  });
});
