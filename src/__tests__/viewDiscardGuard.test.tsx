import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { db } from "@/lib/db";
import type { Habit, Quest } from "@/lib/domainTypes";
import { useCommandStore, type HudView } from "@/store/useCommandStore";
import HomePage from "@/app/page";

const DISCARD_PROMPT = "Discard unsaved changes?";
const T0 = 1_700_000_000_000;

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, autoSync: s.autoSync, requestSync: s.requestSync };
})();

function makeQuest(id: string, title: string, slotIndex: 0 | 1 | 2): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "Ship it",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeHabit(id: string, title: string): Habit {
  return {
    id,
    title,
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: T0,
    updatedAt: T0,
  };
}

/** The top-nav tab (header buttons, not in-view links). */
function navTab(label: string): HTMLElement {
  return within(screen.getByRole("navigation")).getByRole("button", { name: label });
}

const view = (): HudView => useCommandStore.getState().activeView;

/** Renders the real app shell (header nav + one mounted view) on `start`. */
async function renderShellOn(start: HudView) {
  render(<HomePage />);
  await screen.findByRole("navigation");
  // Through the store action, as the nav would: no guard is registered yet.
  act(() => useCommandStore.getState().setActiveView(start));
}

beforeEach(async () => {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  // A non-empty profile: the boot's seed step makes no server request.
  await db.quests.bulkAdd([makeQuest("quest-0", "Launch", 0), makeQuest("quest-1", "Write", 1)]);
  await db.habits.add(makeHabit("habit-0", "Stretch 10m"));
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
    discardGuard: null,
    syncNow: vi.fn(async () => true),
    autoSync: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useCommandStore.setState({ ...realActions, actionError: null });
});

