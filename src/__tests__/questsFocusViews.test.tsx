import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import {
  db,
  dateFromKey,
  dateKeyFromOffset,
  toLocalDateKey,
  QUEST_ACCENT_STYLES,
  type Quest,
  type QuestAccent,
  type Task,
  type TimeLog,
} from "@/lib/db";
import { MAX_QUEST_TITLE_LENGTH } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";

const TOMBSTONE_KEY = "hunt-sync-tombstones-v1";
const STORE_KEY = "journey-hud-command-store";
/** Fixed creation/update stamp, so a rewrite of a row is visible in updatedAt. */
const T0 = 1_700_000_000_000;
const ALL_DONE = "All tasks completed for today.";
const DISCARD_PROMPT = "Discard unsaved changes?";

// Real store actions, restored after tests that replace them with spies.
const realActions = (() => {
  const s = useCommandStore.getState();
  return {
    syncNow: s.syncNow,
    requestSync: s.requestSync,
    initializeFocus: s.initializeFocus,
    engageTimer: s.engageTimer,
    suspendTimer: s.suspendTimer,
    completeActiveTask: s.completeActiveTask,
    completeTaskById: s.completeTaskById,
    createTask: s.createTask,
    createQuest: s.createQuest,
    updateQuest: s.updateQuest,
    deleteQuest: s.deleteQuest,
  };
})();

function makeQuest(
  id: string,
  title: string,
  slotIndex: 0 | 1 | 2,
  extra: Partial<Quest> = {}
): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeTask(
  id: string,
  title: string,
  questId: string | null,
  rank: number,
  extra: Partial<Task> = {}
): Task {
  return {
    id,
    title,
    notes: "",
    questId,
    status: "queued",
    rank,
    accumulatedSeconds: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeLog(
  id: string,
  dateKey: string,
  questId: string | null,
  durationSeconds: number
): TimeLog {
  const startTime = dateFromKey(dateKey).getTime();
  return {
    id,
    taskId: "tsk-logged",
    taskTitleSnapshot: `Session ${id}`,
    questId,
    questCodeSnapshot: questId ? "QUEST" : "OTHER",
    accentColorSnapshot: questId ? "cyan" : "slate",
    startTime,
    endTime: startTime + durationSeconds * 1000,
    durationSeconds,
    dateKey,
  };
}

async function seed({
  quests = [],
  tasks = [],
  logs = [],
}: {
  quests?: Quest[];
  tasks?: Task[];
  logs?: TimeLog[];
}) {
  await db.quests.bulkAdd(quests);
  await db.tasks.bulkAdd(tasks);
  await db.timeLogs.bulkAdd(logs);
}

async function statusById(): Promise<Map<string, Task["status"]>> {
  return new Map((await db.tasks.toArray()).map((t) => [t.id, t.status]));
}

/** Small seeded PRNG (mulberry32) for reproducible random action sequences. */
function mulberry32(seedValue: number): () => number {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Reads IndexedDB inside act(), so live queries that re-run meanwhile update
 * the mounted view inside act as well.
 */
async function inAct<T>(read: () => Promise<T>): Promise<T> {
  const results: T[] = [];
  await act(async () => {
    results.push(await read());
  });
  return results[0];
}

/**
 * Records which of `texts` the document ever showed, including a one-render
 * flash that React replaced before the test could look: added nodes are
 * checked, and so are the previous values of text nodes React rewrote in place.
 */
function watchForText(texts: readonly string[]) {
  const seen = new Set<string>();
  const check = (content: string | null | undefined) => {
    for (const text of texts) if (content?.includes(text)) seen.add(text);
  };
  const scan = (records: MutationRecord[]) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => check(node.textContent));
      if (record.type === "characterData") {
        check(record.oldValue);
        check(record.target.textContent);
      }
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
  });
  return {
    seen,
    stop: () => {
      scan(observer.takeRecords());
      observer.disconnect();
    },
  };
}

/**
 * DIX-04 class contract: a hover-only (opacity-0) control is revealed on
 * keyboard focus, and a field without an outline shows focus another way.
 */
function expectVisibleFocus(root: HTMLElement) {
  for (const control of Array.from(root.querySelectorAll<HTMLElement>("button, a"))) {
    if (control.classList.contains("opacity-0")) {
      expect(control, control.outerHTML.slice(0, 160)).toHaveClass("focus-visible:opacity-100");
    }
  }
  const fields = Array.from(
    root.querySelectorAll<HTMLElement>("input, textarea, select")
  );
  expect(fields.length).toBeGreaterThan(0);
  for (const field of fields) {
    if (!field.classList.contains("focus:outline-none")) continue;
    const ownIndicator = Array.from(field.classList).some((c) =>
      /^focus(-visible)?:(border|ring)/.test(c)
    );
    const wrapper = field.closest('[class*="focus-within:border-"]');
    expect(ownIndicator || wrapper !== null, field.outerHTML.slice(0, 160)).toBe(true);
    expect(wrapper?.className ?? "", "focus-within border below white/40").not.toMatch(
      /focus-within:border-white\/(10|20|30)\b/
    );
  }
}

/** Settles every promise a vi.fn() spy has returned so far. */
async function settled(spy: { mock: { results: Array<{ value: unknown }> } }) {
  await act(async () => {
    await Promise.all(spy.mock.results.map((r) => r.value));
  });
}

