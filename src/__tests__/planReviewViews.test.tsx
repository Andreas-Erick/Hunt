import React from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
  within,
} from "@testing-library/react";
import { db } from "@/lib/db";
import { dateFromKey } from "@/lib/dateUtils";
import type { Quest, QuestAccent, Task, TimeLog } from "@/lib/domainTypes";
import { MAX_TASK_TITLE_LENGTH } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { PlanWeekView } from "@/components/PlanWeekView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { CONFIRM_DELETE_DISARM_MS } from "@/components/ConfirmDeleteButton";

const TOMBSTONE_KEY = "hunt-sync-tombstones-v1";
const DAY_MS = 86_400_000;
/** Fixed creation/update stamp, so a rewrite of a row is visible in updatedAt. */
const T0 = 1_700_000_000_000;

// Real store actions, restored after tests that replace them with spies.
const realActions = (() => {
  const s = useCommandStore.getState();
  return {
    syncNow: s.syncNow,
    requestSync: s.requestSync,
    createTask: s.createTask,
    updateTask: s.updateTask,
    deleteTask: s.deleteTask,
    deleteTimeLog: s.deleteTimeLog,
    completeTaskById: s.completeTaskById,
    reopenTaskById: s.reopenTaskById,
    initializeFocus: s.initializeFocus,
  };
})();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeQuest(
  id: string,
  title: string,
  slotIndex: 0 | 1 | 2,
  targetWeeklyHours = 10
): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeTask(
  id: string,
  title: string,
  questId: string | null,
  rank: number,
  scheduledDate: string,
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
    scheduledDate,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeLog(
  id: string,
  dateKey: string,
  questId: string | null,
  durationSeconds: number,
  minuteOfDay = 0
): TimeLog {
  const startTime = dateFromKey(dateKey).getTime() + minuteOfDay * 60_000;
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

// ---------------------------------------------------------------------------
// Calendar maths independent of the code under test (UTC has no DST)
// ---------------------------------------------------------------------------
function utcDayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function addDaysUtc(key: string, days: number): string {
  const d = new Date((utcDayNumber(key) + days) * DAY_MS);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

function expectConsecutiveDays(
  keys: string[],
  length: number,
  lastKey: string,
  context: string
) {
  const msg = `${context}: [${keys.join(", ")}]`;
  expect(keys, msg).toHaveLength(length);
  expect(new Set(keys).size, msg).toBe(length);
  for (let i = 1; i < keys.length; i++) {
    expect(utcDayNumber(keys[i]) - utcDayNumber(keys[i - 1]), msg).toBe(1);
  }
  expect(keys[keys.length - 1], msg).toBe(lastKey);
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

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const dayColumns = () => screen.getAllByTestId("day-column");
const planKeys = () => dayColumns().map((c) => c.dataset.dateKey ?? "");
const reviewKeys = () =>
  screen.getAllByTestId("review-day").map((c) => c.dataset.dateKey ?? "");

function column(dateKey: string): HTMLElement {
  const found = dayColumns().find((c) => c.dataset.dateKey === dateKey);
  if (!found) throw new Error(`No column ${dateKey} in [${planKeys().join(", ")}]`);
  return found;
}

function taskRow(taskId: string): HTMLElement {
  const found = screen
    .getAllByTestId("task-row")
    .find((r) => r.dataset.taskId === taskId);
  if (!found) throw new Error(`No task row for ${taskId}`);
  return found;
}

function sessionRow(logId: string): HTMLElement {
  const found = screen
    .getAllByTestId("session-row")
    .find((r) => r.dataset.logId === logId);
  if (!found) throw new Error(`No session row for ${logId}`);
  return found;
}

/** A Review KPI card, found by its heading (the first one with that text). */
const kpiCard = (label: string): HTMLElement => {
  const card = screen.getAllByText(label)[0].parentElement;
  if (!card) throw new Error(`No card for ${label}`);
  return card;
};

/**
 * An IndexedDB read inside act. A write makes Dexie re-run the view's live
 * queries (optimistically, then again after the commit), and a re-render that
 * lands during a bare await would happen outside act.
 */
async function dbRead<T>(read: () => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  await act(async () => {
    result = { value: await read() };
  });
  if (!result) throw new Error("dbRead: the read did not finish");
  return result.value;
}

const readTombstones = () =>
  JSON.parse(window.localStorage.getItem(TOMBSTONE_KEY) ?? "{}") as {
    deletedTaskIds?: string[];
    deletedLogIds?: string[];
  };

const duplicateKeyWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((args) =>
    args.some((a) => typeof a === "string" && a.includes("same key"))
  );

/** Re-installs fake timers with setTimeout faked too, keeping the clock. */
function fakeTimeoutsAt(now: Date) {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(now);
}

/** The view's own add box for a day: its input and its two buttons. */
function addBox(dateKey: string, weekday: string) {
  const col = column(dateKey);
  return {
    input: within(col).getByRole("textbox", { name: `Add task for ${weekday}` }),
    top: within(col).getByRole("button", { name: "Add to top" }),
    bottom: within(col).getByRole("button", { name: "Add to bottom" }),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
let savedTz: string | undefined;
let savedZone = "UTC";

beforeAll(() => {
  savedTz = process.env.TZ;
  savedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = "Europe/Berlin";
});

afterAll(() => {
  // Deleting TZ alone does not reset Node's zone cache (seen on Node 24 /
  // Windows), so the original zone is assigned back first.
  process.env.TZ = savedTz ?? savedZone;
  if (savedTz === undefined) delete process.env.TZ;
});

/** Local wall-clock time in Europe/Berlin (TZ is set before any test runs). */
const at = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m, d, h, min);
/** Monday 2026-03-30, noon: Plan shows Sat 03-28 … Wed 04-01. */
const monday = () => at(2026, 2, 30, 12);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(monday());
  await db.quests.clear();
  await db.tasks.clear();
  await db.timeLogs.clear();
  window.localStorage.removeItem(TOMBSTONE_KEY);
  useCommandStore.setState({
    activeView: "plan",
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
});

describe("DST-safe day columns (Europe/Berlin)", () => {
  it("runs on a clock that really switches DST (guards against a no-op TZ)", () => {
    expect(at(2026, 2, 29, 1).getTimezoneOffset()).toBe(-60);
    expect(at(2026, 2, 29, 4).getTimezoneOffset()).toBe(-120);
    expect(at(2026, 9, 25, 4).getTimezoneOffset()).toBe(-60);
  });

  it("the duplicate-key check below does see React's warning (positive control)", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ul>
        {["same", "same"].map((k, i) => (
          <li key={k}>{i}</li>
        ))}
      </ul>
    );
    expect(duplicateKeyWarnings(errors).length).toBeGreaterThan(0);
  });

  it.each([
    { when: "00:30 on 2026-03-30 (just after spring-forward)", time: [2026, 2, 30, 0, 30], today: "2026-03-30" },
    { when: "00:30 on 2026-10-25 (fall-back day)", time: [2026, 9, 25, 0, 30], today: "2026-10-25" },
    { when: "23:30 on 2026-03-28 (night before spring-forward)", time: [2026, 2, 28, 23, 30], today: "2026-03-28" },
  ] as const)(
    "at $when Plan shows 5 and Review 7 distinct consecutive days, also after navigating",
    async ({ when, time, today }) => {
      const [y, m, d, h, min] = time;
      vi.setSystemTime(at(y, m, d, h, min));
      const errors = vi.spyOn(console, "error");

      render(<PlanWeekView />);
      // Loaded: the two past columns say so instead of staying blank.
      expect(await screen.findAllByText("Nothing planned")).toHaveLength(2);
      let offset = 0;
      expectConsecutiveDays(planKeys(), 5, addDaysUtc(today, 2), `Plan ${when}`);
      expect(column(today).textContent).toContain(String(Number(today.slice(8))));
      for (const step of [1, 1, 1, -1, -1, -1, -1, -1, -1]) {
        fireEvent.click(
          screen.getByRole("button", { name: step > 0 ? "Next day" : "Previous day" })
        );
        offset += step;
        expectConsecutiveDays(
          planKeys(),
          5,
          addDaysUtc(today, offset + 2),
          `Plan ${when}, offset ${offset}`
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "Today" }));
      expectConsecutiveDays(planKeys(), 5, addDaysUtc(today, 2), `Plan ${when}, Today`);
      cleanup();

      render(<TelemetryDashboardView />);
      await screen.findByText(/View Session Log \(0 sessions this week\)/);
      expectConsecutiveDays(reviewKeys(), 7, today, `Review ${when}`);
      const next = screen.getByRole("button", { name: "Next week" });
      expect(next).toBeDisabled();
      for (let week = 1; week <= 3; week++) {
        fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
        expectConsecutiveDays(
          reviewKeys(),
          7,
          addDaysUtc(today, -7 * week),
          `Review ${when}, week -${week}`
        );
      }
      expect(next).toBeEnabled();
      fireEvent.click(next);
      expectConsecutiveDays(reviewKeys(), 7, addDaysUtc(today, -14), `Review ${when}, back to -2`);
      fireEvent.click(screen.getByRole("button", { name: "This week" }));
      expectConsecutiveDays(reviewKeys(), 7, today, `Review ${when}, This week`);

      expect(duplicateKeyWarnings(errors)).toEqual([]);
    }
  );

  it("seeded random navigation around both DST changes keeps every window whole", () => {
    const seedValue = 20261025;
    const rand = mulberry32(seedValue);
    const errors = vi.spyOn(console, "error");

    for (const [y, m, d, h, min] of [
      [2026, 2, 29, 2, 30],
      [2026, 9, 25, 2, 30],
    ] as const) {
      vi.setSystemTime(at(y, m, d, h, min));
      const today = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

      render(<PlanWeekView />);
      let offset = 0;
      for (let step = 0; step < 120; step++) {
        const r = rand();
        const name = r < 0.45 ? "Next day" : r < 0.9 ? "Previous day" : "Today";
        fireEvent.click(screen.getByRole("button", { name }));
        offset = name === "Today" ? 0 : offset + (name === "Next day" ? 1 : -1);
        expectConsecutiveDays(
          planKeys(),
          5,
          addDaysUtc(today, offset + 2),
          `seed ${seedValue}, Plan step ${step} (${name}) from ${today}`
        );
      }
      cleanup();

      render(<TelemetryDashboardView />);
      let week = 0;
      for (let step = 0; step < 60; step++) {
        const r = rand();
        const name = r < 0.55 ? "Previous week" : r < 0.9 ? "Next week" : "This week";
        fireEvent.click(screen.getByRole("button", { name }));
        week = name === "This week" ? 0 : Math.min(0, week + (name === "Next week" ? 1 : -1));
        expectConsecutiveDays(
          reviewKeys(),
          7,
          addDaysUtc(today, 7 * week),
          `seed ${seedValue}, Review step ${step} (${name}) from ${today}`
        );
      }
      cleanup();
    }
    expect(duplicateKeyWarnings(errors), `seed ${seedValue}`).toEqual([]);
  });
});

describe("Plan: adding a task to a day", () => {
  beforeEach(async () => {
    await seed({ quests: [makeQuest("quest-0", "Launch", 0)] });
  });

  const loaded = () => screen.findByRole("button", { name: "Launch", pressed: true });
  const tasksTitled = (title: string) =>
    db.tasks.filter((t) => t.title === title).toArray();

  it("only today and later have an add box; its buttons are disabled while the input is empty or blank", async () => {
    render(<PlanWeekView />);
    await loaded();

    expect(within(column("2026-03-28")).queryByRole("textbox")).toBeNull();
    expect(within(column("2026-03-29")).queryByRole("textbox")).toBeNull();

    const tue = addBox("2026-03-31", "Tuesday");
    const wed = addBox("2026-04-01", "Wednesday");
    for (const value of ["", "   ", "\t\n"]) {
      fireEvent.change(tue.input, { target: { value } });
      expect(tue.top).toBeDisabled();
      expect(tue.bottom).toBeDisabled();
      expect(tue.top).toHaveClass("disabled:opacity-40", "disabled:cursor-not-allowed");
    }

    fireEvent.change(tue.input, { target: { value: "x" } });
    expect(tue.top).toBeEnabled();
    expect(tue.bottom).toBeEnabled();
    // Each day has its own input.
    expect(wed.top).toBeDisabled();
    expect(addBox("2026-03-30", "Monday").top).toBeDisabled();
  });

  it("10 clicks in one tick create exactly one trimmed task on that day, and the input is cleared first", async () => {
    const createTask = vi.fn(realActions.createTask);
    useCommandStore.setState({ createTask });
    render(<PlanWeekView />);
    await loaded();

    const { input, bottom } = addBox("2026-03-31", "Tuesday");
    fireEvent.change(input, { target: { value: "  Ship it  " } });
    act(() => {
      for (let i = 0; i < 10; i++) bottom.click();
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith({
      title: "Ship it",
      questId: "quest-0",
      promoteToTop: false,
      scheduledDate: "2026-03-31",
    });
    expect(input).toHaveValue("");
    expect(bottom).toBeDisabled();
    await act(async () => {
      await createTask.mock.results[0].value;
    });

    expect(
      await within(column("2026-03-31")).findByRole("button", { name: "Ship it" })
    ).toBeInTheDocument();
    for (let i = 0; i < 10; i++) fireEvent.click(bottom);
    expect(createTask).toHaveBeenCalledTimes(1);
    const created = await dbRead(() => tasksTitled("Ship it"));
    expect(created).toHaveLength(1);
    expect(created[0].scheduledDate).toBe("2026-03-31");
  });

  it("10 Enter keydowns in one tick create exactly one task (added to the top)", async () => {
    const createTask = vi.fn(realActions.createTask);
    useCommandStore.setState({ createTask });
    render(<PlanWeekView />);
    await loaded();

    const { input } = addBox("2026-03-30", "Monday");
    fireEvent.change(input, { target: { value: "Write the brief" } });
    act(() => {
      for (let i = 0; i < 10; i++) {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
        );
      }
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({ promoteToTop: true, scheduledDate: "2026-03-30" })
    );
    await act(async () => {
      await createTask.mock.results[0].value;
    });
    expect(
      await within(column("2026-03-30")).findByRole("button", { name: "Write the brief" })
    ).toBeInTheDocument();
    expect(await dbRead(() => tasksTitled("Write the brief"))).toHaveLength(1);
  });

  it("the in-flight guard is per day: two days can add at the same time", async () => {
    const createTask = vi.fn(realActions.createTask);
    useCommandStore.setState({ createTask });
    render(<PlanWeekView />);
    await loaded();

    const mon = addBox("2026-03-30", "Monday");
    const tue = addBox("2026-03-31", "Tuesday");
    fireEvent.change(mon.input, { target: { value: "Monday job" } });
    fireEvent.change(tue.input, { target: { value: "Tuesday job" } });
    act(() => {
      mon.top.click();
      mon.top.click();
      tue.top.click();
      tue.top.click();
    });

    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls.map((c) => c[0].scheduledDate)).toEqual([
      "2026-03-30",
      "2026-03-31",
    ]);
    await act(async () => {
      await Promise.all(createTask.mock.results.map((r) => r.value));
    });
    expect(
      await within(column("2026-03-30")).findByRole("button", { name: "Monday job" })
    ).toBeInTheDocument();
    expect(
      await within(column("2026-03-31")).findByRole("button", { name: "Tuesday job" })
    ).toBeInTheDocument();
    expect(await dbRead(() => db.tasks.count())).toBe(2);
  });

  it("gives the typed title back when the local write fails, unless something new was typed", async () => {
    let resolveWrite: (ok: boolean) => void = () => undefined;
    const createTask = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveWrite = resolve))
    );
    useCommandStore.setState({ createTask });
    render(<PlanWeekView />);
    await loaded();

    const { input, top } = addBox("2026-03-30", "Monday");
    fireEvent.change(input, { target: { value: "Keep me" } });
    fireEvent.click(top);
    expect(input).toHaveValue("");
    await act(async () => resolveWrite(false));
    expect(input).toHaveValue("Keep me");
    expect(top).toBeEnabled();

    fireEvent.click(top);
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: "Typed meanwhile" } });
    await act(async () => resolveWrite(false));
    expect(input).toHaveValue("Typed meanwhile");
    expect(createTask).toHaveBeenCalledTimes(2);
  });

  it("an unmount while the add is in flight leaves no error behind", async () => {
    let resolveWrite: (ok: boolean) => void = () => undefined;
    const createTask = vi.fn(
      () => new Promise<boolean>((resolve) => (resolveWrite = resolve))
    );
    useCommandStore.setState({ createTask });
    const errors = vi.spyOn(console, "error");
    const view = render(<PlanWeekView />);
    await loaded();

    const { input, top } = addBox("2026-03-30", "Monday");
    fireEvent.change(input, { target: { value: "Interrupted" } });
    fireEvent.click(top);
    view.unmount();
    await act(async () => resolveWrite(false));
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps hostile and huge titles as plain text (store clamps the length)", async () => {
    const createTask = vi.fn(realActions.createTask);
    useCommandStore.setState({ createTask });
    render(<PlanWeekView />);
    await loaded();
    const { input, top } = addBox("2026-03-30", "Monday");

    const hostile = "<script>alert(1)</script> 👨‍👩‍👧‍👦 שלום";
    fireEvent.change(input, { target: { value: hostile } });
    fireEvent.click(top);
    // The row can render optimistically before the write commits; the day's
    // next add is only accepted once this one has finished.
    await act(async () => {
      await createTask.mock.results[0].value;
    });
    expect(
      await within(column("2026-03-30")).findByRole("button", { name: hostile })
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();

    fireEvent.change(input, { target: { value: "x".repeat(10_000) } });
    fireEvent.click(top);
    expect(createTask).toHaveBeenCalledTimes(2);
    await act(async () => {
      await createTask.mock.results[1].value;
    });
    await waitFor(async () =>
      expect(await db.tasks.count()).toBe(2)
    );
    const huge = (await dbRead(() => db.tasks.toArray())).find((t) =>
      t.title.startsWith("xx")
    );
    expect(huge?.title).toHaveLength(MAX_TASK_TITLE_LENGTH);
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(2));
  });
});

