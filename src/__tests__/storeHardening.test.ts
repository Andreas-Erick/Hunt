import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { toLocalDateKey } from "@/lib/dateUtils";
import type { Quest, Task } from "@/lib/domainTypes";
import {
  applyMergedPayloadToLocalDB,
  buildLocalSyncPayload,
  describeSyncError,
} from "@/lib/syncEngine";
import {
  compareRank,
  createEmptySyncPayload,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  validateSyncPayload,
  type ActiveFocusState,
  type SyncPayload,
} from "@/lib/syncTypes";
import {
  AUTO_SYNC_BASE_BACKOFF_MS,
  AUTO_SYNC_MAX_BACKOFF_MS,
  pickNextFocusTask,
  sessionLogId,
  SYNC_DEBOUNCE_MS,
  useCommandStore,
} from "@/store/useCommandStore";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const STORE_KEY = "journey-hud-command-store";
const NO_FOCUS: ActiveFocusState = {
  activeTaskId: null,
  isRunning: false,
  sessionStartedAt: null,
  updatedAt: 0,
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeQuest(id: string, overrides: Partial<Quest> = {}): Quest {
  return {
    id,
    slotIndex: 0,
    code: "Q",
    title: `Quest ${id}`,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

/** Minimal fetch Response stand-in. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

function serverBody(payload: Partial<SyncPayload> = {}) {
  return {
    payload: { ...createEmptySyncPayload(), lastSyncedAt: 4242, ...payload },
    lanUrls: [],
    peers: { phone: { lastSeenAt: null } },
  };
}

/** Seeded PRNG (32-bit LCG, Numerical Recipes constants) in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Lets fake-indexeddb's real setImmediate turns run until `done()` holds. */
async function settle(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 2000 && !done(); turn++) await nextTurn();
  expect(done()).toBe(true);
}

const store = () => useCommandStore.getState();
const actionNames = (state: object) =>
  Object.entries(state)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
    .sort();
const ACTIONS = actionNames(useCommandStore.getInitialState());

beforeEach(async () => {
  // Date is faked too (frozen unless a test moves it); setImmediate and
  // queueMicrotask stay real because fake-indexeddb schedules on them.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear()]);
  window.localStorage.clear();
  useCommandStore.setState(useCommandStore.getInitialState(), true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("R6: a local write is stamped after the row it replaces", () => {
  interface StampCase {
    name: string;
    /** Seeds rows; the row under test is stamped `future`. */
    seed: (future: number) => Promise<unknown>;
    act: () => Promise<unknown>;
    table: "tasks" | "quests";
    id: string;
    check: (row: Task | Quest) => void;
  }

  const cases: StampCase[] = [
    {
      name: "updateTask",
      seed: (f) => db.tasks.put(makeTask("t1", { updatedAt: f })),
      act: () => store().updateTask("t1", { notes: "local edit" }),
      table: "tasks",
      id: "t1",
      check: (row) => expect((row as Task).notes).toBe("local edit"),
    },
    {
      name: "completeTaskById",
      seed: (f) => db.tasks.put(makeTask("t1", { updatedAt: f })),
      act: () => store().completeTaskById("t1"),
      table: "tasks",
      id: "t1",
      check: (row) => {
        expect((row as Task).status).toBe("completed");
        // completedAt is the real completion time, not the R6 stamp.
        expect((row as Task).completedAt).toBe(Date.now());
      },
    },
    {
      name: "reopenTaskById",
      seed: (f) =>
        db.tasks.put(makeTask("t1", { status: "completed", completedAt: 5000, updatedAt: f })),
      act: () => store().reopenTaskById("t1"),
      table: "tasks",
      id: "t1",
      check: (row) => {
        expect((row as Task).status).toBe("queued");
        expect((row as Task).completedAt).toBeUndefined();
      },
    },
    {
      name: "returnToQueue",
      seed: async (f) => {
        await db.tasks.put(makeTask("t1", { status: "active", updatedAt: f }));
        useCommandStore.setState({ activeTaskId: "t1", isRunning: false });
      },
      act: () => store().returnToQueue(),
      table: "tasks",
      id: "t1",
      check: (row) => expect((row as Task).status).toBe("queued"),
    },
    {
      name: "initializeFocus",
      seed: (f) => db.tasks.put(makeTask("t1", { updatedAt: f })),
      act: () => store().initializeFocus("t1"),
      table: "tasks",
      id: "t1",
      check: (row) => {
        expect((row as Task).status).toBe("active");
        expect(store().sessionStartedAt).toBe(Date.now());
      },
    },
    {
      name: "completeActiveTask (the completed task)",
      seed: async (f) => {
        await db.tasks.put(
          makeTask("t1", { status: "active", accumulatedSeconds: 60, updatedAt: f })
        );
        useCommandStore.setState({ activeTaskId: "t1", isRunning: false });
      },
      act: () => store().completeActiveTask(),
      table: "tasks",
      id: "t1",
      check: (row) => expect((row as Task).status).toBe("completed"),
    },
    {
      name: "deleteQuest (unlinking its tasks)",
      seed: async (f) => {
        await db.quests.put(makeQuest("q1"));
        await db.tasks.put(makeTask("t1", { questId: "q1", updatedAt: f }));
      },
      act: () => store().deleteQuest("q1"),
      table: "tasks",
      id: "t1",
      check: (row) => expect((row as Task).questId).toBeNull(),
    },
    {
      name: "updateQuest",
      seed: (f) => db.quests.put(makeQuest("q1", { updatedAt: f })),
      act: () => store().updateQuest("q1", { title: "Renamed", targetWeeklyHours: 7 }),
      table: "quests",
      id: "q1",
      check: (row) => {
        expect((row as Quest).title).toBe("Renamed");
        expect((row as Quest).targetWeeklyHours).toBe(7);
      },
    },
  ];

  const getRow = (table: StampCase["table"], id: string): Promise<Task | Quest | undefined> =>
    table === "tasks" ? db.tasks.get(id) : db.quests.get(id);

  it.each(cases)(
    "$name: stamps seeded + 1 when the row is from a clock 1 h ahead, and the stale copy loses the next merge",
    async ({ seed, act, table, id, check }) => {
      const future = Date.now() + HOUR;
      await seed(future);
      const stale = await getRow(table, id);
      expect(stale).toBeDefined();

      await act();

      const written = await getRow(table, id);
      expect(written?.updatedAt).toBe(future + 1);
      check(written!);
      expect(store().actionError).toBeNull();

      // The phone (clock ahead) still holds the old version stamped `future`.
      const payload: SyncPayload =
        table === "tasks"
          ? { ...createEmptySyncPayload(), tasks: [stale as Task] }
          : { ...createEmptySyncPayload(), quests: [stale as Quest] };
      await applyMergedPayloadToLocalDB(payload);
      expect(await getRow(table, id)).toEqual(written);
    }
  );

  it("completeActiveTask while running stamps the completion after the flush's own stamp", async () => {
    const future = Date.now() + HOUR;
    await db.tasks.put(makeTask("t1", { status: "active", updatedAt: future }));
    const startedAt = Date.now() - 90_000;
    useCommandStore.setState({ activeTaskId: "t1", isRunning: true, sessionStartedAt: startedAt });

    await store().completeActiveTask();

    const row = await db.tasks.get("t1");
    expect(row?.status).toBe("completed");
    expect(row?.accumulatedSeconds).toBe(90);
    // flush → future + 1, completion (re-read after the flush) → future + 2
    expect(row?.updatedAt).toBe(future + 2);
    expect((await db.timeLogs.toArray()).map((l) => l.id)).toEqual([
      sessionLogId("t1", startedAt),
    ]);
  });

  it("every focus write advances focusUpdatedAt past a future-stamped focus, so a stale remote focus is not adopted", async () => {
    const future = Date.now() + HOUR;
    await db.tasks.bulkPut([makeTask("t1", { status: "active" }), makeTask("t2", { rank: 2000 })]);
    useCommandStore.setState({ activeTaskId: "t1", isRunning: false, focusUpdatedAt: future });

    store().engageTimer();
    expect(store().focusUpdatedAt).toBe(future + 1);
    expect(store().sessionStartedAt).toBe(Date.now()); // the session start stays real time

    await store().suspendTimer();
    expect(store().focusUpdatedAt).toBe(future + 2);

    // The server still holds the phone's older focus, stamped future + 1.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          serverBody({
            activeFocus: {
              activeTaskId: "t2",
              isRunning: true,
              sessionStartedAt: future,
              updatedAt: future + 1,
            },
          })
        )
      )
    );
    await expect(store().syncNow()).resolves.toBe(true);
    expect(store().activeTaskId).toBe("t1");
    expect(store().isRunning).toBe(false);

    await store().initializeFocus("t2");
    expect(store().focusUpdatedAt).toBe(future + 3);
    await store().returnToQueue();
    expect(store().focusUpdatedAt).toBe(future + 4);
  });
});