beforeEach(async () => {
  await db.quests.clear();
  await db.tasks.clear();
  await db.timeLogs.clear();
  window.localStorage.removeItem(TOMBSTONE_KEY);
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
    syncNow: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup(); // unmount before restoring the store (no updates outside act)
  useCommandStore.setState({
    ...realActions,
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem(TOMBSTONE_KEY);
  window.localStorage.removeItem(STORE_KEY);
});

// ---------------------------------------------------------------------------
// Focus view
// ---------------------------------------------------------------------------

describe("FocusHudView", () => {
  const QUEUE = [
    makeTask("tsk-a", "Alpha", "quest-0", 1000),
    makeTask("tsk-b", "Bravo", "quest-0", 2000),
    makeTask("tsk-c", "Charlie", "quest-0", 3000),
  ];
  const heading = (title: string) =>
    screen.findByRole("heading", { level: 1, name: title });
  const completeButton = () =>
    screen.getByRole("button", { name: "Complete" });

  async function focusOn(taskId: string) {
    await useCommandStore.getState().initializeFocus(taskId);
  }

  describe("Complete (double-click / rapid-fire guard)", () => {
    beforeEach(async () => {
      await seed({ quests: [makeQuest("quest-0", "Launch", 0)], tasks: QUEUE });
    });

    it("completing offers the next task without auto-starting it, and ignores double-clicks", async () => {
      const completeActiveTask = vi.fn(realActions.completeActiveTask);
      useCommandStore.setState({ completeActiveTask });
      await focusOn("tsk-a");
      render(<FocusHudView />);
      await heading("Alpha");

      // Double-click detail:2 is ignored
      fireEvent.click(completeButton(), { detail: 2 });
      expect(completeActiveTask).not.toHaveBeenCalled();

      fireEvent.click(completeButton(), { detail: 1 });
      expect(completeActiveTask).toHaveBeenCalledTimes(1);
      await settled(completeActiveTask);

      // Offers Bravo on the idle Focus screen without starting it automatically
      expect(
        await screen.findByRole("heading", { level: 2, name: "Bravo" })
      ).toBeInTheDocument();
      const startNext = screen.getByRole("button", { name: "Start Focus Session" });
      expect(startNext).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(/Completed\s+Alpha/);

      const status = await inAct(statusById);
      expect(status.get("tsk-a")).toBe("completed");
      expect(status.get("tsk-b")).toBe("queued");
      expect(status.get("tsk-c")).toBe("queued");
      expect(useCommandStore.getState().activeTaskId).toBeNull();
      expect(useCommandStore.getState().isRunning).toBe(false);
      expect(await inAct(() => db.timeLogs.count())).toBe(1);

      // Explicitly starting Bravo begins focusing it, and keyboard Enter (detail 0) completes it
      fireEvent.click(startNext);
      await heading("Bravo");
      fireEvent.click(completeButton(), { detail: 0 });
      expect(completeActiveTask).toHaveBeenCalledTimes(2);
      await settled(completeActiveTask);
      expect(
        await screen.findByRole("heading", { level: 2, name: "Charlie" })
      ).toBeInTheDocument();
      expect((await inAct(statusById)).get("tsk-b")).toBe("completed");
      expect((await inAct(statusById)).get("tsk-c")).toBe("queued");
    });

    it("10 clicks in one tick complete exactly one task and do not start the next", async () => {
      const completeActiveTask = vi.fn(realActions.completeActiveTask);
      useCommandStore.setState({ completeActiveTask });
      await focusOn("tsk-a");
      render(<FocusHudView />);
      await heading("Alpha");

      const button = completeButton();
      // One act(): React does not re-render (disable the button) in between,
      // so only the in-flight guard can drop clicks 2-10.
      act(() => {
        for (let i = 0; i < 10; i++) fireEvent.click(button, { detail: 1 });
      });
      expect(completeActiveTask).toHaveBeenCalledTimes(1);

      expect(
        await screen.findByRole("heading", { level: 2, name: "Bravo" })
      ).toBeInTheDocument();
      await settled(completeActiveTask);
      const status = await inAct(statusById);
      expect(status.get("tsk-a")).toBe("completed");
      expect(status.get("tsk-b")).toBe("queued");
      expect(status.get("tsk-c")).toBe("queued");
      expect(await inAct(() => db.timeLogs.count())).toBe(1);
    });

    it("is disabled and aria-busy while the completion runs", async () => {
      let finish: () => void = () => undefined;
      const completeActiveTask = vi.fn(
        () => new Promise<void>((resolve) => (finish = resolve))
      );
      useCommandStore.setState({ completeActiveTask });
      await focusOn("tsk-a");
      render(<FocusHudView />);
      await heading("Alpha");

      fireEvent.click(completeButton());
      expect(completeButton()).toBeDisabled();
      expect(completeButton()).toHaveAttribute("aria-busy", "true");

      await act(async () => finish());
      await waitFor(() => expect(completeButton()).toBeEnabled());
      expect(completeButton()).toHaveAttribute("aria-busy", "false");
    });

    it("is disabled while the view still shows a task the store has moved past", async () => {
      const completeActiveTask = vi.fn(realActions.completeActiveTask);
      useCommandStore.setState({ completeActiveTask });
      await focusOn("tsk-a");
      render(<FocusHudView />);
      await heading("Alpha");

      // Another device (or a completion) moved focus on; the live query for
      // the new task has not resolved yet, so the view still shows Alpha.
      act(() => {
        useCommandStore.setState({ activeTaskId: "tsk-b" });
      });
      expect(
        screen.getByRole("heading", { level: 1, name: "Alpha" })
      ).toBeInTheDocument();
      expect(completeButton()).toBeDisabled();
      fireEvent.click(completeButton());
      expect(completeActiveTask).not.toHaveBeenCalled();

      await heading("Bravo");
      expect(completeButton()).toBeEnabled();
    });

    it("unmounting mid-completion finishes the write without errors", async () => {
      const completeActiveTask = vi.fn(realActions.completeActiveTask);
      useCommandStore.setState({ completeActiveTask });
      const consoleError = vi.spyOn(console, "error");
      await focusOn("tsk-a");
      const view = render(<FocusHudView />);
      await heading("Alpha");

      fireEvent.click(completeButton());
      view.unmount();
      await settled(completeActiveTask);

      expect((await inAct(statusById)).get("tsk-a")).toBe("completed");
      expect(consoleError).not.toHaveBeenCalled();
    });
  });

  describe("Space shortcut", () => {
    let suspendTimer: ReturnType<typeof vi.fn>;
    let engageTimer: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      await seed({ quests: [makeQuest("quest-0", "Launch", 0)], tasks: QUEUE });
      suspendTimer = vi.fn(realActions.suspendTimer);
      engageTimer = vi.fn(realActions.engageTimer);
      useCommandStore.setState({ suspendTimer, engageTimer });
      await focusOn("tsk-a");
    });

    it("a held Space (auto-repeat) toggles once and logs at most one session", async () => {
      render(<FocusHudView />);
      await heading("Alpha");

      expect(fireEvent.keyDown(window, { code: "Space" })).toBe(false);
      for (let i = 0; i < 30; i++) {
        fireEvent.keyDown(window, { code: "Space", repeat: true });
      }
      expect(suspendTimer).toHaveBeenCalledTimes(1);
      expect(engageTimer).not.toHaveBeenCalled();
      await settled(suspendTimer);
      await waitFor(() =>
        expect(useCommandStore.getState().isRunning).toBe(false)
      );

      // Still held after the view re-rendered as paused: no resume either.
      for (let i = 0; i < 30; i++) {
        // Repeats are still swallowed (no page scroll) but toggle nothing.
        expect(
          fireEvent.keyDown(window, { code: "Space", repeat: true })
        ).toBe(false);
      }
      expect(engageTimer).not.toHaveBeenCalled();
      expect(suspendTimer).toHaveBeenCalledTimes(1);
      expect(await inAct(() => db.timeLogs.count())).toBe(1);
      expect(useCommandStore.getState().isRunning).toBe(false);
    });

    it("Space on a focused button keeps its native meaning", async () => {
      render(<FocusHudView />);
      await heading("Alpha");

      const complete = completeButton();
      complete.focus();
      // Not prevented: the browser activates the button itself on keyup.
      expect(fireEvent.keyDown(complete, { code: "Space" })).toBe(true);
      expect(
        fireEvent.keyDown(screen.getByRole("button", { name: "Pause" }), {
          code: "Space",
        })
      ).toBe(true);
      expect(suspendTimer).not.toHaveBeenCalled();
      expect(engageTimer).not.toHaveBeenCalled();
      expect(useCommandStore.getState().isRunning).toBe(true);
    });

    it("ignores modified Space and Space typed into editable content", async () => {
      render(<FocusHudView />);
      await heading("Alpha");

      fireEvent.keyDown(window, { code: "Space", ctrlKey: true });
      fireEvent.keyDown(window, { code: "Space", metaKey: true });
      fireEvent.keyDown(window, { code: "Space", altKey: true });

      fireEvent.click(screen.getByRole("button", { name: "+ Add notes" }));
      const notes = await screen.findByRole("textbox", { name: "Session notes" });
      expect(fireEvent.keyDown(notes, { code: "Space" })).toBe(true);

      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "");
      const inner = document.createElement("span");
      editable.appendChild(inner);
      document.body.appendChild(editable);
      try {
        expect(fireEvent.keyDown(inner, { code: "Space" })).toBe(true);
      } finally {
        editable.remove();
      }

      expect(suspendTimer).not.toHaveBeenCalled();
      expect(useCommandStore.getState().isRunning).toBe(true);
    });

    it("Space on the window or the page body still toggles", async () => {
      render(<FocusHudView />);
      await heading("Alpha");

      fireEvent.keyDown(window, { code: "Space" });
      expect(suspendTimer).toHaveBeenCalledTimes(1);
      await settled(suspendTimer);
      await screen.findByText("Paused");

      fireEvent.keyDown(document.body, { code: "Space" });
      expect(engageTimer).toHaveBeenCalledTimes(1);
      await screen.findByText("Running");
    });
  });

  describe("loading vs. empty", () => {
    it("never shows the all-done copy while the focused task is loading", async () => {
      await seed({ tasks: [makeTask("tsk-a", "Alpha", null, 1000)] });
      await focusOn("tsk-a");
      render(<FocusHudView />);

      expect(screen.queryByText(ALL_DONE)).toBeNull();
      expect(screen.queryByText("Start Focus Session")).toBeNull();
      await heading("Alpha");
      expect(screen.queryByText(ALL_DONE)).toBeNull();
    });

    it("shows the all-done copy only after an empty queue has loaded", async () => {
      render(<FocusHudView />);
      expect(screen.queryByText(ALL_DONE)).toBeNull();
      expect(await screen.findByText(ALL_DONE)).toBeInTheDocument();
    });

    it("never flashes the all-done copy while the queue is still loading", async () => {
      await seed({ tasks: [makeTask("tsk-a", "Alpha", null, 1000)] });
      // Nothing focused: the focused-task query settles (null) before the
      // queue query, so a view that does not wait for the queue shows the
      // all-done copy for a render.
      const watch = watchForText([ALL_DONE]);
      try {
        render(<FocusHudView />);
        expect(
          await screen.findByRole("heading", { level: 2, name: "Alpha" })
        ).toBeInTheDocument();
      } finally {
        watch.stop();
      }
      expect(Array.from(watch.seen)).toEqual([]);
    });

    it.each([
      ["the only queued task", [makeTask("tsk-a", "Alpha", null, 1000)]],
      [
        "the first of two",
        [makeTask("tsk-a", "Alpha", null, 1000), makeTask("tsk-b", "Bravo", null, 2000)],
      ],
    ])(
      "starting %s from the idle screen never flashes the all-done copy or the next task",
      async (_label, tasks) => {
        await seed({ tasks });
        render(<FocusHudView />);
        const start = await screen.findByRole("button", { name: "Start Focus Session" });

        // initializeFocus marks the task active (the queue query re-runs) before
        // the view has read the newly focused task.
        const watch = watchForText([ALL_DONE, "Bravo"]);
        try {
          fireEvent.click(start);
          await heading("Alpha");
        } finally {
          watch.stop();
        }
        expect(Array.from(watch.seen)).toEqual([]);
        expect(useCommandStore.getState().activeTaskId).toBe("tsk-a");
      }
    );

    it("a focused task that no longer exists falls back to the queue", async () => {
      await seed({ tasks: [makeTask("tsk-a", "Alpha", null, 1000)] });
      useCommandStore.setState({ activeTaskId: "tsk-gone" });
      render(<FocusHudView />);
      expect(
        await screen.findByRole("heading", { level: 2, name: "Alpha" })
      ).toBeInTheDocument();
      expect(screen.queryByText(ALL_DONE)).toBeNull();
    });

    it("does not offer a task scheduled for next week", async () => {
      const today = toLocalDateKey();
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-next", "Next week", "quest-0", 1000, {
            scheduledDate: dateKeyFromOffset(today, 7),
          }),
        ],
      });
      render(<FocusHudView />);

      expect(await screen.findByText(ALL_DONE)).toBeInTheDocument();
      expect(screen.queryByText("Next week")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Start Focus Session" })
      ).toBeNull();
    });

    it("offers today's or overdue quest work first, in rank order", async () => {
      const today = toLocalDateKey();
      const initializeFocus = vi.fn(async () => undefined);
      useCommandStore.setState({ initializeFocus });
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [
          makeTask("tsk-other", "Other chore", null, 100),
          makeTask("tsk-future", "Future quest work", "quest-0", 200, {
            scheduledDate: dateKeyFromOffset(today, 1),
          }),
          makeTask("tsk-overdue", "Overdue quest work", "quest-0", 300, {
            scheduledDate: dateKeyFromOffset(today, -2),
          }),
          makeTask("tsk-unscheduled", "Unscheduled quest work", "quest-0", 400),
        ],
      });
      render(<FocusHudView />);

      expect(
        await screen.findByRole("heading", { level: 2, name: "Overdue quest work" })
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Start Focus Session" }));
      expect(initializeFocus).toHaveBeenCalledWith("tsk-overdue");
    });
  });

  describe("edge data, a11y and layout contracts", () => {
    it("renders a task of a quest with an unknown accent ('violet') in the slate style", async () => {
      await seed({
        quests: [
          makeQuest("quest-v", "Violet quest", 0, {
            accentColor: "violet" as unknown as QuestAccent,
          }),
        ],
        tasks: [makeTask("tsk-v", "Violet task", "quest-v", 1000)],
      });
      await focusOn("tsk-v");
      render(<FocusHudView />);
      await heading("Violet task");

      const pill = await screen.findByTitle("Violet quest");
      expect(pill.previousElementSibling).toHaveClass(QUEST_ACCENT_STYLES.slate.bg);
    });

    it("wraps a 200-character unbroken title, truncates the quest pills and keeps the timer within the screen", async () => {
      const long = "W".repeat(200);
      const longQuest = "Q".repeat(200);
      await seed({
        quests: [makeQuest("quest-0", longQuest, 0)],
        tasks: [makeTask("tsk-long", long, "quest-0", 1000)],
      });
      await focusOn("tsk-long");
      render(<FocusHudView />);

      // Width capped by the stage (not fit-content), so the long word breaks.
      expect(await heading(long)).toHaveClass("w-full", "max-w-2xl", "break-words");
      expect(await screen.findByTitle(longQuest)).toHaveClass("truncate");
      const topBar = screen.getByTitle(`Focus · ${longQuest}`);
      expect(topBar).toHaveClass("truncate");
      expect(topBar.parentElement).toHaveClass("min-w-0");
      expect(
        screen.getByRole("button", { name: "Return to Home" })
      ).toHaveClass("shrink-0");

      const timer = screen.getByTestId("focus-timer");
      expect(timer).toHaveClass("text-7xl", "max-w-full", "sm:text-[8.5rem]", "md:text-[9.5rem]");
      expect(timer).not.toHaveClass("text-[6rem]");
    });

    it("every button has an accessible name and secondary text uses the AA-contrast muted token", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        tasks: [makeTask("tsk-a", "Alpha", "quest-0", 1000, { notes: "Draft" })],
      });
      await focusOn("tsk-a");
      const { container, unmount } = render(<FocusHudView />);
      await heading("Alpha");

      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAccessibleName();
      }
      expect(screen.getByText("Running")).toHaveClass("text-hud-muted");
      expect(screen.getByText("Press Space to pause or resume")).toHaveClass(
        "text-hud-muted"
      );
      expect(
        screen.getByRole("textbox", { name: "Session notes" })
      ).toHaveClass("placeholder:text-hud-muted");
      expect(container.querySelector('[class*="text-neutral-600"]')).toBeNull();
      unmount();

      // The idle screen (nothing focused, one task queued).
      await useCommandStore.getState().returnToQueue();
      render(<FocusHudView />);
      await screen.findByRole("button", { name: "Start Focus Session" });
      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAccessibleName();
      }
    });

    it("keyboard focus is visible on every control and field", async () => {
      await seed({ tasks: [makeTask("tsk-a", "Alpha", null, 1000, { notes: "Draft" })] });
      await focusOn("tsk-a");
      const { container } = render(<FocusHudView />);
      await heading("Alpha");
      await screen.findByRole("textbox", { name: "Session notes" });
      expectVisibleFocus(container);
    });

    it("renders HTML, emoji and RTL titles as plain text", async () => {
      const payload = '<img src=x onerror="alert(1)"> 👨‍👩‍👧‍👦 مرحبا';
      await seed({
        quests: [makeQuest("quest-0", `<script>alert(1)</script>`, 0)],
        tasks: [makeTask("tsk-x", payload, "quest-0", 1000)],
      });
      await focusOn("tsk-x");
      const { container } = render(<FocusHudView />);

      expect(await heading(payload)).toHaveTextContent(payload);
      expect(await screen.findByTitle("<script>alert(1)</script>")).toBeInTheDocument();
      expect(container.querySelector("img, script")).toBeNull();
    });
  });

  it("random Complete / Space / Pause-Resume sequences keep the queue consistent (seeded)", async () => {
    const SEED = 0x5eed2026;
    const rand = mulberry32(SEED);
    const tasks = Array.from({ length: 6 }, (_, i) =>
      makeTask(`tsk-${i}`, `Task ${i}`, "quest-0", (i + 1) * 1000)
    );
    await seed({ quests: [makeQuest("quest-0", "Launch", 0)], tasks });
    const completeActiveTask = vi.fn(realActions.completeActiveTask);
    const suspendTimer = vi.fn(realActions.suspendTimer);
    const engageTimer = vi.fn(realActions.engageTimer);
    useCommandStore.setState({ completeActiveTask, suspendTimer, engageTimer });
    await focusOn("tsk-0");
    render(<FocusHudView />);
    await heading("Task 0");

    let singleClicks = 0;
    for (let step = 0; step < 60; step++) {
      const r = rand();
      const complete = screen.queryByRole("button", { name: "Complete" });
      if (r < 0.3) {
        if (complete) {
          const detail = 1 + Math.floor(rand() * 3);
          if (detail === 1) singleClicks += 1;
          fireEvent.click(complete, { detail });
        }
      } else if (r < 0.6) {
        fireEvent.keyDown(window, { code: "Space", repeat: rand() < 0.5 });
      } else if (r < 0.8) {
        const toggle =
          screen.queryByRole("button", { name: "Pause" }) ??
          screen.queryByRole("button", { name: "Resume" });
        if (toggle) fireEvent.click(toggle);
      } else {
        await act(async () => {
          await Promise.all([
            ...completeActiveTask.mock.results.map((x) => x.value),
            ...suspendTimer.mock.results.map((x) => x.value),
          ]);
        });
      }
    }
    await settled(completeActiveTask);
    await settled(suspendTimer);

    const rows = await inAct(() => db.tasks.toArray());
    const completed = rows.filter((t) => t.status === "completed");
    const active = rows.filter((t) => t.status === "active");
    const msg = `seed ${SEED}`;
    // Every accepted Complete finished exactly one task; none came from the
    // second or third click of a multi-click.
    expect(completed.length, msg).toBe(completeActiveTask.mock.calls.length);
    expect(completeActiveTask.mock.calls.length, msg).toBeLessThanOrEqual(singleClicks);
    expect(active.length, msg).toBeLessThanOrEqual(1);
    const { activeTaskId } = useCommandStore.getState();
    if (activeTaskId) expect(active.map((t) => t.id), msg).toEqual([activeTaskId]);
    else expect(active, msg).toEqual([]);

    const logs = await inAct(() => db.timeLogs.toArray());
    for (const log of logs) {
      expect(Number.isFinite(log.durationSeconds) && log.durationSeconds >= 1, msg).toBe(true);
    }
    const sessions = new Set(logs.map((l) => `${l.taskId}@${l.startTime}`));
    expect(sessions.size, msg).toBe(logs.length);
  });
});