describe("guarded deletes", () => {
  it("Plan: the first click arms, the second click of a double-click is ignored, the next click deletes and records the tombstone", async () => {
    await seed({
      tasks: [
        makeTask("tsk-a", "Alpha", null, 1000, "2026-03-30"),
        makeTask("tsk-b", "Bravo", null, 2000, "2026-03-30"),
      ],
    });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });

    const del = within(taskRow("tsk-a")).getByRole("button", { name: "Delete task" });
    expect(del).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100",
      "focus-visible:opacity-100",
      "data-[state=armed]:opacity-100",
      // never hover-only; touch (no hover) always sees it, muted.
      "hoverless:opacity-60"
    );

    fireEvent.click(del);
    expect(del).toHaveAttribute("data-state", "armed");
    expect(del).toHaveAccessibleName("Confirm delete?");
    // deleteTask writes the tombstone synchronously, so its absence proves no
    // delete started.
    expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
    expect(await db.tasks.get("tsk-a")).toBeDefined();

    fireEvent.click(del, { detail: 2 });
    expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();

    fireEvent.click(del);
    await waitFor(async () => expect(await db.tasks.get("tsk-a")).toBeUndefined());
    expect(readTombstones().deletedTaskIds).toEqual(["tsk-a"]);
    expect(await dbRead(() => db.tasks.get("tsk-b"))).toBeDefined();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull()
    );
  });

  it("Plan: 4 s without a second click disarm the button and nothing is deleted", async () => {
    await seed({ tasks: [makeTask("tsk-a", "Alpha", null, 1000, "2026-03-30")] });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });
    // Dexie's live queries use setTimeout too, so it is faked only now.
    fakeTimeoutsAt(monday());

    const del = within(taskRow("tsk-a")).getByRole("button", { name: "Delete task" });
    fireEvent.click(del);
    expect(del).toHaveAttribute("data-state", "armed");
    act(() => vi.advanceTimersByTime(CONFIRM_DELETE_DISARM_MS - 1));
    expect(del).toHaveAttribute("data-state", "armed");
    act(() => vi.advanceTimersByTime(1));
    expect(del).toHaveAttribute("data-state", "idle");
    expect(del).toHaveAccessibleName("Delete task");

    // The next click arms again instead of deleting.
    fireEvent.click(del);
    expect(del).toHaveAttribute("data-state", "armed");
    expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
    expect(await db.tasks.get("tsk-a")).toBeDefined();
  });

  it("Review: deleting a session takes two clicks, goes through the store and records the log tombstone", async () => {
    await seed({
      logs: [
        makeLog("log-1", "2026-03-30", null, 600, 60),
        makeLog("log-2", "2026-03-29", null, 300),
      ],
    });
    const deleteTimeLog = vi.fn(realActions.deleteTimeLog);
    useCommandStore.setState({ deleteTimeLog });
    render(<TelemetryDashboardView />);

    fireEvent.click(
      await screen.findByRole("button", { name: /View Session Log \(2 sessions/ })
    );
    const del = within(sessionRow("log-1")).getByRole("button", {
      name: "Delete session",
    });
    expect(del).toHaveClass(
      "opacity-0",
      "focus-visible:opacity-100",
      "data-[state=armed]:opacity-100"
    );

    fireEvent.click(del);
    expect(del).toHaveAttribute("data-state", "armed");
    expect(deleteTimeLog).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
    expect(await db.timeLogs.get("log-1")).toBeDefined();

    // The confirming click and 8 more in the same tick delete exactly once.
    act(() => {
      for (let i = 0; i < 9; i++) del.click();
    });
    expect(deleteTimeLog).toHaveBeenCalledTimes(1);
    expect(deleteTimeLog).toHaveBeenCalledWith("log-1");
    await waitFor(async () => expect(await db.timeLogs.get("log-1")).toBeUndefined());
    expect(readTombstones().deletedLogIds).toEqual(["log-1"]);
    expect(useCommandStore.getState().requestSync).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getAllByTestId("session-row").map((r) => r.dataset.logId)).toEqual([
        "log-2",
      ])
    );
    expect(await dbRead(() => db.timeLogs.get("log-2"))).toBeDefined();
  });

  it("Review: 4 s without a second click disarm the session delete", async () => {
    await seed({ logs: [makeLog("log-1", "2026-03-30", null, 600)] });
    render(<TelemetryDashboardView />);
    fireEvent.click(
      await screen.findByRole("button", { name: /View Session Log \(1 sessions/ })
    );
    fakeTimeoutsAt(monday());

    const del = within(sessionRow("log-1")).getByRole("button", {
      name: "Delete session",
    });
    fireEvent.click(del);
    act(() => vi.advanceTimersByTime(CONFIRM_DELETE_DISARM_MS));
    expect(del).toHaveAttribute("data-state", "idle");
    expect(window.localStorage.getItem(TOMBSTONE_KEY)).toBeNull();
    expect(await db.timeLogs.get("log-1")).toBeDefined();
  });
});

