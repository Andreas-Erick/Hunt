import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { db, seedInitialDataIfNeeded } from "@/lib/db";
import { syncDataExistsElsewhere } from "@/lib/syncEngine";
import { useCommandStore } from "@/store/useCommandStore";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import {
  NOTES_DRAFT_KEY_PREFIX,
  NOTES_SAVE_DEBOUNCE_MS,
  TaskNotesField,
  restoreMirroredNoteDrafts,
} from "@/components/TaskNotesField";
import { MobileSyncModal } from "@/components/MobileSyncModal";

/** Lets pending promise callbacks (a resolved or rejected save) run inside act. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

// Real store actions, restored after tests that replace them with spies.
const realActions = (() => {
  const s = useCommandStore.getState();
  return {
    syncNow: s.syncNow,
    requestSync: s.requestSync,
    updateTask: s.updateTask,
  };
})();

/** Demo data, as on a first launch against an EMPTY local sync server. */
async function seedDemoData() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          payload: { quests: [], tasks: [], timeLogs: [], deletedTaskIds: [], deletedLogIds: [] },
        }),
      }) as unknown as Response
    )
  );
  try {
    await seedInitialDataIfNeeded(syncDataExistsElsewhere);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("UI Components & User Workflows", () => {
  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    await seedDemoData();

    useCommandStore.setState({
      activeView: "command",
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      lastCompletedFeedback: null,
      // No real sync from any test: a real edit's debounced requestSync timer
      // would otherwise fire during a later test (calling that test's syncNow
      // spy) or send a real request.
      syncNow: vi.fn(async () => true),
      requestSync: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup(); // unmount before restoring the store (no updates outside act)
    useCommandStore.setState(realActions);
  });

  describe("TopTelemetryBar", () => {
    it("renders navigation tabs (Home, Plan, Focus, Quests, Review) and switches views", () => {
      render(<TopTelemetryBar />);

      // The wordmark shows from the sm breakpoint (there is no xs screen).
      expect(screen.getByText("Hunt")).toHaveClass("hidden", "sm:inline");
      expect(screen.getByText("Hunt").className).not.toContain("xs:");
      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getByText("Plan")).toBeInTheDocument();
      expect(screen.getByText("Focus")).toBeInTheDocument();
      expect(screen.getByText("Quests")).toBeInTheDocument();
      expect(screen.getByText("Review")).toBeInTheDocument();

      fireEvent.click(screen.getByText("Plan"));
      expect(useCommandStore.getState().activeView).toBe("plan");

      fireEvent.click(screen.getByText("Quests"));
      expect(useCommandStore.getState().activeView).toBe("quests");

      fireEvent.click(screen.getByText("Review"));
      expect(useCommandStore.getState().activeView).toBe("telemetry");
    });

    it("hides completely when activeView is 'focus' (Principle 1: Distraction-free Focus)", () => {
      useCommandStore.setState({ activeView: "focus" });
      const { container } = render(<TopTelemetryBar />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("CommandCenterView (Home & Done-List Timeline)", () => {
    it("renders seeded tasks, Today's Timeline, and allows adding a new task to Top", async () => {
      render(<CommandCenterView />);

      await waitFor(() => {
        expect(
          screen.getAllByText("Design the next chapter").length
        ).toBeGreaterThan(0);
      });

      expect(screen.getByText(/Today's Timeline/i)).toBeInTheDocument();

      const input = screen.getByPlaceholderText("Add quest work...");
      fireEvent.change(input, { target: { value: "Ship mobile PWA manifest" } });
      fireEvent.click(screen.getByText("Top"));

      await waitFor(() => {
        expect(
          screen.getByText("Ship mobile PWA manifest")
        ).toBeInTheDocument();
      });
    });
  });

  describe("PlanWeekView (5-Column Weekly Board)", () => {
    it("renders 'Plan the week' and 5 day columns with Today button", async () => {
      render(<PlanWeekView />);

      expect(screen.getByText("Plan the week")).toBeInTheDocument();
      expect(screen.getByText("Today")).toBeInTheDocument();

      await waitFor(() => {
        expect(
          screen.getByText("Polish the details that matter")
        ).toBeInTheDocument();
      });
    });
  });

  describe("FocusHudView (Single-Task Stopwatch)", () => {
    it("displays only the active task, stopwatch, Pause/Resume, and Complete buttons", async () => {
      await useCommandStore.getState().initializeFocus("tsk-01");

      render(<FocusHudView />);

      await waitFor(() => {
        expect(
          screen.getByText("Design the next chapter")
        ).toBeInTheDocument();
      });

      expect(screen.getByText("Running")).toBeInTheDocument();
      expect(screen.getByText("Pause")).toBeInTheDocument();
      expect(screen.getByText("Complete")).toBeInTheDocument();

      // Pause via Spacebar shortcut
      fireEvent.keyDown(window, { code: "Space" });

      await waitFor(() => {
        expect(useCommandStore.getState().isRunning).toBe(false);
      });
    });
  });

  describe("QuestMatrixPanel (Active Quests View)", () => {
    it("renders all 3 active Quests and their weekly hour targets", async () => {
      render(<QuestMatrixPanel />);

      await waitFor(() => {
        expect(screen.getByText("Launch my idea")).toBeInTheDocument();
        expect(screen.getByText("Write every week")).toBeInTheDocument();
        expect(screen.getByText("Run a half marathon")).toBeInTheDocument();
      });
    });
  });

  describe("TelemetryDashboardView (Weekly Review)", () => {
    it("renders Weekly review KPI cards, Per Day chart, and Hours by Quest breakdown", async () => {
      render(<TelemetryDashboardView />);

      expect(screen.getByText("Weekly review")).toBeInTheDocument();
      expect(
        screen.getByText("How much of the week moved your quests forward.")
      ).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByText("Quest Hours · Per Day")).toBeInTheDocument();
        expect(screen.getByText("Hours by Quest")).toBeInTheDocument();
      });
    });
  });

  describe("TaskNotesField (local draft, debounced save)", () => {
    let updateTask: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      updateTask = vi.fn(async () => undefined);
      useCommandStore.setState({
        updateTask,
        syncNow: vi.fn(async () => true),
        requestSync: vi.fn(),
      });
    });

    afterEach(() => {
      cleanup(); // unmount before restoring the store (no updates outside act)
      vi.useRealTimers();
      useCommandStore.setState(realActions);
    });

    const field = (notes: string) => (
      <TaskNotesField taskId="tsk-notes" notes={notes} placeholder="Notes" />
    );

    it("keeps keystrokes local and saves once ~400 ms after typing stops", async () => {
      const { rerender } = render(field(""));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;

      fireEvent.change(ta, { target: { value: "a" } });
      fireEvent.change(ta, { target: { value: "ab" } });
      // A re-render with the not-yet-updated stored value must not revert the draft.
      rerender(field(""));
      fireEvent.change(ta, { target: { value: "abc" } });

      expect(ta.value).toBe("abc");
      expect(updateTask).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS - 1));
      expect(updateTask).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith("tsk-notes", { notes: "abc" });
      expect(ta.value).toBe("abc");
    });

    it("saves immediately on blur", () => {
      render(field("old"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: "old + new" } });
      fireEvent.blur(ta);
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith("tsk-notes", { notes: "old + new" });
    });

    it("flushes a pending edit on unmount (drawer closed right after typing)", async () => {
      const { unmount } = render(field(""));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: "last words" } });
      unmount();
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith("tsk-notes", { notes: "last words" });

      await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS * 2));
      expect(updateTask).toHaveBeenCalledTimes(1);
    });

    it("adopts updates from elsewhere only while the draft has no unsaved edits", () => {
      const { rerender } = render(field("one"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;

      rerender(field("two")); // e.g. edited on the phone, arrived via sync
      expect(ta.value).toBe("two");

      fireEvent.change(ta, { target: { value: "mine" } });
      rerender(field("three"));
      expect(ta.value).toBe("mine");
    });

    it("never writes when nothing was typed", async () => {
      const { unmount } = render(field("same"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.focus(ta);
      fireEvent.blur(ta);
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS * 2));
      expect(updateTask).not.toHaveBeenCalled();
    });

    const mirrorKey = `${NOTES_DRAFT_KEY_PREFIX}tsk-notes`;
    const readMirror = () => {
      const raw = window.localStorage.getItem(mirrorKey);
      return raw ? (JSON.parse(raw) as { draft: string; base: string }) : null;
    };

    it("mirrors the unsaved draft to localStorage synchronously and drops it once the save committed", async () => {
      window.localStorage.removeItem(mirrorKey);
      let commit: () => void = () => undefined;
      updateTask.mockImplementation(
        () => new Promise<void>((resolve) => (commit = resolve))
      );
      render(field("before"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;

      fireEvent.change(ta, { target: { value: "before + typed" } });
      // Written in the same tick as the keystroke (a reload right now keeps it).
      expect(readMirror()).toEqual({ draft: "before + typed", base: "before" });
      expect(updateTask).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS));
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(readMirror()).not.toBeNull(); // not committed yet
      commit();
      await settle();
      expect(readMirror()).toBeNull();
    });

    it("keeps the mirror when the save fails, and when newer typing re-mirrored it", async () => {
      window.localStorage.removeItem(mirrorKey);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      updateTask.mockImplementationOnce(async () => {
        throw new Error("IDB closed");
      });
      render(field(""));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: "lost?" } });
      fireEvent.blur(ta);
      await settle();
      expect(readMirror()).toEqual({ draft: "lost?", base: "" });

      // The next save succeeds, but the user kept typing before it resolved.
      let commit: () => void = () => undefined;
      updateTask.mockImplementationOnce(() => new Promise<void>((r) => (commit = r)));
      fireEvent.change(ta, { target: { value: "lost? no" } });
      fireEvent.blur(ta);
      fireEvent.change(ta, { target: { value: "lost? no!" } });
      commit();
      await settle();
      expect(readMirror()?.draft).toBe("lost? no!");
      errors.mockRestore();
      window.localStorage.removeItem(mirrorKey);
    });

    it("keeps the mirror, and the draft unsaved, when the store reports a failed write (updateTask resolves false)", async () => {
      window.localStorage.removeItem(mirrorKey);
      updateTask.mockResolvedValueOnce(false);
      render(field("base"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;

      fireEvent.change(ta, { target: { value: "base + draft" } });
      fireEvent.blur(ta);
      await settle();
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(readMirror()).toEqual({ draft: "base + draft", base: "base" });
      expect(ta.value).toBe("base + draft");

      // Typing on still records the notes IndexedDB really holds as the base.
      fireEvent.change(ta, { target: { value: "base + draft!" } });
      expect(readMirror()).toEqual({ draft: "base + draft!", base: "base" });

      // The next flush retries the save; this one commits and drops the mirror.
      fireEvent.blur(ta);
      await settle();
      expect(updateTask).toHaveBeenCalledTimes(2);
      expect(updateTask).toHaveBeenLastCalledWith("tsk-notes", { notes: "base + draft!" });
      expect(readMirror()).toBeNull();
    });

    it("retries a failed save on the next blur even without new typing", async () => {
      window.localStorage.removeItem(mirrorKey);
      updateTask.mockResolvedValueOnce(false);
      render(field(""));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: "only once" } });
      fireEvent.blur(ta);
      await settle();
      expect(readMirror()).toEqual({ draft: "only once", base: "" });

      fireEvent.focus(ta);
      fireEvent.blur(ta);
      await settle();
      expect(updateTask).toHaveBeenCalledTimes(2);
      expect(updateTask).toHaveBeenLastCalledWith("tsk-notes", { notes: "only once" });
      expect(readMirror()).toBeNull();
    });

    it("re-bases a draft typed while a failing save was in flight, so a reload still restores it", async () => {
      window.localStorage.removeItem(mirrorKey);
      let answer: (saved: boolean) => void = () => undefined;
      updateTask.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (answer = resolve))
      );
      render(field("base"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;

      fireEvent.change(ta, { target: { value: "base + a" } });
      fireEvent.blur(ta);
      // Typed on before the save answered: mirrored over the hoped-for notes.
      fireEvent.change(ta, { target: { value: "base + ab" } });
      expect(readMirror()).toEqual({ draft: "base + ab", base: "base + a" });

      answer(false);
      await settle();
      // IndexedDB still holds "base"; boot restore only applies a mirror whose base matches it.
      expect(readMirror()).toEqual({ draft: "base + ab", base: "base" });

      await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS));
      expect(updateTask).toHaveBeenLastCalledWith("tsk-notes", { notes: "base + ab" });
      expect(readMirror()).toBeNull();
    });

    it("flushes a pending draft on pagehide (best effort)", () => {
      render(field("x"));
      const ta = screen.getByPlaceholderText("Notes") as HTMLTextAreaElement;
      fireEvent.change(ta, { target: { value: "x + y" } });
      window.dispatchEvent(new Event("pagehide"));
      expect(updateTask).toHaveBeenCalledTimes(1);
      expect(updateTask).toHaveBeenCalledWith("tsk-notes", { notes: "x + y" });
    });
  });

  describe("restoreMirroredNoteDrafts() (page boot)", () => {
    const put = (taskId: string, value: unknown) =>
      window.localStorage.setItem(
        `${NOTES_DRAFT_KEY_PREFIX}${taskId}`,
        typeof value === "string" ? value : JSON.stringify(value)
      );
    const mirrorKeys = () =>
      Object.keys(window.localStorage).filter((k) => k.startsWith(NOTES_DRAFT_KEY_PREFIX));

    afterEach(() => {
      for (const k of mirrorKeys()) window.localStorage.removeItem(k);
    });

    it("restores a draft over the notes it was typed on, and removes every handled mirror key", async () => {
      await db.tasks.update("tsk-01", { notes: "base text", updatedAt: 5000 });
      await db.tasks.update("tsk-02", { notes: "edited on the phone meanwhile" });
      put("tsk-01", { draft: "base text + typed before reload", base: "base text" });
      put("tsk-02", { draft: "stale draft", base: "old" });
      put("tsk-gone", { draft: "task was deleted", base: "" });
      put("tsk-03", "{not json");

      const restored = await restoreMirroredNoteDrafts();

      expect(restored).toBe(1);
      const t1 = await db.tasks.get("tsk-01");
      expect(t1?.notes).toBe("base text + typed before reload");
      expect(t1?.updatedAt).toBeGreaterThan(5000);
      expect((await db.tasks.get("tsk-02"))?.notes).toBe("edited on the phone meanwhile");
      expect(await db.tasks.get("tsk-gone")).toBeUndefined();
      expect(mirrorKeys()).toEqual([]);
    });

    it("a draft typed into empty notes is restored (missing notes count as '')", async () => {
      await db.tasks.update("tsk-03", { notes: undefined as unknown as string });
      put("tsk-03", { draft: "first words", base: "" });
      expect(await restoreMirroredNoteDrafts()).toBe(1);
      expect((await db.tasks.get("tsk-03"))?.notes).toBe("first words");
    });
  });

  describe("CommandCenterView notes & quest defaults", () => {
    beforeEach(() => {
      useCommandStore.setState({
        syncNow: vi.fn(async () => true),
        requestSync: vi.fn(),
      });
    });

    afterEach(() => {
      cleanup(); // unmount before restoring the store (no updates outside act)
      useCommandStore.setState(realActions);
    });

    it("saves drawer notes to IndexedDB through the debounced field", async () => {
      render(<CommandCenterView />);
      await waitFor(() => {
        expect(
          screen.getAllByTitle("Task notes & options").length
        ).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getAllByTitle("Task notes & options")[0]);
      const ta = (await screen.findByPlaceholderText(
        "Add session notes..."
      )) as HTMLTextAreaElement;
      const savedCount = () =>
        db.tasks.filter((t) => t.notes === "Typed without lag").count();

      // Only the debounce is faked: IndexedDB I/O (setImmediate) stays real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        fireEvent.change(ta, { target: { value: "Typed without lag" } });
        expect(ta.value).toBe("Typed without lag");

        await act(() => vi.advanceTimersByTimeAsync(NOTES_SAVE_DEBOUNCE_MS - 1));
        expect(await savedCount()).toBe(0);

        // The write itself is real IndexedDB I/O; the drawer re-renders from it
        // (Dexie's live-query signal is a setTimeout: run it, never drop it).
        const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
          for (let i = 0; i < 200 && (await savedCount()) !== 1; i++) await nextTurn();
          vi.runOnlyPendingTimers();
          for (let i = 0; i < 10; i++) await nextTurn();
        });
        expect(await savedCount()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("defaults new tasks to the first existing quest, never a deleted id", async () => {
      await db.quests.delete("quest-slot-0");
      render(<CommandCenterView />);

      await waitFor(() => {
        expect(screen.getAllByText("Write every week").length).toBeGreaterThan(0);
      });

      fireEvent.change(screen.getByPlaceholderText("Add quest work..."), {
        target: { value: "Task with a live quest" },
      });
      fireEvent.click(screen.getByText("Top"));

      await waitFor(async () => {
        const created = await db.tasks
          .filter((t) => t.title === "Task with a live quest")
          .first();
        expect(created?.questId).toBe("quest-slot-1");
      });
    });
  });

  describe("Phone status reflects the PHONE (phoneLastSeenAt), not the local server", () => {
    let syncNow: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      syncNow = vi.fn(async () => true);
      useCommandStore.setState({
        syncNow,
        requestSync: vi.fn(),
        isSyncOnline: true,
        syncError: null,
        lastSyncedAt: Date.now(),
        lanUrls: ["http://192.168.1.5:3000"],
        phoneLastSeenAt: null,
      });
    });

    afterEach(() => {
      cleanup(); // unmount before restoring the store (no updates outside act)
      useCommandStore.setState({
        ...realActions,
        isSyncOnline: false,
        syncError: null,
        lastSyncedAt: null,
        lanUrls: [],
        phoneLastSeenAt: null,
      });
    });

    const phoneButton = () => screen.getByRole("button", { name: /Phone sync:/ });
    const phoneDot = () => phoneButton().querySelector("span") as HTMLElement;

    it("is green while the phone synced within the last 20 s", () => {
      useCommandStore.setState({ phoneLastSeenAt: Date.now() - 3000 });
      render(<TopTelemetryBar />);
      expect(phoneButton()).toHaveAccessibleName(/Phone connected/);
      expect(phoneDot().className).toContain("bg-[#00ff9d]");
    });

    it("is neutral with the last sync time when the phone is away, even though the local server is fine", () => {
      useCommandStore.setState({ phoneLastSeenAt: Date.now() - 5 * 60_000 - 1000 });
      render(<TopTelemetryBar />);
      expect(phoneButton()).toHaveAccessibleName(/Phone last synced 5 m ago/);
      expect(phoneDot().className).toContain("bg-neutral-500");
      expect(phoneDot().className).not.toContain("bg-[#00ff9d]");
    });

    it("says the phone has not synced when the server never heard from it", () => {
      render(<TopTelemetryBar />);
      expect(phoneButton()).toHaveAccessibleName(/Phone hasn't synced yet/);
      expect(phoneDot().className).toContain("bg-neutral-500");
    });

    it("shows a local server problem separately", () => {
      useCommandStore.setState({
        isSyncOnline: false,
        syncError: "unreachable",
        phoneLastSeenAt: Date.now() - 2000,
      });
      render(<TopTelemetryBar />);
      expect(phoneButton()).toHaveAccessibleName(/Local sync server not reachable/);
    });

    it("MobileSyncModal shows phone and local server status separately, with a real Sync Now result", async () => {
      useCommandStore.setState({ phoneLastSeenAt: Date.now() - 5 * 60_000 - 1000 });
      render(<MobileSyncModal isOpen onClose={() => undefined} />);

      expect(screen.getByText("Phone last synced 5 m ago")).toBeInTheDocument();
      expect(screen.getByText("Local sync server running")).toBeInTheDocument();
      expect(screen.queryByText(/Auto-Sync Active/)).toBeNull();

      await waitFor(() => {
        expect(screen.queryByText("Generating QR...")).toBeNull();
      });

      const callsBefore = syncNow.mock.calls.length;
      fireEvent.click(screen.getByText("Sync Now"));
      expect(await screen.findByText("Synced")).toBeInTheDocument();
      expect(syncNow.mock.calls.length).toBe(callsBefore + 1);
    });
  });
});