describe("titles are clamped to the sync limits", () => {
  const FAMILY = "👨‍👩‍👧‍👦"; // 11 UTF-16 units: 4 surrogate pairs + 3 ZWJ
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  async function expectPayloadKeepsTitles(): Promise<void> {
    const payload = await buildLocalSyncPayload(NO_FOCUS);
    const check = validateSyncPayload(payload);
    expect(check.valid).toBe(true);
    expect(check.dropped).toBe(0);
    // The validator would cut nothing: the server stores exactly these titles.
    expect(check.payload?.tasks.map((t) => t.title).sort()).toEqual(
      payload.tasks.map((t) => t.title).sort()
    );
    expect(check.payload?.quests.map((q) => q.title).sort()).toEqual(
      payload.quests.map((q) => q.title).sort()
    );
  }

  it.each([
    ["999 characters", "x".repeat(999), "x".repeat(999)],
    ["1000 characters", "x".repeat(1000), "x".repeat(1000)],
    ["1001 characters", "x".repeat(1001), "x".repeat(1000)],
    ["10,000 characters", "y".repeat(10_000), "y".repeat(1000)],
    ["an emoji family ending exactly at the limit", "a".repeat(989) + FAMILY, "a".repeat(989) + FAMILY],
    ["a surrogate pair straddling the limit", "a".repeat(996) + FAMILY, "a".repeat(996) + FAMILY.slice(0, 3)],
    ["padding around the title", "   padded title   ", "padded title"],
    ["an HTML payload (stored as plain text)", "<script>alert(1)</script>", "<script>alert(1)</script>"],
    ["an SQL payload", "' OR 1=1 --", "' OR 1=1 --"],
    ["an RTL title", "مرحبا بالعالم", "مرحبا بالعالم"],
  ])("createTask with %s stores at most MAX_TASK_TITLE_LENGTH", async (_label, title, expected) => {
    await expect(store().createTask({ title, questId: null })).resolves.toBe(true);
    const [row] = await db.tasks.toArray();
    expect(row.title).toBe(expected);
    expect(row.title.length).toBeLessThanOrEqual(MAX_TASK_TITLE_LENGTH);
    expect(LONE_SURROGATE.test(row.title)).toBe(false);
    await expectPayloadKeepsTitles();
  });

  it.each([
    ["299", 299, 299],
    ["300", 300, 300],
    ["301", 301, 300],
    ["10,000", 10_000, 300],
  ])("createQuest with a %s-character title stores %i characters", async (_label, length, stored) => {
    await store().createQuest({ title: "q".repeat(length) });
    const [row] = await db.quests.toArray();
    expect(row.title).toHaveLength(stored);
    expect(row.title.length).toBeLessThanOrEqual(MAX_QUEST_TITLE_LENGTH);
    await expectPayloadKeepsTitles();
  });

  it("blank titles create nothing", async () => {
    await store().createTask({ title: "   ", questId: null });
    await store().createTask({ title: "", questId: null });
    await store().createQuest({ title: " \t " });
    expect(await db.tasks.count()).toBe(0);
    expect(await db.quests.count()).toBe(0);
  });

  it("updateTask and updateQuest clamp a long title and keep the old one when it is blank", async () => {
    await db.tasks.put(makeTask("t1", { title: "Original task" }));
    await db.quests.put(makeQuest("q1", { title: "Original quest" }));

    await store().updateTask("t1", { title: "z".repeat(10_000) });
    await store().updateQuest("q1", { title: "w".repeat(10_000) });
    expect((await db.tasks.get("t1"))?.title).toBe("z".repeat(MAX_TASK_TITLE_LENGTH));
    expect((await db.quests.get("q1"))?.title).toBe("w".repeat(MAX_QUEST_TITLE_LENGTH));
    await expectPayloadKeepsTitles();

    await store().updateTask("t1", { title: "   ", notes: "still saved" });
    await store().updateQuest("q1", { title: "", description: "  kept  " });
    const task = await db.tasks.get("t1");
    expect(task?.title).toBe("z".repeat(MAX_TASK_TITLE_LENGTH));
    expect(task?.notes).toBe("still saved");
    const quest = await db.quests.get("q1");
    expect(quest?.title).toBe("w".repeat(MAX_QUEST_TITLE_LENGTH));
    expect(quest?.description).toBe("kept");
  });

  it("updateQuest ignores a non-finite weekly target", async () => {
    await db.quests.put(makeQuest("q1", { targetWeeklyHours: 12 }));
    await store().updateQuest("q1", { targetWeeklyHours: Number.NaN });
    await store().updateQuest("q1", { targetWeeklyHours: Number.POSITIVE_INFINITY });
    expect((await db.quests.get("q1"))?.targetWeeklyHours).toBe(12);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [0.5, 1],
    [1, 1],
    [7.5, 7.5],
  ])("updateQuest floors a weekly target of %d at 1 (stores %d), like createQuest", async (target, stored) => {
    await db.quests.put(makeQuest("q1", { targetWeeklyHours: 12 }));
    await store().updateQuest("q1", { targetWeeklyHours: target });
    expect((await db.quests.get("q1"))?.targetWeeklyHours).toBe(stored);
  });

  it("updateQuest copies only the four editable fields", async () => {
    await db.quests.put(makeQuest("q1", { code: "KEEP", slotIndex: 2 }));
    // Extra keys a careless caller might pass along (not an object literal, so
    // TypeScript lets them through): only title/description/accent/target count.
    const hostile = { title: "T", archived: true, code: "X", slotIndex: 0, id: "q2" };
    await store().updateQuest("q1", hostile);
    const row = await db.quests.get("q1");
    expect(row).toMatchObject({ id: "q1", title: "T", archived: false, code: "KEEP", slotIndex: 2 });
    expect(await db.quests.get("q2")).toBeUndefined();
  });

  it("updateQuest on a quest that does not exist writes nothing", async () => {
    await expect(store().updateQuest("missing", { title: "x" })).resolves.toBe(true);
    expect(await db.quests.get("missing")).toBeUndefined();
  });
});