// ---------------------------------------------------------------------------
// Quests view
// ---------------------------------------------------------------------------

describe("QuestMatrixPanel", () => {
  const card = (questId: string): HTMLElement => {
    const found = screen
      .getAllByTestId("quest-card")
      .find((c) => c.dataset.questId === questId);
    if (!found) throw new Error(`No quest card for ${questId}`);
    return found;
  };
  const editToggle = (title: string) =>
    screen.getByRole("button", { name: `Edit quest ${title}` });
  const editForm = (title: string) =>
    screen.getByRole("form", { name: `Edit quest ${title}` });
  const targetInput = (form: HTMLElement) =>
    within(form).getByRole("spinbutton", { name: "Weekly target hours" });

  /**
   * Enter in a text field. Browsers submit through the form's default (first
   * submit) button; jsdom leaves that implicit-submission step out, so it is
   * done here.
   */
  function pressEnter(input: HTMLInputElement): HTMLButtonElement {
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    const form = input.form;
    if (!form) throw new Error("input is not in a form");
    const defaultButton = Array.from(form.elements).find(
      (el): el is HTMLButtonElement =>
        el instanceof HTMLButtonElement && el.type === "submit"
    );
    if (!defaultButton) throw new Error("form has no submit button");
    fireEvent.click(defaultButton);
    return defaultButton;
  }

  async function seedTwoQuests() {
    await seed({
      quests: [
        makeQuest("quest-0", "Launch", 0, { description: "Ship it" }),
        makeQuest("quest-1", "Write", 1, { accentColor: "amber" }),
      ],
      tasks: [
        makeTask("tsk-a", "Alpha", "quest-0", 1000),
        makeTask("tsk-b", "Bravo", "quest-0", 2000),
        makeTask("tsk-done", "Done", "quest-0", 500, {
          status: "completed",
          completedAt: T0,
        }),
        makeTask("tsk-w", "Draft", "quest-1", 3000),
      ],
    });
  }

  describe("loading vs. empty", () => {
    it("renders the heading while quests load, and the empty state only after", async () => {
      render(<QuestMatrixPanel />);
      expect(
        screen.getByRole("heading", { level: 1, name: "Quests" })
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "New Quest" })).toBeInTheDocument();
      expect(screen.queryByText(/No active Quests/)).toBeNull();
      expect(await screen.findByText(/No active Quests/)).toBeInTheDocument();
    });

    it("shows a dash, never 0.0h, until the week's logs have loaded", async () => {
      await seed({
        quests: [makeQuest("quest-0", "Launch", 0)],
        logs: [makeLog("log-today", toLocalDateKey(), "quest-0", 3600)],
      });
      const watch = watchForText(["0.0h"]);
      try {
        render(<QuestMatrixPanel />);
        await waitFor(() =>
          expect(within(card("quest-0")).getByText("1.0h")).toBeInTheDocument()
        );
      } finally {
        watch.stop();
      }
      expect(Array.from(watch.seen)).toEqual([]);
    });
  });

  describe("edit drawer lifecycle", () => {
    beforeEach(seedTwoQuests);

    it("asks before switching quests with unsaved edits; cancelling keeps them", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

      const title = screen.getByLabelText("Quest Title");
      expect(title).toHaveValue("Launch");
      fireEvent.change(title, { target: { value: "Launch v2" } });

      fireEvent.click(editToggle("Write"));
      expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v2");
      expect(within(card("quest-0")).getByRole("form")).toBe(editForm("Launch"));
      expect(editToggle("Launch")).toHaveAttribute("aria-expanded", "true");
      expect(editToggle("Write")).toHaveAttribute("aria-expanded", "false");

      // Toggling the same drawer closed and Escape ask as well.
      fireEvent.click(editToggle("Launch"));
      fireEvent.keyDown(screen.getByLabelText("Quest Title"), { key: "Escape" });
      fireEvent.click(within(editForm("Launch")).getByRole("button", { name: "Cancel" }));
      expect(confirm).toHaveBeenCalledTimes(4);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v2");

      // Accepting discards the edits and opens the other quest.
      confirm.mockReturnValue(true);
      fireEvent.click(editToggle("Write"));
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Write");
      expect(editToggle("Write")).toHaveAttribute("aria-expanded", "true");

      const row = await inAct(() => db.quests.get("quest-0"));
      expect(row?.title).toBe("Launch");
      expect(row?.updatedAt).toBe(T0);
    });

    it("a pristine drawer closes or switches without a prompt", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      expect(editForm("Launch")).toBeInTheDocument();

      fireEvent.click(editToggle("Launch"));
      expect(screen.queryByRole("form")).toBeNull();

      fireEvent.click(editToggle("Launch"));
      fireEvent.click(editToggle("Write"));
      expect(editForm("Write")).toBeInTheDocument();

      // Escape and Cancel close it and hand focus back to its toggle.
      fireEvent.keyDown(screen.getByLabelText("Quest Title"), { key: "Escape" });
      expect(screen.queryByRole("form")).toBeNull();
      expect(editToggle("Write")).toHaveFocus();

      fireEvent.click(editToggle("Launch"));
      fireEvent.click(within(editForm("Launch")).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("form")).toBeNull();
      expect(editToggle("Launch")).toHaveFocus();

      expect(confirm).not.toHaveBeenCalled();
    });

    it("Enter in the title saves through updateQuest and stamps the row", async () => {
      const updateQuest = vi.fn(realActions.updateQuest);
      useCommandStore.setState({ updateQuest });
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

      const form = editForm("Launch");
      fireEvent.change(within(form).getByLabelText("Quest Title"), {
        target: { value: "Launch v2" },
      });
      fireEvent.change(within(form).getByLabelText("Description"), {
        target: { value: "New description" },
      });
      fireEvent.click(within(form).getByRole("button", { name: "Amber" }));
      expect(within(form).getByRole("button", { name: "Amber" })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
      fireEvent.change(targetInput(form), { target: { value: "12" } });

      const submitter = pressEnter(
        within(form).getByLabelText("Quest Title") as HTMLInputElement
      );
      expect(submitter).toHaveAccessibleName("Save");

      await waitFor(() => expect(updateQuest).toHaveBeenCalledTimes(1));
      expect(updateQuest).toHaveBeenCalledWith("quest-0", {
        title: "Launch v2",
        description: "New description",
        accentColor: "amber",
        targetWeeklyHours: 12,
      });
      await settled(updateQuest);

      const row = await inAct(() => db.quests.get("quest-0"));
      expect(row).toMatchObject({
        title: "Launch v2",
        description: "New description",
        accentColor: "amber",
        targetWeeklyHours: 12,
      });
      expect(row?.updatedAt).toBeGreaterThan(T0);
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      expect(editToggle("Launch v2")).toHaveFocus();
    });

    it.each(["0", "-1", "-0", "0.999", "500", "101", "100.5", "1e400", "NaN", "Infinity", ""])(
      "target %j is rejected by native validation without a write",
      async (value) => {
        const updateQuest = vi.fn(realActions.updateQuest);
        useCommandStore.setState({ updateQuest });
        render(<QuestMatrixPanel />);
        fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

        const form = editForm("Launch");
        fireEvent.change(targetInput(form), { target: { value } });
        expect(targetInput(form)).toBeInvalid();

        fireEvent.click(within(form).getByRole("button", { name: "Save" }));
        // The handler checks again when the submit event bypasses validation.
        fireEvent.submit(form);

        expect(updateQuest).not.toHaveBeenCalled();
        expect(editForm("Launch")).toBeInTheDocument();
        const row = await inAct(() => db.quests.get("quest-0"));
        expect(row?.targetWeeklyHours).toBe(10);
        expect(row?.updatedAt).toBe(T0);
      }
    );

    it.each(["", "   "])("title %j is rejected without a write", async (value) => {
      const updateQuest = vi.fn(realActions.updateQuest);
      useCommandStore.setState({ updateQuest });
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

      const form = editForm("Launch");
      const title = within(form).getByLabelText("Quest Title");
      fireEvent.change(title, { target: { value } });
      expect(title).toBeInvalid();
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));
      fireEvent.submit(form);

      expect(updateQuest).not.toHaveBeenCalled();
      expect((await inAct(() => db.quests.get("quest-0")))?.title).toBe("Launch");
    });

    it.each([
      ["1", 1],
      ["100", 100],
      ["2.5", 2.5],
    ])("boundary target %j saves as %d", async (value, expected) => {
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      const form = editForm("Launch");
      fireEvent.change(targetInput(form), { target: { value } });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      await waitFor(async () =>
        expect((await db.quests.get("quest-0"))?.targetWeeklyHours).toBe(expected)
      );
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    });

    it("a 10,000-character title with HTML and emoji saves as clamped plain text", async () => {
      const head = '<img src=x onerror="alert(1)">👨‍👩‍👧‍👦';
      const typed = `  ${head}${"x".repeat(10_000)}  `;
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      const form = editForm("Launch");
      fireEvent.change(within(form).getByLabelText("Quest Title"), {
        target: { value: typed },
      });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
      const saved = (await inAct(() => db.quests.get("quest-0")))?.title ?? "";
      expect(saved.startsWith(head)).toBe(true);
      expect(saved.length).toBeLessThanOrEqual(MAX_QUEST_TITLE_LENGTH);
      expect(await screen.findByRole("heading", { level: 2, name: saved })).toBeInTheDocument();
      expect(card("quest-0").querySelector("img")).toBeNull();
    });

    it("a failed save keeps the drawer open with the edits", async () => {
      const updateQuest = vi.fn(async () => false);
      useCommandStore.setState({ updateQuest });
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      const form = editForm("Launch");
      fireEvent.change(within(form).getByLabelText("Quest Title"), {
        target: { value: "Launch v2" },
      });
      fireEvent.click(within(form).getByRole("button", { name: "Save" }));

      await settled(updateQuest);
      expect(updateQuest).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch v2");
      expect(within(form).getByRole("button", { name: "Save" })).toBeEnabled();
    });

    it("Save is disabled and aria-busy while the write runs, and 10 submits save once", async () => {
      let finish: (ok: boolean) => void = () => undefined;
      const updateQuest = vi.fn(
        () => new Promise<boolean>((resolve) => (finish = resolve))
      );
      useCommandStore.setState({ updateQuest });
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      const form = editForm("Launch");
      const save = within(form).getByRole("button", { name: "Save" });

      act(() => {
        for (let i = 0; i < 10; i++) fireEvent.click(save);
      });
      expect(updateQuest).toHaveBeenCalledTimes(1);
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute("aria-busy", "true");

      await act(async () => finish(true));
      await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
    });
  });

  describe("guarded quest delete", () => {
    beforeEach(seedTwoQuests);

    it("the first click arms with the open-task count, the second deletes", async () => {
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

      const del = within(editForm("Launch")).getByRole("button", {
        name: "Delete quest",
      });
      fireEvent.click(del);
      expect(del).toHaveAttribute("data-state", "armed");
      expect(del).toHaveAccessibleName(
        "Delete quest? 2 open tasks move to Other work"
      );
      expect(del).toHaveTextContent("Delete quest? 2 open tasks move to Other work");
      expect(del).toHaveClass("data-[state=armed]:bg-[#ff2a5f]/20");
      // deleteQuest writes its tombstone synchronously; none means no delete started.
      expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();

      fireEvent.click(del, { detail: 2 });
      expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
      expect(await inAct(() => db.quests.get("quest-0"))).toBeDefined();

      fireEvent.click(del);
      await waitFor(async () =>
        expect(await db.quests.get("quest-0")).toBeUndefined()
      );
      const tasks = await inAct(() => db.tasks.where("questId").equals("quest-0").count());
      expect(tasks).toBe(0);
      expect((await inAct(() => db.tasks.get("tsk-a")))?.questId).toBeNull();
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Edit quest Launch" })).toBeNull()
      );
      expect(screen.queryByRole("form")).toBeNull();
    });

    it("names one open task in the singular, and none without a count", async () => {
      await seed({ quests: [makeQuest("quest-2", "Empty", 2)] });
      render(<QuestMatrixPanel />);
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Write" }));
      const del = within(editForm("Write")).getByRole("button", { name: "Delete quest" });
      fireEvent.click(del);
      expect(del).toHaveAccessibleName("Delete quest? 1 open task moves to Other work");

      fireEvent.click(editToggle("Empty"));
      const delEmpty = within(editForm("Empty")).getByRole("button", {
        name: "Delete quest",
      });
      fireEvent.click(delEmpty);
      expect(delEmpty).toHaveAccessibleName("Delete quest?");
      expect(await inAct(() => db.quests.count())).toBe(3);
    });
  });

  describe("create guards", () => {
    beforeEach(seedTwoQuests);

    it("10 clicks on Create Quest in one tick create one quest", async () => {
      const createQuest = vi.fn(realActions.createQuest);
      useCommandStore.setState({ createQuest });
      render(<QuestMatrixPanel />);
      await screen.findByRole("button", { name: "Edit quest Launch" });

      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      fireEvent.change(screen.getByLabelText("Quest Title"), {
        target: { value: "  Ship it  " },
      });
      const submit = screen.getByRole("button", { name: "Create Quest" });
      act(() => {
        for (let i = 0; i < 10; i++) fireEvent.click(submit);
      });

      expect(createQuest).toHaveBeenCalledTimes(1);
      expect(createQuest).toHaveBeenCalledWith({
        title: "Ship it",
        description: "",
        accentColor: "cyan",
        targetWeeklyHours: 10,
      });
      // Cleared while the write runs, so Create Quest is disabled meanwhile.
      expect(screen.getByLabelText("Quest Title")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Create Quest" })).toBeDisabled();

      await settled(createQuest);
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Create Quest" })).toBeNull()
      );
      expect(
        await inAct(() => db.quests.filter((q) => q.title === "Ship it").count())
      ).toBe(1);
      // Reopened, the form starts empty.
      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      expect(screen.getByLabelText("Quest Title")).toHaveValue("");
    });

    it("an invalid weekly target blocks Create Quest", async () => {
      const createQuest = vi.fn(realActions.createQuest);
      useCommandStore.setState({ createQuest });
      render(<QuestMatrixPanel />);
      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      fireEvent.change(screen.getByLabelText("Quest Title"), {
        target: { value: "Ship it" },
      });
      const target = screen.getByRole("spinbutton", { name: "Weekly target hours" });
      for (const value of ["", "0", "500"]) {
        fireEvent.change(target, { target: { value } });
        fireEvent.click(screen.getByRole("button", { name: "Create Quest" }));
      }
      expect(createQuest).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Ship it");
    });

    it("10 Enters (and Plus clicks) in quick-add create one task", async () => {
      const createTask = vi.fn(realActions.createTask);
      useCommandStore.setState({ createTask });
      render(<QuestMatrixPanel />);
      const input = await screen.findByRole("textbox", {
        name: "Add quest work to Launch",
      });
      fireEvent.change(input, { target: { value: "Quick one" } });
      const plus = screen.getByRole("button", { name: "Add task to Launch" });
      act(() => {
        for (let i = 0; i < 10; i++) {
          fireEvent.keyDown(input, { key: "Enter" });
          fireEvent.click(plus);
        }
      });

      expect(createTask).toHaveBeenCalledTimes(1);
      expect(createTask).toHaveBeenCalledWith({
        title: "Quick one",
        questId: "quest-0",
        promoteToTop: false,
      });
      expect(input).toHaveValue("");
      await settled(createTask);
      await waitFor(() =>
        expect(within(card("quest-0")).getByText("Quick one")).toBeInTheDocument()
      );
      expect(await inAct(() => db.tasks.filter((t) => t.title === "Quick one").count())).toBe(1);
    });

    it("a failed create gives the typed text back", async () => {
      const createQuest = vi.fn(async () => false);
      const createTask = vi.fn(async () => false);
      useCommandStore.setState({ createQuest, createTask });
      render(<QuestMatrixPanel />);

      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      fireEvent.change(screen.getByLabelText("Quest Title"), {
        target: { value: "Ship it" },
      });
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "Soon" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create Quest" }));
      await settled(createQuest);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Ship it");
      expect(screen.getByLabelText("Description")).toHaveValue("Soon");

      const input = await screen.findByRole("textbox", {
        name: "Add quest work to Launch",
      });
      fireEvent.change(input, { target: { value: "Quick one" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settled(createTask);
      expect(input).toHaveValue("Quick one");
    });

    it("the New Quest form asks before discarding typed text", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<QuestMatrixPanel />);
      const toggle = screen.getByRole("button", { name: "New Quest" });

      // Pristine: Cancel closes without a prompt.
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(confirm).not.toHaveBeenCalled();

      fireEvent.click(toggle);
      fireEvent.change(screen.getByLabelText("Quest Title"), {
        target: { value: "Half typed" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(toggle);
      fireEvent.keyDown(screen.getByLabelText("Quest Title"), { key: "Escape" });
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(confirm).toHaveBeenLastCalledWith(DISCARD_PROMPT);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Half typed");

      confirm.mockReturnValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByLabelText("Quest Title")).toBeNull();
      expect(toggle).toHaveFocus();
      fireEvent.click(toggle);
      expect(screen.getByLabelText("Quest Title")).toHaveValue("");
    });
  });

  describe("task rows", () => {
    beforeEach(seedTwoQuests);

    it("the second click of a double-click on a check mark is ignored", async () => {
      const completeTaskById = vi.fn(realActions.completeTaskById);
      useCommandStore.setState({ completeTaskById });
      render(<QuestMatrixPanel />);
      await waitFor(() =>
        expect(
          within(card("quest-0")).getAllByRole("button", { name: "Mark complete" })
        ).toHaveLength(2)
      );

      const [first] = within(card("quest-0")).getAllByRole("button", {
        name: "Mark complete",
      });
      fireEvent.click(first, { detail: 1 });
      fireEvent.click(first, { detail: 2 });
      expect(completeTaskById).toHaveBeenCalledTimes(1);
      expect(completeTaskById).toHaveBeenCalledWith("tsk-a");
      await settled(completeTaskById);

      const status = await inAct(statusById);
      expect(status.get("tsk-a")).toBe("completed");
      expect(status.get("tsk-b")).toBe("queued");
      expect(first).toHaveClass("transition-colors", "duration-150", "active:opacity-80");
    });

    it("a task's play button starts focus on it", async () => {
      const initializeFocus = vi.fn(async () => undefined);
      useCommandStore.setState({ initializeFocus });
      render(<QuestMatrixPanel />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Start focus: Bravo" })
      );
      expect(initializeFocus).toHaveBeenCalledWith("tsk-b");
    });
  });

  describe("a11y, edge data and layout contracts", () => {
    beforeEach(seedTwoQuests);

    it("ties 'Quest Title' and 'Description' to their inputs in both forms", async () => {
      render(<QuestMatrixPanel />);
      await screen.findByRole("button", { name: "Edit quest Launch" });

      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      expect(screen.getByLabelText("Quest Title")).toHaveAttribute(
        "placeholder",
        "e.g. Launch my idea"
      );
      expect(screen.getByLabelText("Description")).toHaveAttribute(
        "placeholder",
        "What moves this quest forward?"
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

      fireEvent.click(editToggle("Launch"));
      expect(screen.getByLabelText("Quest Title")).toHaveValue("Launch");
      expect(screen.getByLabelText("Description")).toHaveValue("Ship it");

      // Both open at once: two distinct ids.
      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      const titles = screen.getAllByLabelText("Quest Title");
      expect(titles).toHaveLength(2);
      expect(new Set(titles.map((t) => t.id)).size).toBe(2);
      expect(screen.getAllByLabelText("Description")).toHaveLength(2);
    });

    it("every button and input has an accessible name; pills and toggles expose their state", async () => {
      render(<QuestMatrixPanel />);
      const newQuest = screen.getByRole("button", { name: "New Quest" });
      expect(newQuest).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(newQuest);
      expect(newQuest).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));

      for (const button of screen.getAllByRole("button")) {
        expect(button).toHaveAccessibleName();
      }
      for (const input of [
        ...screen.getAllByRole("textbox"),
        ...screen.getAllByRole("spinbutton"),
      ]) {
        expect(input).toHaveAccessibleName();
      }

      const createPills = screen.getAllByRole("group", { name: "Quest color" })[0];
      const cyan = within(createPills).getByRole("button", { name: "Cyan" });
      const emerald = within(createPills).getByRole("button", { name: "Emerald" });
      expect(cyan).toHaveAttribute("aria-pressed", "true");
      expect(emerald).toHaveAttribute("aria-pressed", "false");
      fireEvent.click(emerald);
      expect(cyan).toHaveAttribute("aria-pressed", "false");
      expect(emerald).toHaveAttribute("aria-pressed", "true");
      expect(emerald).toHaveClass("transition-colors", "duration-150", "active:opacity-80");
    });

    it("focus is visible on the number inputs and the quick-add field", async () => {
      const { container } = render(<QuestMatrixPanel />);
      fireEvent.click(screen.getByRole("button", { name: "New Quest" }));
      fireEvent.click(await screen.findByRole("button", { name: "Edit quest Launch" }));
      expectVisibleFocus(container);

      const targets = screen.getAllByRole("spinbutton", { name: "Weekly target hours" });
      expect(targets).toHaveLength(2);
      for (const input of targets) {
        expect(input).toHaveClass("focus:border-hud-cyan");
      }
      const quickAdd = screen.getByRole("textbox", { name: "Add quest work to Launch" });
      expect(quickAdd.parentElement).toHaveClass("focus-within:border-white/40");
      expect(quickAdd).toHaveClass("placeholder:text-hud-muted");
      expect(
        within(editForm("Launch")).getByRole("button", { name: "Save" })
      ).toHaveClass("transition-colors", "duration-150", "active:opacity-80");
    });

    it("Quest Hours (7d) count today and the 6 days before, not older logs", async () => {
      const today = toLocalDateKey();
      const old = Array.from({ length: 2000 }, (_, i) =>
        makeLog(`log-old-${i}`, dateKeyFromOffset(today, -9 - (i % 60)), "quest-0", 3600)
      );
      await seed({
        logs: [
          makeLog("log-today", today, "quest-0", 1800),
          makeLog("log-6", dateKeyFromOffset(today, -6), "quest-0", 1800),
          makeLog("log-7", dateKeyFromOffset(today, -7), "quest-0", 3600),
          makeLog("log-8", dateKeyFromOffset(today, -8), "quest-0", 3600),
          makeLog("log-write", today, "quest-1", 7200),
          makeLog("log-other", today, null, 3600),
          ...old,
        ],
      });
      render(<QuestMatrixPanel />);

      await waitFor(() =>
        expect(within(card("quest-0")).getByText("1.0h")).toBeInTheDocument()
      );
      expect(within(card("quest-1")).getByText("2.0h")).toBeInTheDocument();
    });

    it("renders a quest with an unknown accent ('violet') in the slate style", async () => {
      await seed({
        quests: [
          makeQuest("quest-v", "Violet quest", 2, {
            accentColor: "violet" as unknown as QuestAccent,
          }),
        ],
        tasks: [makeTask("tsk-v", "Violet task", "quest-v", 9000)],
      });
      render(<QuestMatrixPanel />);
      const title = await screen.findByRole("heading", { level: 2, name: "Violet quest" });
      expect(title.previousElementSibling).toHaveClass(QUEST_ACCENT_STYLES.slate.bg);
      expect(within(card("quest-v")).getByText("Violet task")).toBeInTheDocument();
      // No logs this week: once loaded, the hours read 0.0h (not the loading dash).
      expect(await within(card("quest-v")).findByText("0.0h")).toBeInTheDocument();
      expect(within(card("quest-v")).getByText("Next Steps (1)")).toBeInTheDocument();

      // The drawer opens; no accent pill claims to be selected.
      fireEvent.click(editToggle("Violet quest"));
      expect(
        within(editForm("Violet quest")).queryAllByRole("button", { pressed: true })
      ).toHaveLength(0);
    });

    it("a 200-character unbroken title wraps and keeps the Edit button in place", async () => {
      const long = "W".repeat(200);
      await seed({
        quests: [makeQuest("quest-long", long, 2, { description: "D".repeat(300) })],
        tasks: [makeTask("tsk-long", "T".repeat(200), "quest-long", 9000)],
      });
      render(<QuestMatrixPanel />);

      const title = await screen.findByRole("heading", { level: 2, name: long });
      expect(title).toHaveClass("min-w-0", "break-words");
      expect(title.parentElement).toHaveClass("min-w-0");
      expect(editToggle(long)).toHaveClass("shrink-0");
      expect(screen.getByText("D".repeat(300))).toHaveClass("break-words");
      expect(card("quest-long")).toHaveClass("min-w-0");
      const taskTitle = within(card("quest-long")).getByText("T".repeat(200));
      expect(taskTitle).toHaveClass("truncate");
      expect(taskTitle).toHaveAttribute("title", "T".repeat(200));
    });

    it("completes a quest with two-step confirmation into Completed Quests with logged hours, and reopens it", async () => {
      const today = toLocalDateKey();
      // seedTwoQuests already seeded quest-0 ("Launch" with tsk-a, tsk-b) and quest-1 ("Write" with tsk-c).
      await seed({
        quests: [makeQuest("quest-2", "Empty Quest", 2)],
        tasks: [
          makeTask("tsk-done-1", "Already done", "quest-0", 3000, {
            status: "completed",
            completedAt: Date.now(),
          }),
        ],
        logs: [makeLog("log-q0", today, "quest-0", 5400)], // 1.5h
      });

      render(<QuestMatrixPanel />);
      await screen.findByRole("heading", { level: 2, name: "Launch" });

      // Empty quest shows "Complete quest?" without open-task suffix when armed
      const emptyComplete = screen.getByRole("button", {
        name: "Complete quest Empty Quest",
      });
      fireEvent.click(emptyComplete);
      expect(emptyComplete).toHaveAttribute("data-state", "armed");
      expect(emptyComplete).toHaveAccessibleName("Complete quest?");

      // Quest with 2 open tasks announces how many open tasks move to Other work
      const launchComplete = screen.getByRole("button", {
        name: "Complete quest Launch",
      });
      fireEvent.click(launchComplete);
      expect(launchComplete).toHaveAttribute("data-state", "armed");
      expect(launchComplete).toHaveAccessibleName(
        "Complete quest? 2 open tasks move to Other work"
      );

      // Rapid double-click second event (detail=2) is ignored while armed
      fireEvent.click(launchComplete, { detail: 2 });
      expect((await inAct(() => db.quests.get("quest-0")))?.archived).toBe(false);

      // Deliberate second click completes the quest
      fireEvent.click(launchComplete);
      await waitFor(async () =>
        expect((await db.quests.get("quest-0"))?.archived).toBe(true)
      );

      // Open tasks moved to Other work (null); completed task keeps quest-0
      expect((await inAct(() => db.tasks.get("tsk-a")))?.questId).toBeNull();
      expect((await inAct(() => db.tasks.get("tsk-b")))?.questId).toBeNull();
      expect((await inAct(() => db.tasks.get("tsk-done-1")))?.questId).toBe("quest-0");

      // Renders in Completed Quests section with 1.5h logged and Reopen button
      const completedSection = await screen.findByRole("region", {
        name: "Completed Quests",
      });
      expect(
        within(completedSection).getByRole("heading", { level: 3, name: "Launch" })
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(within(completedSection).getByText("1.5h logged")).toBeInTheDocument()
      );

      // Reopen moves it back to Active Quests
      fireEvent.click(
        within(completedSection).getByRole("button", { name: "Reopen quest Launch" })
      );
      await waitFor(async () =>
        expect((await db.quests.get("quest-0"))?.archived).toBe(false)
      );
      expect(
        await screen.findByRole("heading", { level: 2, name: "Launch" })
      ).toBeInTheDocument();
      expect(screen.queryByRole("region", { name: "Completed Quests" })).toBeNull();
    });
  });
});