describe("Plan: keyboard reschedule (Alt+Shift+←/→)", () => {
  const titleOf = (taskId: string, title: string) =>
    within(taskRow(taskId)).getByRole("button", { name: title });

  async function press(taskId: string, title: string, key: "ArrowLeft" | "ArrowRight") {
    const button = titleOf(taskId, title);
    button.focus();
    const notPrevented = fireEvent.keyDown(button, { key, altKey: true, shiftKey: true });
    expect(notPrevented).toBe(false);
  }

  async function expectOnDay(taskId: string, title: string, dateKey: string) {
    await waitFor(async () =>
      expect((await db.tasks.get(taskId))?.scheduledDate).toBe(dateKey)
    );
    await waitFor(() => expect(taskRow(taskId).dataset.dateKey).toBe(dateKey));
    // The card is re-created in its new column; the focus follows it.
    await waitFor(() => expect(document.activeElement).toBe(titleOf(taskId, title)));
  }

  it("moves a task one day at a time across spring-forward, past the right edge of the window", async () => {
    vi.setSystemTime(at(2026, 2, 28, 12)); // Saturday: window 03-26 … 03-30
    await seed({
      tasks: [
        makeTask("tsk-k", "Kayak", null, 1000, "2026-03-28"),
        makeTask("tsk-z", "Untouched", null, 2000, "2026-03-28"),
      ],
    });
    const updateTask = vi.fn(realActions.updateTask);
    useCommandStore.setState({ updateTask });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Kayak" });
    expect(
      screen.getByText("Alt+Shift+←/→ moves a task to the previous or next day")
    ).toBeInTheDocument();
    expect(titleOf("tsk-k", "Kayak")).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight"
    );

    await press("tsk-k", "Kayak", "ArrowRight");
    await expectOnDay("tsk-k", "Kayak", "2026-03-29");
    await press("tsk-k", "Kayak", "ArrowRight");
    await expectOnDay("tsk-k", "Kayak", "2026-03-30");
    expect(planKeys()).toEqual([
      "2026-03-26",
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
      "2026-03-30",
    ]);

    // At the right edge: the window follows the task.
    await press("tsk-k", "Kayak", "ArrowRight");
    await expectOnDay("tsk-k", "Kayak", "2026-03-31");
    expectConsecutiveDays(planKeys(), 5, "2026-03-31", "window after edge move");

    await press("tsk-k", "Kayak", "ArrowLeft");
    await expectOnDay("tsk-k", "Kayak", "2026-03-30");

    expect(updateTask.mock.calls.map((c) => c[1])).toEqual([
      { scheduledDate: "2026-03-29" },
      { scheduledDate: "2026-03-30" },
      { scheduledDate: "2026-03-31" },
      { scheduledDate: "2026-03-30" },
    ]);
    // Only the moved row was rewritten.
    expect((await dbRead(() => db.tasks.get("tsk-z")))?.updatedAt).toBe(T0);
  });

  it("moves back across fall-back, past the left edge of the window", async () => {
    vi.setSystemTime(at(2026, 9, 25, 12)); // window 10-23 … 10-27
    await seed({ tasks: [makeTask("tsk-f", "Fall", null, 1000, "2026-10-26")] });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Fall" });

    for (const day of ["2026-10-25", "2026-10-24", "2026-10-23", "2026-10-22"]) {
      await press("tsk-f", "Fall", "ArrowLeft");
      await expectOnDay("tsk-f", "Fall", day);
    }
    expectConsecutiveDays(planKeys(), 5, "2026-10-26", "window after edge move");
  });

  it("an undated task sits in Today and moves from there; malformed dates never reach a column or a write", async () => {
    const undated = makeTask("tsk-u", "Undated", null, 1000, "2026-03-30");
    delete (undated as Partial<Task>).scheduledDate;
    await seed({
      tasks: [
        undated,
        makeTask("tsk-bad-1", "Bad one", null, 2000, "garbage"),
        makeTask("tsk-bad-2", "Bad two", null, 3000, "2026-13-45"),
      ],
    });
    const updateTask = vi.fn(realActions.updateTask);
    useCommandStore.setState({ updateTask });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Undated" });
    expect(taskRow("tsk-u").dataset.dateKey).toBe("2026-03-30");
    expect(screen.queryByText("Bad one")).toBeNull();
    expect(screen.queryByText("Bad two")).toBeNull();
    expectConsecutiveDays(planKeys(), 5, "2026-04-01", "board with malformed dates");

    await press("tsk-u", "Undated", "ArrowRight");
    await expectOnDay("tsk-u", "Undated", "2026-03-31");
    expect(updateTask.mock.calls).toEqual([["tsk-u", { scheduledDate: "2026-03-31" }]]);
    const bad = await dbRead(() => db.tasks.bulkGet(["tsk-bad-1", "tsk-bad-2"]));
    expect(bad.map((t) => [t?.scheduledDate, t?.updatedAt])).toEqual([
      ["garbage", T0],
      ["2026-13-45", T0],
    ]);
  });

  it("ignores held keys, other modifier combinations and plain arrows", async () => {
    await seed({ tasks: [makeTask("tsk-k", "Kayak", null, 1000, "2026-03-30")] });
    const updateTask = vi.fn(async () => true);
    useCommandStore.setState({ updateTask });
    render(<PlanWeekView />);
    const title = await screen.findByRole("button", { name: "Kayak" });

    // Held: the default (scrolling) is still suppressed, but nothing moves.
    expect(
      fireEvent.keyDown(title, { key: "ArrowRight", altKey: true, shiftKey: true, repeat: true })
    ).toBe(false);
    // Alt+Arrow alone is the browser's Back/Forward and stays untouched.
    expect(fireEvent.keyDown(title, { key: "ArrowRight", altKey: true })).toBe(true);
    fireEvent.keyDown(title, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(title, { key: "ArrowRight" });
    fireEvent.keyDown(title, { key: "ArrowUp", altKey: true, shiftKey: true });
    fireEvent.keyDown(title, { key: "ArrowRight", altKey: true, shiftKey: true, ctrlKey: true });
    fireEvent.keyDown(title, { key: "ArrowRight", altKey: true, shiftKey: true, metaKey: true });
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("drops a second move while the first is still being written", async () => {
    await seed({ tasks: [makeTask("tsk-k", "Kayak", null, 1000, "2026-03-30")] });
    let finish: (ok: boolean) => void = () => undefined;
    const updateTask = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    useCommandStore.setState({ updateTask });
    render(<PlanWeekView />);
    const title = await screen.findByRole("button", { name: "Kayak" });

    fireEvent.keyDown(title, { key: "ArrowRight", altKey: true, shiftKey: true });
    fireEvent.keyDown(title, { key: "ArrowRight", altKey: true, shiftKey: true });
    expect(updateTask).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    fireEvent.keyDown(title, { key: "ArrowLeft", altKey: true, shiftKey: true });
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(updateTask).toHaveBeenLastCalledWith("tsk-k", { scheduledDate: "2026-03-29" });
    await act(async () => finish(true));
  });
});

describe("empty and loading states", () => {
  it("Review: '–' while loading, then the empty copies for no quests and an empty week", async () => {
    render(<TelemetryDashboardView />);
    // Synchronously after the first render nothing has loaded yet.
    expect(within(kpiCard("Quest Hours")).getByText("–")).toBeInTheDocument();
    expect(within(kpiCard("Daily Average")).getByText("–")).toBeInTheDocument();
    expect(within(kpiCard("Quest Work vs Other")).getByText("–")).toBeInTheDocument();
    expect(screen.queryByText("0.0h")).toBeNull();
    expect(screen.queryByText("No quests yet. Create one in Quests.")).toBeNull();

    expect(
      await screen.findByText("No quests yet. Create one in Quests.")
    ).toHaveClass("text-hud-muted");
    expect(within(kpiCard("Quest Hours")).getByText("0.0h")).toBeInTheDocument();
    expect(within(kpiCard("Quest Work vs Other")).getByText("0")).toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: "View Session Log (0 sessions this week) ↓",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("No sessions logged this week.")).toBeInTheDocument();
    expect(screen.queryAllByTestId("session-row")).toEqual([]);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("No sessions logged this week.")).toBeNull();
  });

  it("Review: quests without logs show their rows, not the empty copy; last week's logs do not count", async () => {
    await seed({
      quests: [makeQuest("quest-0", "Launch", 0, 8)],
      logs: [makeLog("log-old", "2026-03-23", "quest-0", 3600)],
    });
    render(<TelemetryDashboardView />);
    expect(await screen.findByText("Launch")).toBeInTheDocument();
    expect(screen.queryByText("No quests yet. Create one in Quests.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /View Session Log \(0 sessions/ }));
    expect(screen.getByText("No sessions logged this week.")).toBeInTheDocument();
  });

  it("Plan: empty past days say 'Nothing planned' once loaded", async () => {
    await seed({
      tasks: [
        makeTask("tsk-p", "Past job", null, 1000, "2026-03-29"),
        // A synced archived task is never shown, so its day still reads empty.
        makeTask("tsk-arch", "Archived job", null, 2000, "2026-03-28", {
          status: "archived",
        }),
      ],
    });
    render(<PlanWeekView />);
    expect(screen.queryByText("Nothing planned")).toBeNull();
    await screen.findByRole("button", { name: "Past job" });
    expect(within(column("2026-03-28")).getByText("Nothing planned")).toHaveClass(
      "text-hud-muted"
    );
    expect(screen.queryByText("Archived job")).toBeNull();
    expect(within(column("2026-03-29")).queryByText("Nothing planned")).toBeNull();
    expect(within(column("2026-03-30")).queryByText("Nothing planned")).toBeNull();
  });
});

describe("Review reads only the shown week", () => {
  it("counts today back to 6 days ago, not 7 or 8, ignores 2000 old logs and lists sessions newest first", async () => {
    const oldLogs = Array.from({ length: 2000 }, (_, i) =>
      makeLog(`log-old-${i}`, addDaysUtc("2026-03-30", -(30 + (i % 400))), "quest-0", 3600)
    );
    await seed({
      quests: [makeQuest("quest-0", "Launch", 0, 10)],
      logs: [
        makeLog("log-today", "2026-03-30", "quest-0", 3600, 60),
        makeLog("log-today-other", "2026-03-30", null, 600, 120),
        makeLog("log-6d", "2026-03-24", "quest-0", 1800),
        makeLog("log-7d", "2026-03-23", "quest-0", 7200),
        makeLog("log-8d", "2026-03-22", "quest-0", 7200),
        ...oldLogs,
      ],
    });
    // Every whole-table entry point of a Dexie table: toArray(), orderBy() (the
    // pre-fix read was orderBy("startTime").reverse().toArray()), and
    // toCollection(), which filter/each/reverse/limit/offset all go through.
    const wholeTableReads = [
      vi.spyOn(db.timeLogs, "toArray"),
      vi.spyOn(db.timeLogs, "orderBy"),
      vi.spyOn(db.timeLogs, "toCollection"),
    ];
    const wholeTableReadCount = () =>
      wholeTableReads.reduce((n, spy) => n + spy.mock.calls.length, 0);
    const indexedReads = vi.spyOn(db.timeLogs, "where");
    const expectOnlyDateKeyReads = () => {
      expect(wholeTableReadCount()).toBe(0);
      expect(indexedReads).toHaveBeenCalled();
      expect(new Set(indexedReads.mock.calls.map((c) => c[0]))).toEqual(
        new Set(["dateKey"])
      );
    };
    render(<TelemetryDashboardView />);

    expect(await within(kpiCard("Quest Hours")).findByText("1.5h")).toBeInTheDocument();
    expect(within(kpiCard("Daily Average")).getByText("0.8h")).toBeInTheDocument();
    expect(screen.getByText("15% of target")).toHaveClass("text-hud-muted");
    fireEvent.click(
      screen.getByRole("button", { name: "View Session Log (3 sessions this week) ↓" })
    );
    expect(screen.getAllByTestId("session-row").map((r) => r.dataset.logId)).toEqual([
      "log-today-other",
      "log-today",
      "log-6d",
    ]);
    expectOnlyDateKeyReads();

    // The week before: 03-17 … 03-23 holds the two 2-hour logs.
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(await within(kpiCard("Quest Hours")).findByText("4.0h")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByTestId("session-row").map((r) => r.dataset.logId)).toEqual([
        "log-7d",
        "log-8d",
      ])
    );
    expectOnlyDateKeyReads();
    // Positive controls: the spies do see each whole-table shape.
    await db.timeLogs.orderBy("startTime").reverse().toArray();
    const afterOrderBy = wholeTableReadCount();
    expect(afterOrderBy).toBeGreaterThan(0);
    await db.timeLogs.filter(() => true).toArray();
    const afterFilter = wholeTableReadCount();
    expect(afterFilter).toBeGreaterThan(afterOrderBy);
    await db.timeLogs.toArray();
    expect(wholeTableReadCount()).toBeGreaterThan(afterFilter);
  });

  it("switching weeks shows '–' until that week is read, never zeros or the empty copy", async () => {
    await seed({
      quests: [makeQuest("quest-0", "Launch", 0, 10)],
      logs: [
        makeLog("log-today", "2026-03-30", "quest-0", 3600, 60),
        makeLog("log-7d", "2026-03-23", "quest-0", 7200),
      ],
    });
    render(<TelemetryDashboardView />);
    expect(await within(kpiCard("Quest Hours")).findByText("1.0h")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "View Session Log (1 sessions this week) ↓" })
    );

    // The live query still holds this week's rows while the previous week is
    // being read; they must not be shown as an empty previous week.
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(within(kpiCard("Quest Hours")).getByText("–")).toBeInTheDocument();
    expect(screen.queryByText("0.0h")).toBeNull();
    expect(screen.queryByText("No sessions logged this week.")).toBeNull();
    expect(screen.queryAllByTestId("session-row")).toEqual([]);

    expect(await within(kpiCard("Quest Hours")).findByText("2.0h")).toBeInTheDocument();
    expect(screen.getAllByTestId("session-row").map((r) => r.dataset.logId)).toEqual([
      "log-7d",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    expect(within(kpiCard("Quest Hours")).getByText("–")).toBeInTheDocument();
    expect(screen.queryByText("No sessions logged this week.")).toBeNull();
    expect(await within(kpiCard("Quest Hours")).findByText("1.0h")).toBeInTheDocument();
  });
});

describe("corrupted accents", () => {
  it("a quest and logs with an unknown or missing accent render with the neutral fallback", async () => {
    const violet: Quest = {
      ...makeQuest("quest-violet", "Violet quest", 0),
      accentColor: "violet" as unknown as QuestAccent,
    };
    const violetLog: TimeLog = {
      ...makeLog("log-violet", "2026-03-30", "quest-violet", 1200),
      accentColorSnapshot: "violet" as unknown as QuestAccent,
    };
    const bareLog = makeLog("log-bare", "2026-03-30", null, 600, 30);
    delete (bareLog as Partial<TimeLog>).accentColorSnapshot;
    await seed({
      quests: [violet],
      tasks: [
        makeTask("tsk-v", "On violet", "quest-violet", 1000, "2026-03-30"),
        makeTask("tsk-d", "Done on violet", "quest-violet", 2000, "2026-03-30", {
          status: "completed",
          completedAt: T0,
        }),
      ],
      logs: [violetLog, bareLog],
    });

    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "On violet" });
    const pill = screen.getByRole("button", { name: "Violet quest", pressed: true });
    expect(pill.querySelector("span")).toHaveClass("bg-slate-500");
    expect(screen.getByText("Done on violet")).toBeInTheDocument();
    cleanup();

    render(<TelemetryDashboardView />);
    expect(await screen.findByText("Violet quest")).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: /View Session Log \(2 sessions/ })
    );
    expect(sessionRow("log-violet").querySelector("span")).toHaveClass("bg-slate-500");
    expect(sessionRow("log-bare").querySelector("span")).toHaveClass("bg-slate-500");
  });
});