// ---------------------------------------------------------------------------
// leaving a view with unsaved form edits asks first (same prompt as Cancel)
// ---------------------------------------------------------------------------
describe("view switch discard guard", () => {
  it("a dirty quest edit drawer asks before a nav tab switches views; declining keeps every edit", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderShellOn("quests");
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Launch v2" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New scope" } });

    fireEvent.click(navTab("Plan"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
    expect(view()).toBe("quests");
    expect(navTab("Quests")).toHaveAttribute("aria-current", "page");
    expect(navTab("Plan")).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v2");
    expect(screen.getByLabelText("Description")).toHaveValue("New scope");

    // The logo (Home) and the Focus tab go through the same guard.
    fireEvent.click(screen.getByRole("button", { name: "Hunt, go to Home" }));
    fireEvent.click(navTab("Focus"));
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(view()).toBe("quests");
    expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v2");

    // Accepting discards the draft and switches; nothing was written.
    confirm.mockReturnValue(true);
    fireEvent.click(navTab("Plan"));
    expect(confirm).toHaveBeenCalledTimes(4);
    await waitFor(() => expect(view()).toBe("plan"));
    expect(screen.queryByLabelText("Quest Title")).toBeNull();
    expect(useCommandStore.getState().discardGuard).toBeNull();
    const row = await db.quests.get("quest-0");
    expect(row?.title).toBe("Launch");
    expect(row?.updatedAt).toBe(T0);
  });

  it("a dirty New Quest form asks before leaving the Quests view", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderShellOn("quests");
    await screen.findByRole("button", { name: "Edit quest Launch" });
    fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Research" } });

    fireEvent.click(navTab("Habits"));
    expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
    expect(view()).toBe("quests");
    expect(screen.getByLabelText("Quest Title")).toHaveValue("Research");

    confirm.mockReturnValue(true);
    fireEvent.click(navTab("Habits"));
    await waitFor(() => expect(view()).toBe("habits"));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await db.quests.count()).toBe(2);
  });

  it("pristine or cleaned-up forms switch views without a prompt", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderShellOn("quests");

    // An opened but unchanged drawer is not dirty.
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    fireEvent.click(navTab("Plan"));
    await waitFor(() => expect(view()).toBe("plan"));
    expect(confirm).not.toHaveBeenCalled();

    // Typing back the original value clears the guard.
    fireEvent.click(navTab("Quests"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    const title = screen.getByLabelText("Quest Title");
    fireEvent.change(title, { target: { value: "Launch v2" } });
    fireEvent.change(title, { target: { value: "Launch" } });
    expect(useCommandStore.getState().discardGuard).toBeNull();
    fireEvent.click(navTab("Plan"));
    await waitFor(() => expect(view()).toBe("plan"));
    expect(confirm).not.toHaveBeenCalled();

    // Clicking the tab of the view already shown never asks.
    fireEvent.click(navTab("Quests"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Launch v3" } });
    fireEvent.click(navTab("Quests"));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v3");
  });

  it("a dirty habit edit asks before a nav tab switches views", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await renderShellOn("habits");
    const [editToggle] = await screen.findAllByRole("button", { name: "Edit habit Stretch 10m" });
    fireEvent.click(editToggle);
    fireEvent.change(screen.getByLabelText("Habit Title"), { target: { value: "Stretch 20m" } });

    fireEvent.click(navTab("Quests"));
    expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
    expect(view()).toBe("habits");
    expect(screen.getByLabelText("Habit Title")).toHaveValue("Stretch 20m");

    confirm.mockReturnValue(true);
    fireEvent.click(navTab("Quests"));
    await waitFor(() => expect(view()).toBe("quests"));
    expect(useCommandStore.getState().discardGuard).toBeNull();
    expect((await db.habits.get("habit-0"))?.title).toBe("Stretch 10m");
  });

  it("Save, an accepted Cancel, and a saved habit edit each drop the guard: the next switch does not ask", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderShellOn("quests");

    // Saved quest edit: written, and leaving afterwards does not prompt.
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Launch v2" } });
    expect(useCommandStore.getState().discardGuard).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Quest Title")).toBeNull());
    expect((await db.quests.get("quest-0"))?.title).toBe("Launch v2");
    expect(useCommandStore.getState().discardGuard).toBeNull();
    expect(confirm).not.toHaveBeenCalled();

    // Accepted Cancel on a dirty New Quest form: one prompt (the Cancel's own), none on leaving.
    fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Research" } });
    expect(useCommandStore.getState().discardGuard).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Quest Title")).toBeNull();
    expect(useCommandStore.getState().discardGuard).toBeNull();
    fireEvent.click(navTab("Habits"));
    await waitFor(() => expect(view()).toBe("habits"));
    expect(confirm).toHaveBeenCalledTimes(1);

    // Saved habit edit: written, and leaving afterwards does not prompt.
    const [editToggle] = await screen.findAllByRole("button", { name: "Edit habit Stretch 10m" });
    fireEvent.click(editToggle);
    fireEvent.change(screen.getByLabelText("Habit Title"), { target: { value: "Stretch 20m" } });
    expect(useCommandStore.getState().discardGuard).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByLabelText("Habit Title")).toBeNull());
    expect((await db.habits.get("habit-0"))?.title).toBe("Stretch 20m");
    expect(useCommandStore.getState().discardGuard).toBeNull();
    fireEvent.click(navTab("Plan"));
    await waitFor(() => expect(view()).toBe("plan"));
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("a view switch outside setActiveView (Start focus) unmounts the form and leaves no stale guard", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await db.tasks.add({
      id: "task-0",
      title: "Draft outline",
      notes: "",
      questId: "quest-0",
      status: "queued",
      rank: 1000,
      accumulatedSeconds: 0,
      createdAt: T0,
      updatedAt: T0,
    });
    await renderShellOn("quests");
    fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Launch v2" } });
    expect(useCommandStore.getState().discardGuard).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Start focus: Draft outline" }));
    await waitFor(() => expect(view()).toBe("focus"));
    expect(screen.queryByLabelText("Quest Title")).toBeNull();
    expect(useCommandStore.getState().discardGuard).toBeNull();

    // The unmounted panel's guard no longer gates navigation.
    act(() => useCommandStore.getState().setActiveView("command"));
    expect(view()).toBe("command");
    expect(confirm).not.toHaveBeenCalled();
  });
});
