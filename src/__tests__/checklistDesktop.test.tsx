// Desktop Checklist: the store edits a Task's Checklist with the shared rule, and the Home row
// shows its progress and an editor inside the Task.
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CommandCenterView } from "@/components/CommandCenterView";
import { FocusHudView } from "@/components/FocusHudView";
import { toLocalDateKey } from "@/lib/dateUtils";
import { db } from "@/lib/db";
import type { Task } from "@/lib/domainTypes";
import { buildLocalSyncPayload } from "@/lib/syncEngine";
import { validateSyncPayload } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { makeQuest, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

const store = () => useCommandStore.getState();
const QUEST = makeQuest("quest-1", 0, "Launch", "cyan");

function seedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1763400000000-abcd",
    title: "Pack for the trip",
    notes: "",
    questId: QUEST.id,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

async function seed(...tasks: Task[]): Promise<void> {
  await db.quests.put(QUEST);
  await db.tasks.bulkPut(tasks);
}

const NO_FOCUS = { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 };

describe("editing a Checklist through the store", () => {
  it("stores the items on the Task row, exactly as the sync validator keeps them", async () => {
    const t = seedTask();
    await seed(t);
    expect(await store().editChecklist(t.id, { kind: "add", id: "chk-1", text: "Passport" })).toBe(true);
    expect(await store().editChecklist(t.id, { kind: "add", id: "chk-2", text: "Charger" })).toBe(true);
    const row = await db.tasks.get(t.id);
    expect(row?.checklist).toEqual([
      { id: "chk-1", text: "Passport", done: false },
      { id: "chk-2", text: "Charger", done: false },
    ]);
    expect(row?.updatedAt).toBeGreaterThan(1000);

    const payload = await buildLocalSyncPayload(NO_FOCUS);
    expect(validateSyncPayload(payload).payload?.tasks[0].checklist).toEqual(payload.tasks[0].checklist);
  });

  it("ticking every item leaves the Task open", async () => {
    const t = seedTask({ checklist: [{ id: "chk-1", text: "Passport", done: false }] });
    await seed(t);
    await store().editChecklist(t.id, { kind: "toggle", id: "chk-1" });
    const row = await db.tasks.get(t.id);
    expect(row?.checklist?.[0].done).toBe(true);
    expect(row?.status).toBe("queued");
    expect(row?.completedAt).toBeUndefined();
  });

  it("refuses a Checklist on a habit day Task", async () => {
    const t = seedTask({ id: "habtsk-2026-11-18-hab-1", habitId: "hab-1" });
    await seed(t);
    expect(await store().editChecklist(t.id, { kind: "add", id: "chk-1", text: "Warm up" })).toBe(false);
    expect((await db.tasks.get(t.id))?.checklist).toBeUndefined();
  });
});

describe("the Checklist on the Home row", () => {
  const packed = () =>
    seedTask({
      checklist: [
        { id: "chk-1", text: "Passport", done: true },
        { id: "chk-2", text: "Charger", done: false },
      ],
    });

  async function openDrawer(): Promise<HTMLElement> {
    render(<CommandCenterView />);
    const row = await screen.findByText("Pack for the trip");
    const card = row.closest<HTMLElement>("[data-testid='task-row']");
    if (!card) throw new Error("no task row");
    fireEvent.click(within(card).getByTitle("Task notes & options"));
    return card;
  }

  const stored = async () => (await db.tasks.get("tsk-1763400000000-abcd"))?.checklist;

  it("shows n/m progress on the row when the Task has a Checklist", async () => {
    await seed(packed(), seedTask({ id: "tsk-1763400000001-none", title: "No list", rank: 2000 }));
    render(<CommandCenterView />);
    expect(await screen.findByLabelText("Checklist: 1 of 2 done")).toHaveTextContent("1/2");
    expect(screen.getAllByLabelText(/^Checklist: /)).toHaveLength(1);
  });

  it("adds, ticks, renames, reorders and deletes items inside the Task", async () => {
    await seed(seedTask());
    const card = await openDrawer();

    const add = within(card).getByLabelText("New checklist item");
    fireEvent.change(add, { target: { value: "Passport" } });
    fireEvent.keyDown(add, { key: "Enter" });
    await waitFor(async () => expect((await stored())?.map((i) => i.text)).toEqual(["Passport"]));
    fireEvent.change(add, { target: { value: "Charger" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add checklist item" }));
    await waitFor(async () => expect((await stored())?.map((i) => i.text)).toEqual(["Passport", "Charger"]));

    fireEvent.click(await within(card).findByRole("checkbox", { name: "Passport" }));
    await waitFor(async () => expect((await stored())?.[0].done).toBe(true));
    expect(await within(card).findByLabelText("Checklist: 1 of 2 done")).toBeInTheDocument();

    const rename = within(card).getByLabelText("Rename Charger");
    fireEvent.change(rename, { target: { value: "USB-C charger" } });
    fireEvent.blur(rename);
    await waitFor(async () => expect((await stored())?.[1].text).toBe("USB-C charger"));

    fireEvent.click(await within(card).findByRole("button", { name: "Move USB-C charger up" }));
    await waitFor(async () => expect((await stored())?.map((i) => i.text)).toEqual(["USB-C charger", "Passport"]));

    fireEvent.click(within(card).getByRole("button", { name: "Delete Passport" }));
    await waitFor(async () => expect((await stored())?.map((i) => i.text)).toEqual(["USB-C charger"]));
    expect((await db.tasks.get("tsk-1763400000000-abcd"))?.status).toBe("queued");
  });

  it("edits the Checklist of an Other work Task from its focus view", async () => {
    await seed(seedTask({ questId: null }));
    await store().initializeFocus("tsk-1763400000000-abcd");
    render(<FocusHudView />);
    fireEvent.click(await screen.findByRole("button", { name: "+ Add checklist" }));
    const add = screen.getByLabelText("New checklist item");
    fireEvent.change(add, { target: { value: "Passport" } });
    fireEvent.keyDown(add, { key: "Enter" });
    await waitFor(async () => expect((await stored())?.map((i) => i.text)).toEqual(["Passport"]));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Passport" }));
    await waitFor(async () => expect((await stored())?.[0].done).toBe(true));
  });

  it("offers no Checklist inside a habit day Task", async () => {
    await seed(seedTask({ habitId: "hab-1", scheduledDate: toLocalDateKey() }));
    const card = await openDrawer();
    expect(within(card).queryByLabelText("New checklist item")).toBeNull();
  });
});