describe("accessibility and interaction states", () => {
  beforeEach(async () => {
    await seed({
      quests: [makeQuest("quest-0", "Launch", 0), makeQuest("quest-1", "Write", 1)],
      tasks: [
        makeTask("tsk-a", "Alpha", "quest-0", 1000, "2026-03-30", { accumulatedSeconds: 90 }),
        makeTask("tsk-b", "Bravo", null, 2000, "2026-03-30"),
        makeTask("tsk-d", "Finished thing", "quest-0", 3000, "2026-03-30", {
          status: "completed",
          completedAt: T0,
          accumulatedSeconds: 120,
        }),
      ],
      logs: [makeLog("log-1", "2026-03-30", "quest-0", 1800)],
    });
  });

  it("Plan: every button has an accessible name, also while a delete is armed", async () => {
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });

    for (const name of ["Previous day", "Today", "Next day"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(taskRow("tsk-a")).getByRole("button", { name: "Mark complete" })).toBeInTheDocument();
    expect(within(taskRow("tsk-d")).getByRole("button", { name: "Reopen task" })).toBeInTheDocument();
    fireEvent.click(within(taskRow("tsk-b")).getByRole("button", { name: "Delete task" }));

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(15);
    for (const button of buttons) expect(button).toHaveAccessibleName();
    expect(screen.getByRole("button", { name: "Confirm delete?" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Add task for Monday" })).toBeInTheDocument();
  });

  it("Review: every button has an accessible name with the session log open", async () => {
    render(<TelemetryDashboardView />);
    const toggle = await screen.findByRole("button", {
      name: "View Session Log (1 sessions this week) ↓",
    });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Hide Session Log ↑" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const button of buttons) expect(button).toHaveAccessibleName();
    for (const name of ["Previous week", "Next week", "This week", "Delete session"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  it("Plan: the quest pills report aria-pressed", async () => {
    render(<PlanWeekView />);
    const group = await screen.findByRole("group", { name: "Quest for new tasks" });
    const launch = await within(group).findByRole("button", { name: "Launch" });
    const write = within(group).getByRole("button", { name: "Write" });
    const other = within(group).getByRole("button", { name: "Other" });

    expect(launch).toHaveAttribute("aria-pressed", "true");
    expect(write).toHaveAttribute("aria-pressed", "false");
    expect(other).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(other);
    expect(other).toHaveAttribute("aria-pressed", "true");
    expect(launch).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-pressed", "true");
    expect(other).toHaveAttribute("aria-pressed", "false");
  });

  it("Plan: titles are native buttons that start focus", async () => {
    const initializeFocus = vi.fn(async () => undefined);
    useCommandStore.setState({ initializeFocus });
    render(<PlanWeekView />);
    const title = await screen.findByRole("button", { name: "Alpha" });
    expect(title.tagName).toBe("BUTTON");
    expect(title).toHaveAttribute("type", "button");
    fireEvent.click(title);
    expect(initializeFocus).toHaveBeenCalledWith("tsk-a");
  });

  it("Plan: the second click of a double-click on Complete is ignored; keyboard activation completes", async () => {
    const completeTaskById = vi.fn(async () => undefined);
    useCommandStore.setState({ completeTaskById });
    render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });

    const completeA = within(taskRow("tsk-a")).getByRole("button", { name: "Mark complete" });
    fireEvent.click(completeA, { detail: 1 });
    fireEvent.click(completeA, { detail: 2 });
    expect(completeTaskById).toHaveBeenCalledTimes(1);
    expect(completeTaskById).toHaveBeenCalledWith("tsk-a");

    // Enter/Space on a focused button dispatch a click with detail 0.
    fireEvent.click(within(taskRow("tsk-b")).getByRole("button", { name: "Mark complete" }), {
      detail: 0,
    });
    expect(completeTaskById).toHaveBeenLastCalledWith("tsk-b");
    expect(completeTaskById).toHaveBeenCalledTimes(2);
  });

  it("Plan: muted token instead of neutral-500/600, focus reveals, pressed states, and only the accents of completed cards are dimmed", async () => {
    const { container } = render(<PlanWeekView />);
    await screen.findByRole("button", { name: "Alpha" });

    for (const el of Array.from(container.querySelectorAll("[class]"))) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls, cls).not.toMatch(/(^|\s)(placeholder:)?text-neutral-(500|600)(\s|$)/);
      if (el.tagName === "BUTTON" && /(^|\s)opacity-0(\s|$)/.test(cls)) {
        expect(cls).toContain("focus-visible:opacity-100");
      }
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button.className, button.textContent ?? "").toMatch(/active:opacity-80/);
    }
    const input = screen.getByRole("textbox", { name: "Add task for Monday" });
    expect(input).toHaveClass("placeholder:text-hud-muted");
    expect(input.closest(".border-dashed")).toHaveClass("focus-within:border-white/40");

    const doneTitle = screen.getByText("Finished thing");
    expect(doneTitle).toHaveClass("text-hud-muted", "line-through", "break-words");
    let el: HTMLElement | null = doneTitle;
    while (el && el !== container) {
      expect(el.className).not.toMatch(/(^|\s)opacity-\d+/);
      el = el.parentElement;
    }
    const card = taskRow("tsk-d");
    expect(within(card).getByRole("button", { name: "Reopen task" })).toHaveClass(
      "opacity-65",
      "focus-visible:opacity-100"
    );
    expect(card.firstElementChild).toHaveClass("opacity-40");
  });

  it("Review: muted token instead of neutral-500/600 text", async () => {
    const { container } = render(<TelemetryDashboardView />);
    fireEvent.click(await screen.findByRole("button", { name: /View Session Log \(1 sessions/ }));
    for (const el of Array.from(container.querySelectorAll("[class]"))) {
      const cls = el.getAttribute("class") ?? "";
      expect(cls, cls).not.toMatch(/(^|\s)(placeholder:)?text-neutral-(500|600)(\s|$)/);
    }
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toMatch(/active:opacity-80/);
    }
  });
});

describe("long unbroken text", () => {
  const longTask = `T${"a".repeat(199)}`;
  const longQuest = `Q${"b".repeat(199)}`;
  const longDone = `D${"c".repeat(199)}`;

  beforeEach(async () => {
    await seed({
      quests: [makeQuest("quest-long", longQuest, 0)],
      tasks: [
        makeTask("tsk-long", longTask, "quest-long", 1000, "2026-03-30"),
        makeTask("tsk-done", longDone, "quest-long", 2000, "2026-03-30", {
          status: "completed",
          completedAt: T0,
        }),
      ],
      logs: [{ ...makeLog("log-long", "2026-03-30", "quest-long", 600), taskTitleSnapshot: longTask }],
    });
  });

  it("Plan wraps titles and truncates single-line pills with the full text as a tooltip", async () => {
    render(<PlanWeekView />);
    const title = await screen.findByRole("button", { name: longTask });
    expect(title).toHaveClass("break-words", "block", "w-full", "text-left");
    expect(screen.getByText(longDone)).toHaveClass("break-words");

    // Quests load in their own live query, so they can render after the tasks.
    const selector = await screen.findByRole("button", { name: longQuest, pressed: true });
    expect(selector).toHaveClass("min-w-0", "max-w-full");
    const selectorLabel = within(selector).getByText(longQuest);
    expect(selectorLabel).toHaveClass("truncate");
    expect(selectorLabel).toHaveAttribute("title", longQuest);

    for (const id of ["tsk-long", "tsk-done"]) {
      const pillLabel = within(taskRow(id)).getByText(longQuest);
      expect(pillLabel).toHaveClass("truncate");
      expect(pillLabel).toHaveAttribute("title", longQuest);
    }
  });

  it("Review truncates quest and session titles with the full text as a tooltip", async () => {
    render(<TelemetryDashboardView />);
    const questLabel = await screen.findByText(longQuest);
    expect(questLabel).toHaveClass("truncate");
    expect(questLabel).toHaveAttribute("title", longQuest);
    expect(questLabel.parentElement).toHaveClass("min-w-0");

    fireEvent.click(
      await screen.findByRole("button", { name: /View Session Log \(1 sessions/ })
    );
    const sessionTitle = within(sessionRow("log-long")).getByText(longTask);
    expect(sessionTitle).toHaveClass("truncate");
    expect(sessionTitle).toHaveAttribute("title", longTask);
    expect(
      within(sessionRow("log-long")).getByRole("button", { name: "Delete session" })
        .parentElement
    ).toHaveClass("shrink-0");
  });

  it("Plan allows two-step deletion of completed tasks and records sync tombstones", async () => {
    await seed({
      quests: [makeQuest("quest-0", "Launch", 0, 10)],
      tasks: [
        makeTask("tsk-plan-done", "Finished Tuesday spec", "quest-0", 1000, "2026-03-30", {
          status: "completed",
          completedAt: T0,
        }),
      ],
    });
    render(<PlanWeekView />);
    const doneRow = await screen.findByText("Finished Tuesday spec");
    const card = doneRow.closest('[data-completed-row="true"]') as HTMLElement;
    expect(card).not.toBeNull();

    const del = within(card).getByRole("button", { name: "Delete task" });
    fireEvent.click(del);
    expect(del).toHaveAttribute("data-state", "armed");
    expect(await db.tasks.get("tsk-plan-done")).toBeDefined();

    fireEvent.click(del);
    await waitFor(async () => expect(await db.tasks.get("tsk-plan-done")).toBeUndefined());
    const tombstones = JSON.parse(
      window.localStorage.getItem("hunt-sync-tombstones-v1") ?? "{}"
    ) as { deletedTaskIds?: string[] };
    expect(tombstones.deletedTaskIds).toContain("tsk-plan-done");
  });
});

describe("Review multi-horizon analytics, Quest X drill-down, and Activity Heatmap", () => {
  it("switches Day/Week/Month/Quarter/Year, filters to Quest X for hours + tasks, toggles chart metric, and inspects heatmap days using indexed reads only", async () => {
    await seed({
      quests: [
        makeQuest("quest-alpha", "Compiler", 0, 14),
        makeQuest("quest-beta", "Fitness", 1, 7),
      ],
      tasks: [
        makeTask("tsk-a1", "Lexer pass", "quest-alpha", 1000, "2026-03-30", {
          status: "completed",
          completedAt: dateFromKey("2026-03-30").getTime(),
        }),
        makeTask("tsk-a2", "Parser AST", "quest-alpha", 2000, "2026-03-10", {
          status: "completed",
          completedAt: dateFromKey("2026-03-10").getTime(),
        }),
        makeTask("tsk-a3", "IR design", "quest-alpha", 3000, "2026-01-20", {
          status: "completed",
          completedAt: dateFromKey("2026-01-20").getTime(),
        }),
        makeTask("tsk-b1", "Run 10k", "quest-beta", 4000, "2026-03-30", {
          status: "completed",
          completedAt: dateFromKey("2026-03-30").getTime(),
          habitId: "hab-run",
        }),
      ],
      logs: [
        makeLog("log-a-today", "2026-03-30", "quest-alpha", 7200, 60), // 2.0h
        makeLog("log-b-today", "2026-03-30", "quest-beta", 3600, 120), // 1.0h
        makeLog("log-a-mar", "2026-03-10", "quest-alpha", 10800, 60), // 3.0h
        makeLog("log-a-jan", "2026-01-20", "quest-alpha", 14400, 60), // 4.0h
      ],
    });

    const wholeTableSpies = [
      vi.spyOn(db.timeLogs, "toArray"),
      vi.spyOn(db.timeLogs, "orderBy"),
      vi.spyOn(db.timeLogs, "toCollection"),
    ];

    render(<TelemetryDashboardView />);
    expect(await within(kpiCard("Quest Hours")).findByText("3.0h")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(screen.getByTestId("stat-tasks-completed")).getByText("2")).toBeInTheDocument()
    );

    // Drill into Quest "Compiler" via its row in Hours & Tasks by Quest
    fireEvent.click(screen.getByRole("button", { name: "Inspect quest Compiler" }));
    expect(await within(kpiCard("Quest Hours")).findByText("2.0h")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-tasks-completed")).getByText("1")).toBeInTheDocument();

    // Switch across Month -> Quarter -> Year -> Day and verify Compiler's hours & completed tasks
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(await within(kpiCard("Quest Hours")).findByText("5.0h")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-tasks-completed")).getByText("2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Quarter" }));
    expect(await within(kpiCard("Quest Hours")).findByText("9.0h")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-tasks-completed")).getByText("3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    expect(await within(kpiCard("Quest Hours")).findByText("9.0h")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-tasks-completed")).getByText("3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(await within(kpiCard("Quest Hours")).findByText("2.0h")).toBeInTheDocument();
    expect(within(screen.getByTestId("stat-tasks-completed")).getByText("1")).toBeInTheDocument();

    // Toggle bar chart to Tasks metric
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(screen.getByText(/Completed Tasks · By Time Block/)).toBeInTheDocument();

    // Inspect March 10 cell on the 26-week Activity Heatmap
    const mar10Cell = screen
      .getAllByTestId("heatmap-cell")
      .find((el) => el.dataset.dateKey === "2026-03-10");
    expect(mar10Cell).toBeDefined();
    fireEvent.click(mar10Cell!);
    expect(screen.getByTestId("heatmap-inspector").textContent).toContain("3.0h focus");
    expect(screen.getByTestId("heatmap-inspector").textContent).toContain("1 task done");

    // Reset quest filter back to All Quests
    fireEvent.click(screen.getByRole("button", { name: "Clear quest filter" }));
    expect(await within(kpiCard("Quest Hours")).findByText("3.0h")).toBeInTheDocument();

    // Never performed a whole-table scan on db.timeLogs
    expect(wholeTableSpies.reduce((n, s) => n + s.mock.calls.length, 0)).toBe(0);
  });
});