describe("DIX-V01 store defence: completeActiveTask is single-flight", () => {
  it("10 completeActiveTask() calls in one tick complete the task once without auto-starting the next", async () => {
    await db.tasks.bulkPut([
      makeTask("a", { rank: 1000 }),
      makeTask("b", { rank: 2000 }),
      makeTask("c", { rank: 3000 }),
    ]);
    await store().initializeFocus("a");
    const startedAt = store().sessionStartedAt!;
    const aStamp = (await db.tasks.get("a"))!.updatedAt!;
    const bStamp = (await db.tasks.get("b"))!.updatedAt;

    const { completeActiveTask } = store();
    await Promise.all(Array.from({ length: 10 }, () => completeActiveTask()));

    const a = await db.tasks.get("a");
    const b = await db.tasks.get("b");
    expect(a?.status).toBe("completed");
    expect(b?.status).toBe("queued");
    // Row a was written twice (flush + completion); row b was never touched.
    expect(a?.updatedAt).toBe(aStamp + 2);
    expect(b?.updatedAt).toBe(bStamp);
    expect((await db.tasks.get("c"))?.status).toBe("queued");
    expect((await db.timeLogs.toArray()).map((l) => l.id)).toEqual([sessionLogId("a", startedAt)]);
    expect(store().activeTaskId).toBeNull();
    expect(store().isRunning).toBe(false);
    expect(store().activeView).toBe("focus");

    // Explicitly starting the next task and completing it still works.
    await store().initializeFocus("b");
    await store().completeActiveTask();
    expect((await db.tasks.get("b"))?.status).toBe("completed");
    expect(store().activeTaskId).toBeNull();
    expect((await db.tasks.get("c"))?.status).toBe("queued");
  });

  it("completeTaskById spam on the focused task shares the same completion", async () => {
    await db.tasks.bulkPut([makeTask("a", { rank: 1000 }), makeTask("b", { rank: 2000 })]);
    await store().initializeFocus("a");
    await Promise.all(Array.from({ length: 10 }, () => store().completeTaskById("a")));
    expect(await db.timeLogs.count()).toBe(1);
    expect((await db.tasks.get("a"))?.status).toBe("completed");
    expect((await db.tasks.get("b"))?.status).toBe("queued");
    expect(store().activeTaskId).toBeNull();
  });

  it("a focused task already completed elsewhere (e.g. on the phone) is not completed or logged again, and focus clears cleanly", async () => {
    const completedOnPhone = makeTask("a", { status: "completed", completedAt: 5000, updatedAt: 5000 });
    await db.tasks.bulkPut([completedOnPhone, makeTask("b", { rank: 2000 })]);
    useCommandStore.setState({ activeView: "focus", activeTaskId: "a", isRunning: false });

    await store().completeActiveTask();

    // No placeholder 1 s log and no second completion write.
    expect(await db.timeLogs.count()).toBe(0);
    expect(await db.tasks.get("a")).toEqual(completedOnPhone);
    // Focus clears without auto-starting b, while staying in Focus so the user can choose to start b.
    expect((await db.tasks.get("b"))?.status).toBe("queued");
    expect(store().activeTaskId).toBeNull();
    expect(store().isRunning).toBe(false);
    expect(store().activeView).toBe("focus");
    expect(store().lastCompletedFeedback?.taskTitle).toBe("Task a");
    expect(store().lastCompletedFeedback?.nextTaskTitle).toBe("Task b");
  });

  it("a running session on a task completed elsewhere is still logged once when it is completed here", async () => {
    await db.tasks.bulkPut([
      makeTask("a", { status: "completed", completedAt: 5000, updatedAt: 5000 }),
      makeTask("b", { rank: 2000 }),
    ]);
    const startedAt = Date.now() - 120_000;
    useCommandStore.setState({ activeView: "focus", activeTaskId: "a", isRunning: true, sessionStartedAt: startedAt });

    await Promise.all([store().completeActiveTask(), store().completeActiveTask()]);

    expect((await db.timeLogs.toArray()).map((l) => l.id)).toEqual([sessionLogId("a", startedAt)]);
    const a = await db.tasks.get("a");
    expect(a).toMatchObject({ status: "completed", completedAt: 5000, accumulatedSeconds: 120 });
    expect(store().activeTaskId).toBeNull();
    expect(store().activeView).toBe("focus");
  });
});

describe("persisted focus state is validated on rehydrate", () => {
  async function rehydrateFrom(raw: string): Promise<void> {
    window.localStorage.setItem(STORE_KEY, raw);
    await useCommandStore.persist.rehydrate();
  }
  const stored = (state: unknown) => JSON.stringify({ state, version: 0 });
  const RUNNING = {
    activeView: "focus",
    activeTaskId: "tsk-1",
    isRunning: true,
    sessionStartedAt: 1_700_000_000_000,
    focusUpdatedAt: 1_700_000_000_500,
  };
  const REHYDRATED_RUNNING = {
    ...RUNNING,
    activeView: "command",
  };

  it("a valid stored session keeps its running focus state and always opens on Home ('command')", async () => {
    await rehydrateFrom(stored(RUNNING));
    const s = store();
    expect({
      activeView: s.activeView,
      activeTaskId: s.activeTaskId,
      isRunning: s.isRunning,
      sessionStartedAt: s.sessionStartedAt,
      focusUpdatedAt: s.focusUpdatedAt,
    }).toEqual(REHYDRATED_RUNNING);
    expect(actionNames(s)).toEqual(ACTIONS);
  });

  it.each(["quests", "focus", "plan", "habits", "telemetry", "guide", "log"] as const)(
    "rehydrating with stored activeView %j always lands on Home ('command') and partialize never persists activeView",
    async (previousView) => {
      useCommandStore.setState({ activeView: previousView });
      const rawPersisted = window.localStorage.getItem(STORE_KEY);
      expect(rawPersisted).not.toBeNull();
      expect(JSON.parse(rawPersisted!).state).not.toHaveProperty("activeView");

      await rehydrateFrom(stored({ ...RUNNING, activeView: previousView }));
      expect(store().activeView).toBe("command");
      expect(store().activeTaskId).toBe("tsk-1");
      expect(store().isRunning).toBe(true);
    }
  );

  it.each([
    ["invalid JSON", "{not json"],
    ["a NaN literal (invalid JSON)", '{"state":{"sessionStartedAt":NaN},"version":0}'],
    ["null", "null"],
    ["a null state", stored(null)],
    ["an array", "[1,2,3]"],
    ["a string", JSON.stringify("journey")],
  ])("%s: boot keeps the current state and every action", async (_label, raw) => {
    useCommandStore.setState({ activeView: "plan", activeTaskId: "tsk-keep" });
    await rehydrateFrom(raw);
    expect(store().activeView).toBe("plan");
    expect(store().activeTaskId).toBe("tsk-keep");
    expect(actionNames(store())).toEqual(ACTIONS);
  });

  it("stored keys that name actions never replace them", async () => {
    await rehydrateFrom(
      stored({ ...RUNNING, syncNow: null, initializeFocus: "x", requestSync: 1, actionError: "boom" })
    );
    expect(actionNames(store())).toEqual(ACTIONS);
    expect(store().activeTaskId).toBe("tsk-1");
    expect(store().actionError).toBeNull();
  });

  const DEFAULTS = {
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: 0,
  };
  it.each([
    ["sessionStartedAt '17x'", stored({ ...RUNNING, sessionStartedAt: "17x" }), { sessionStartedAt: null, isRunning: false }],
    ["sessionStartedAt 'NaN'", stored({ ...RUNNING, sessionStartedAt: "NaN" }), { sessionStartedAt: null, isRunning: false }],
    ["sessionStartedAt -1", stored({ ...RUNNING, sessionStartedAt: -1 }), { sessionStartedAt: null, isRunning: false }],
    ["sessionStartedAt 0", stored({ ...RUNNING, sessionStartedAt: 0 }), { sessionStartedAt: null, isRunning: false }],
    [
      "sessionStartedAt Infinity (1e999)",
      stored(RUNNING).replace("1700000000000", "1e999"),
      { sessionStartedAt: null, isRunning: false },
    ],
    [
      "sessionStartedAt above MAX_SAFE_INTEGER",
      stored({ ...RUNNING, sessionStartedAt: Number.MAX_SAFE_INTEGER + 2 }),
      { sessionStartedAt: null, isRunning: false },
    ],
    ["isRunning 'yes'", stored({ ...RUNNING, isRunning: "yes" }), { isRunning: false }],
    ["isRunning 1", stored({ ...RUNNING, isRunning: 1 }), { isRunning: false }],
    ["activeView 'bogus'", stored({ ...RUNNING, activeView: "bogus" }), { activeView: "command" }],
    ["activeView '__proto__'", stored({ ...RUNNING, activeView: "__proto__" }), { activeView: "command" }],
    [
      "a 10,000-character activeTaskId",
      stored({ ...RUNNING, activeTaskId: "a".repeat(10_000) }),
      { activeTaskId: null, isRunning: false },
    ],
    [
      "an activeTaskId with markup",
      stored({ ...RUNNING, activeTaskId: "<img src=x onerror=alert(1)>" }),
      { activeTaskId: null, isRunning: false },
    ],
    ["activeTaskId 42", stored({ ...RUNNING, activeTaskId: 42 }), { activeTaskId: null, isRunning: false }],
    ["focusUpdatedAt -5", stored({ ...RUNNING, focusUpdatedAt: -5 }), { focusUpdatedAt: 0 }],
    ["focusUpdatedAt 'soon'", stored({ ...RUNNING, focusUpdatedAt: "soon" }), { focusUpdatedAt: 0 }],
    [
      "focusUpdatedAt Infinity (1e999)",
      stored(RUNNING).replace("1700000000500", "1e999"),
      { focusUpdatedAt: 0 },
    ],
    ["an empty state", stored({}), DEFAULTS],
    ["a __proto__ state", '{"state":{"__proto__":{"isRunning":true}},"version":0}', DEFAULTS],
  ])("%s falls back to a safe value", async (_label, raw, expected) => {
    await rehydrateFrom(raw);
    const s = store();
    expect(s).toMatchObject({ ...REHYDRATED_RUNNING, ...expected });
    if (s.isRunning) {
      expect(s.activeTaskId).not.toBeNull();
      expect(s.sessionStartedAt).not.toBeNull();
    }
    expect(actionNames(s)).toEqual(ACTIONS);
    expect(({} as Record<string, unknown>).isRunning).toBeUndefined();
  });

  it("a corrupted running session cannot make suspendTimer write a NaN row", async () => {
    await db.tasks.put(makeTask("tsk-1"));
    await rehydrateFrom(stored({ ...RUNNING, sessionStartedAt: "17x" }));
    await store().suspendTimer();
    expect(await db.timeLogs.count()).toBe(0);
    expect((await db.tasks.get("tsk-1"))?.accumulatedSeconds).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "flushActiveBurst ignores a non-finite session start (%s) set in memory",
    async (startedAt) => {
      await db.tasks.put(makeTask("tsk-1"));
      useCommandStore.setState({ activeTaskId: "tsk-1", isRunning: true, sessionStartedAt: startedAt });
      await store().suspendTimer();
      await store().returnToQueue();
      expect(await db.timeLogs.count()).toBe(0);
      const row = await db.tasks.get("tsk-1");
      expect(row?.accumulatedSeconds).toBe(0);
      expect(Number.isFinite(row?.updatedAt)).toBe(true);
      expect(store().actionError).toBeNull();
    }
  );
});

describe("a failed local write resolves and is surfaced as actionError", () => {
  const LOCAL_DB_TEXT = describeSyncError("local_db");

  /** Fails if anything rejected without a handler while `run` and a few turns after it ran. */
  async function withoutUnhandledRejections(run: () => Promise<unknown>): Promise<void> {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await run();
      for (let turn = 0; turn < 20; turn++) await nextTurn();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  }

  it("completeTaskById: db.tasks.update rejects once → resolves, actionError set, row untouched; clearActionError resets it", async () => {
    await db.tasks.put(makeTask("t1"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("QuotaExceededError");
    vi.spyOn(db.tasks, "update").mockRejectedValueOnce(failure);

    await withoutUnhandledRejections(async () => {
      await expect(store().completeTaskById("t1")).resolves.toBeUndefined();
    });

    expect(store().actionError).toBe(LOCAL_DB_TEXT);
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", "completeTaskById", failure);
    expect((await db.tasks.get("t1"))?.status).toBe("queued");

    store().clearActionError();
    expect(store().actionError).toBeNull();

    await store().completeTaskById("t1");
    expect((await db.tasks.get("t1"))?.status).toBe("completed");
    expect(store().actionError).toBeNull();
  });

  it("a fire-and-forget click handler (no await, no catch) never produces an unhandled rejection", async () => {
    await db.tasks.put(makeTask("t1"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.tasks, "update").mockRejectedValue(new Error("IDB closed"));

    await withoutUnhandledRejections(async () => {
      void store().completeTaskById("t1");
      void store().reopenTaskById("t1");
      void store().updateTask("t1", { notes: "x" });
      for (let turn = 0; turn < 50; turn++) await nextTurn();
    });
    expect(store().actionError).toBe(LOCAL_DB_TEXT);
  });

  /** [action, makes its write reject once, runs it, what it resolves to] */
  const failing: Array<[string, (failure: Error) => void, () => Promise<unknown>, unknown]> = [
    ["createTask", (e) => vi.spyOn(db.tasks, "add").mockRejectedValueOnce(e), () => store().createTask({ title: "New", questId: null }), false],
    ["updateTask", (e) => vi.spyOn(db.tasks, "update").mockRejectedValueOnce(e), () => store().updateTask("t1", { notes: "x" }), false],
    ["deleteTask", (e) => vi.spyOn(db.tasks, "delete").mockRejectedValueOnce(e), () => store().deleteTask("t1"), undefined],
    ["reopenTaskById", (e) => vi.spyOn(db.tasks, "update").mockRejectedValueOnce(e), () => store().reopenTaskById("t1"), undefined],
    ["reorderTaskQueue", (e) => vi.spyOn(db.tasks, "bulkPut").mockRejectedValueOnce(e), () => store().reorderTaskQueue(["t2", "t1"], "t2"), undefined],
    ["createQuest", (e) => vi.spyOn(db.quests, "add").mockRejectedValueOnce(e), () => store().createQuest({ title: "New quest" }), false],
    ["updateQuest", (e) => vi.spyOn(db.quests, "update").mockRejectedValueOnce(e), () => store().updateQuest("q1", { title: "x" }), false],
    ["deleteQuest", (e) => vi.spyOn(db.quests, "delete").mockRejectedValueOnce(e), () => store().deleteQuest("q1"), undefined],
    ["initializeFocus", (e) => vi.spyOn(db.tasks, "update").mockRejectedValueOnce(e), () => store().initializeFocus("t1"), undefined],
    ["deleteTimeLog", (e) => vi.spyOn(db.timeLogs, "delete").mockRejectedValueOnce(e), () => store().deleteTimeLog("log-1"), undefined],
  ];

  it.each(failing)("%s resolves when its write rejects", async (name, makeFail, run, result) => {
    await db.quests.put(makeQuest("q1"));
    await db.tasks.bulkPut([makeTask("t1"), makeTask("t2", { rank: 2000 })]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error(`${name} failed`);
    makeFail(failure);

    await withoutUnhandledRejections(async () => {
      await expect(run()).resolves.toBe(result);
    });
    expect(store().actionError).toBe(LOCAL_DB_TEXT);
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", name, failure);
  });

  it("initializeFocus does not switch focus when the write fails", async () => {
    await db.tasks.put(makeTask("t1"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.tasks, "update").mockRejectedValueOnce(new Error("IDB closed"));
    await store().initializeFocus("t1");
    expect(store().activeTaskId).toBeNull();
    expect(store().isRunning).toBe(false);
  });

  it.each([
    ["suspendTimer", () => store().suspendTimer()],
    ["returnToQueue", () => store().returnToQueue()],
    ["completeActiveTask", () => store().completeActiveTask()],
  ])("%s resolves when flushing the running session fails", async (name, run) => {
    await db.tasks.put(makeTask("t1", { status: "active" }));
    useCommandStore.setState({ activeTaskId: "t1", isRunning: true, sessionStartedAt: Date.now() - 60_000 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.timeLogs, "add").mockRejectedValueOnce(new Error("IDB closed"));

    await withoutUnhandledRejections(async () => {
      await expect(run()).resolves.toBeUndefined();
    });
    expect(store().actionError).toBe(LOCAL_DB_TEXT);
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", name, expect.any(Error));
    // The failed flush wrote nothing (one transaction) and the session keeps running.
    expect(await db.timeLogs.count()).toBe(0);
    expect((await db.tasks.get("t1"))?.accumulatedSeconds).toBe(0);
    expect(store().isRunning).toBe(true);
  });

  it("engageTimer does not throw when persisting the focus to localStorage fails", async () => {
    await db.tasks.put(makeTask("t1", { status: "active" }));
    useCommandStore.setState({ activeTaskId: "t1", isRunning: false });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    expect(() => store().engageTimer()).not.toThrow();
    expect(store().isRunning).toBe(true);
    expect(store().actionError).toBe(LOCAL_DB_TEXT);
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", "engageTimer", expect.any(DOMException));
  });
});

describe("auto-sync backs off (transient) or pauses (deterministic) after a failure", () => {
  const SEED = 20_261_118;
  let respond: () => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const ok = async () => jsonResponse(serverBody());

  beforeEach(async () => {
    vi.spyOn(Math, "random").mockImplementation(lcg(SEED));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock = vi.fn(() => respond());
    vi.stubGlobal("fetch", fetchMock);
    // A success resets the failure count and the pause left by earlier tests.
    respond = ok;
    await expect(store().syncNow()).resolves.toBe(true);
    fetchMock.mockClear();
  });

  /** Calls autoSync() like the page's 5 s interval for `ms` of fake time; returns the requests sent. */
  async function autoSyncFor(ms: number): Promise<number> {
    const before = fetchMock.mock.calls.length;
    for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000);
      await store().autoSync();
    }
    return fetchMock.mock.calls.length - before;
  }

  /** The jitter factor of the backoff just armed (the last Math.random draw). */
  const lastJitter = () => {
    const results = vi.mocked(Math.random).mock.results;
    return 0.5 + (results[results.length - 1].value as number) / 2;
  };

  it("a 400 is sent once, autoSync sends nothing for 10 minutes, and requestSync() allows exactly one attempt", async () => {
    respond = async () => jsonResponse({ error: "Invalid task item schema" }, 400);
    await expect(store().syncNow()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store().syncError).toBe("http_400");

    expect(await autoSyncFor(10 * 60_000), `seed=${SEED}`).toBe(0);

    // A local edit may have fixed the payload: the pause is lifted at once and
    // that one attempt replaces the edit's debounced sync.
    store().requestSync();
    await expect(store().autoSync()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await autoSyncFor(10 * 60_000), `seed=${SEED}`).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an edit whose debounced sync joins a failing in-flight sync still gets one attempt of its own", async () => {
    let answer: (r: Response) => void = () => undefined;
    respond = () => new Promise<Response>((resolve) => (answer = resolve));
    const running = store().syncNow();
    await settle(() => fetchMock.mock.calls.length === 1);

    store().requestSync(); // the user edits while that request is out
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS); // joins the running sync
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(jsonResponse({ error: "Invalid task item schema" }, 400));
    await expect(running).resolves.toBe(false);

    respond = ok; // the edit fixed it
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    await settle(() => fetchMock.mock.calls.length === 2);
    for (let turn = 0; turn < 100; turn++) await nextTurn();
    expect(store().syncError).toBeNull();
    expect(await autoSyncFor(60_000)).toBe(12); // healthy again: every tick syncs
  });

  it("a 401 is never auto-retried, but a manual syncNow() always sends", async () => {
    respond = async () => jsonResponse({ error: "unauthorized" }, 401);
    await store().syncNow();
    expect(await autoSyncFor(30 * 60_000), `seed=${SEED}`).toBe(0);
    for (let i = 0; i < 3; i++) {
      await expect(store().syncNow()).resolves.toBe(false);
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(store().syncError).toBe("auth");
  });

  it.each([
    ["HTTP 503", async () => jsonResponse({ error: "save failed" }, 503)],
    ["a network error", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("%s: retries after ~5, 10, 20, 40, 60, 60 s (jittered), and a success resets the cadence", async (_label, fail) => {
    respond = fail;
    await expect(store().syncNow()).resolves.toBe(false);

    const bases = [5_000, 10_000, 20_000, 40_000, 60_000, 60_000];
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      const ctx = `seed=${SEED} failure #${i + 1}`;
      const gap = base * lastJitter();
      expect(gap, ctx).toBeGreaterThanOrEqual(base / 2);
      expect(gap, ctx).toBeLessThan(base);

      const calls = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(Math.ceil(gap) - 1);
      await expect(store().autoSync(), ctx).resolves.toBe(false);
      expect(fetchMock.mock.calls.length, ctx).toBe(calls);

      await vi.advanceTimersByTimeAsync(1);
      await expect(store().autoSync(), ctx).resolves.toBe(false); // sent, failed again
      expect(fetchMock.mock.calls.length, ctx).toBe(calls + 1);
    }

    respond = ok;
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_MAX_BACKOFF_MS);
    await expect(store().autoSync()).resolves.toBe(true);
    // Reset: the next sync is not delayed, and a failure starts again at ~5 s.
    respond = fail;
    await expect(store().autoSync()).resolves.toBe(false);
    const gap = AUTO_SYNC_BASE_BACKOFF_MS * lastJitter();
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(Math.ceil(gap) - 1);
    await store().autoSync();
    expect(fetchMock.mock.calls.length, `seed=${SEED}`).toBe(calls);
    await vi.advanceTimersByTimeAsync(1);
    await store().autoSync();
    expect(fetchMock.mock.calls.length, `seed=${SEED}`).toBe(calls + 1);
  });

  it.each([
    ["HTTP 408", 408, true],
    ["HTTP 429", 429, true],
    ["HTTP 500", 500, true],
    ["HTTP 502", 502, true],
    ["HTTP 504", 504, true],
    ["HTTP 507", 507, false],
    ["HTTP 400", 400, false],
    ["HTTP 403", 403, false],
    ["HTTP 404", 404, false],
    ["HTTP 413", 413, false],
    ["HTTP 422", 422, false],
  ])("%s is auto-retried: %s", async (_label, status, retried) => {
    respond = async () => jsonResponse({ error: "x" }, status);
    await store().syncNow();
    // Transient: the first backoff is < 5 s, so one 5 s tick retries.
    expect(await autoSyncFor(AUTO_SYNC_BASE_BACKOFF_MS), `seed=${SEED}`).toBe(retried ? 1 : 0);
    if (!retried) expect(await autoSyncFor(10 * 60_000), `seed=${SEED}`).toBe(0);
  });

  it("a 2xx body that is not a sync payload (bad_response) pauses auto-sync", async () => {
    respond = async () => jsonResponse({ nope: true });
    await store().syncNow();
    expect(store().syncError).toBe("bad_response");
    expect(await autoSyncFor(10 * 60_000), `seed=${SEED}`).toBe(0);
  });

  it("a mutation's debounced sync: no request at SYNC_DEBOUNCE_MS - 1, exactly one at SYNC_DEBOUNCE_MS", async () => {
    respond = ok;
    await store().createTask({ title: "Edit", questId: null });
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
    for (let turn = 0; turn < 100; turn++) await nextTurn();
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await settle(() => fetchMock.mock.calls.length > 0);
    for (let turn = 0; turn < 100; turn++) await nextTurn();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("pickNextFocusTask", () => {
  const today = "2026-11-18";

  it("returns null for an empty list and when nothing is queued", () => {
    expect(pickNextFocusTask([], today)).toBeNull();
    expect(
      pickNextFocusTask(
        [makeTask("a", { status: "completed" }), makeTask("b", { status: "active" })],
        today
      )
    ).toBeNull();
  });

  it("skips tasks scheduled after today; today, earlier and unscheduled tasks count", () => {
    const future = makeTask("f", { rank: 1, questId: "q", scheduledDate: "2026-11-19" });
    expect(pickNextFocusTask([future], today)).toBeNull();
    expect(pickNextFocusTask([future, makeTask("t", { rank: 5, scheduledDate: today })], today)?.id).toBe("t");
    expect(pickNextFocusTask([future, makeTask("p", { rank: 5, scheduledDate: "2026-11-01" })], today)?.id).toBe("p");
    expect(pickNextFocusTask([future, makeTask("u", { rank: 5 })], today)?.id).toBe("u");
    const nullDate = { ...makeTask("n", { rank: 5 }), scheduledDate: null } as unknown as Task;
    expect(pickNextFocusTask([future, nullDate], today)?.id).toBe("n");
  });

  it("puts quest tasks before other work, whatever their rank", () => {
    const tasks = [
      makeTask("other", { rank: -5000, questId: null }),
      makeTask("quest-late", { rank: 9000, questId: "q2" }),
      makeTask("quest-early", { rank: 3000, questId: "q1" }),
    ];
    expect(pickNextFocusTask(tasks, today)?.id).toBe("quest-early");
    expect(pickNextFocusTask([tasks[0]], today)?.id).toBe("other");
  });

  it("orders equal ranks by id (compareRank) and does not reorder the caller's array", () => {
    const tasks = [
      makeTask("c", { rank: 1000, questId: "q" }),
      makeTask("a", { rank: 1000, questId: "q" }),
      makeTask("b", { rank: 1000, questId: "q" }),
    ];
    const before = tasks.map((t) => t.id);
    expect(pickNextFocusTask(tasks, today)?.id).toBe("a");
    expect(tasks.map((t) => t.id)).toEqual(before);
  });

  it("is the rule initializeFocus() and completeActiveTask() apply", async () => {
    const todayKey = toLocalDateKey();
    const futureKey = toLocalDateKey(Date.now() + 7 * DAY);
    await db.tasks.bulkPut([
      makeTask("o", { rank: 100 }),
      makeTask("qf", { rank: 200, questId: "q", scheduledDate: futureKey }),
      makeTask("q2", { rank: 400, questId: "q", scheduledDate: todayKey }),
      makeTask("q1", { rank: 300, questId: "q" }),
    ]);
    const expected = pickNextFocusTask(await db.tasks.toArray(), todayKey);
    expect(expected?.id).toBe("q1");

    await store().initializeFocus();
    expect(store().activeTaskId).toBe("q1");
    await store().completeActiveTask();
    // Does not auto-start q2; stays in Focus and reports q2 as next up.
    expect(store().activeTaskId).toBeNull();
    expect(store().activeView).toBe("focus");
    expect(store().lastCompletedFeedback?.nextTaskTitle).toBe("Task q2");

    await store().initializeFocus();
    expect(store().activeTaskId).toBe("q2");
    await store().completeActiveTask();
    expect(store().activeTaskId).toBeNull();
    expect(store().activeView).toBe("focus");
    expect(store().lastCompletedFeedback?.nextTaskTitle).toBe("Task o");

    await store().initializeFocus();
    expect(store().activeTaskId).toBe("o");
    // Only a future task left: completing returns to Home ...
    await store().completeActiveTask();
    expect(store().activeTaskId).toBeNull();
    expect(store().activeView).toBe("command");
    // ... while an explicit "start focus" still starts the first queued task of any day.
    await store().initializeFocus();
    expect(store().activeTaskId).toBe("qf");
  });
});

describe("seeded action fuzz (structural invariants)", () => {
  it("400 random actions keep one active task (the focused one) and never produce NaN", async () => {
    const SEED = 0x5eed_2026;
    const rand = lcg(SEED);
    // Task ids use Math.random too: seed it so a failure replays exactly.
    vi.spyOn(Math, "random").mockImplementation(lcg(SEED ^ 0x9e37_79b9));
    const pick = <T,>(items: readonly T[]): T | undefined =>
      items.length ? items[Math.floor(rand() * items.length)] : undefined;
    await db.quests.put(makeQuest("quest-a"));
    const futureKey = toLocalDateKey(Date.now() + 3 * DAY);

    const KINDS = [
      "create",
      "complete",
      "reopen",
      "delete",
      "initializeFocus",
      "suspend",
      "engage",
      "reorder",
      "returnToQueue",
    ] as const;
    let clock = Date.now();
    const ran = new Map<string, number>();
    let maxTasks = 0;

    for (let step = 0; step < 400; step++) {
      clock += 1 + Math.floor(rand() * 120_000);
      vi.setSystemTime(clock);
      const tasks = await db.tasks.toArray();
      maxTasks = Math.max(maxTasks, tasks.length);
      const ids = tasks.map((t) => t.id);
      const kind = pick(KINDS)!;
      ran.set(kind, (ran.get(kind) ?? 0) + 1);
      const s = store();
      switch (kind) {
        case "create":
          await s.createTask({
            title: `Task ${step}`,
            questId: rand() < 0.5 ? "quest-a" : null,
            promoteToTop: rand() < 0.5,
            scheduledDate: rand() < 0.2 ? futureKey : undefined,
          });
          break;
        case "complete": {
          const id = rand() < 0.3 ? s.activeTaskId : pick(ids);
          if (id) await s.completeTaskById(id);
          break;
        }
        case "reopen": {
          const id = pick(ids);
          if (id) await s.reopenTaskById(id);
          break;
        }
        case "delete": {
          const id = rand() < 0.2 ? s.activeTaskId : pick(ids);
          if (id) await s.deleteTask(id);
          break;
        }
        case "initializeFocus":
          await s.initializeFocus(rand() < 0.3 ? undefined : pick(ids));
          break;
        case "suspend":
          await s.suspendTimer();
          break;
        case "engage":
          s.engageTimer();
          break;
        case "reorder": {
          const pending = tasks
            .filter((t) => t.status === "queued" || t.status === "active")
            .sort(compareRank)
            .map((t) => t.id);
          for (let i = pending.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            [pending[i], pending[j]] = [pending[j], pending[i]];
          }
          await s.reorderTaskQueue(pending, pick(pending));
          break;
        }
        case "returnToQueue":
          await s.returnToQueue();
          break;
      }

      const ctx = `seed=${SEED} step=${step} action=${kind}`;
      const state = store();
      const after = await db.tasks.toArray();
      const logs = await db.timeLogs.toArray();
      const active = after.filter((t) => t.status === "active");
      expect(active.length, ctx).toBeLessThanOrEqual(1);
      if (active.length === 1) expect(active[0].id, ctx).toBe(state.activeTaskId);
      if (state.isRunning) {
        expect(state.activeTaskId, ctx).not.toBeNull();
        expect(Number.isFinite(state.sessionStartedAt), ctx).toBe(true);
      }
      expect(state.actionError, ctx).toBeNull();
      for (const t of after) {
        expect(Number.isFinite(t.accumulatedSeconds), `${ctx} task=${t.id}`).toBe(true);
        expect(Number.isFinite(t.rank), `${ctx} task=${t.id}`).toBe(true);
        expect(Number.isFinite(t.updatedAt), `${ctx} task=${t.id}`).toBe(true);
        // Conserved: a task's counter is exactly the time logged for it.
        const logged = logs
          .filter((l) => l.taskId === t.id)
          .reduce((sum, l) => sum + l.durationSeconds, 0);
        expect(t.accumulatedSeconds, `${ctx} task=${t.id}`).toBe(logged);
      }
      for (const l of logs) {
        expect(Number.isFinite(l.durationSeconds) && l.durationSeconds >= 1, `${ctx} log=${l.id}`).toBe(true);
      }
    }

    // The run really exercised every action on a non-trivial queue.
    for (const kind of KINDS) expect(ran.get(kind) ?? 0, `seed=${SEED} ${kind}`).toBeGreaterThanOrEqual(20);
    expect(maxTasks, `seed=${SEED}`).toBeGreaterThanOrEqual(5);
    expect(await db.timeLogs.count(), `seed=${SEED}`).toBeGreaterThanOrEqual(10);
    expect(await db.tasks.where("status").equals("completed").count(), `seed=${SEED}`).toBeGreaterThan(0);

    const check = validateSyncPayload(await buildLocalSyncPayload(NO_FOCUS));
    expect(check.valid, `seed=${SEED}`).toBe(true);
    expect(check.dropped, `seed=${SEED}`).toBe(0);
  });
});
