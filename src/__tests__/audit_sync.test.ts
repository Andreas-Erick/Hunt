import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, seedInitialDataIfNeeded } from "@/lib/db";
import type { Habit, Quest, Task } from "@/lib/domainTypes";
import { SYNC_TOKEN_STORAGE_KEY, TOMBSTONE_STORAGE_KEY } from "@/lib/domainTypes";
import { clearBreadcrumbs, getBreadcrumbs } from "@/lib/diagnostics";
import {
  applyMergedPayloadToLocalDB,
  buildLocalSyncPayload,
  describeSyncError,
  performServerSync,
  recordDeletedTaskTombstone,
  SYNC_CLIENT_ID,
  syncDataExistsElsewhere,
} from "@/lib/syncEngine";
import {
  createEmptySyncPayload,
  mergeSyncPayloads,
  questOrHabitRowStamp,
  taskRowStamp,
  type SyncPayload,
} from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";

const NO_FOCUS = { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 };
const VALID_TOKEN = "a".repeat(64);
const store = () => useCommandStore.getState();

function task(id: string, overrides: Partial<Task> = {}): Task {
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

function quest(id: string, overrides: Partial<Quest> = {}): Quest {
  return {
    id,
    slotIndex: 0,
    code: "Q",
    title: `Quest ${id}`,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 5,
    archived: false,
    createdAt: 1000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function payload(p: Partial<SyncPayload>): SyncPayload {
  return { ...createEmptySyncPayload(), ...p };
}

beforeEach(async () => {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
  clearBreadcrumbs();
  useCommandStore.setState(useCommandStore.getInitialState(), true);
  // No real sync from these tests: a debounced requestSync would fire later.
  useCommandStore.setState({ requestSync: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("P01-01: the seed's 'data exists elsewhere' check lives in syncEngine", () => {
  const emptyServer = () =>
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      jsonResponse({ payload: createEmptySyncPayload() })
    );

  it("asks the server with the shared client id and the validated pairing key", async () => {
    window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, VALID_TOKEN);
    const fetchMock = emptyServer();
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncDataExistsElsewhere()).resolves.toBe(false);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sync");
    expect(init?.headers).toEqual({ "X-Hunt-Client": SYNC_CLIENT_ID, "X-Hunt-Token": VALID_TOKEN });
  });

  it("never sends a stored key the sync client would reject (spaces, too short)", async () => {
    for (const bad of [`${"a".repeat(20)} ${"b".repeat(20)}`, "short"]) {
      window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, bad);
      const fetchMock = emptyServer();
      vi.stubGlobal("fetch", fetchMock);
      await syncDataExistsElsewhere();
      const [, init] = fetchMock.mock.calls[0];
      expect(init?.headers).toEqual({ "X-Hunt-Client": SYNC_CLIENT_ID });
    }
  });

  it("answers true for local tombstones without asking the server", async () => {
    recordDeletedTaskTombstone("tsk-gone");
    const fetchMock = emptyServer();
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncDataExistsElsewhere()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seedInitialDataIfNeeded uses only the injected check (db.ts makes no request)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const check = vi.fn(async () => true);
    await seedInitialDataIfNeeded(check);
    expect(check).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.quests.count()).toBe(0);

    await seedInitialDataIfNeeded(async () => false);
    expect(await db.quests.count()).toBe(3);
  });
});

describe("P28-1: a deletion whose tombstone cannot be saved is not performed", () => {
  function blockStorageWrites() {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    });
  }

  it("recordDeleted*Tombstone throws when localStorage refuses the write", () => {
    blockStorageWrites();
    expect(() => recordDeletedTaskTombstone("t1")).toThrow(/Could not record the deletion/);
  });

  it("deleteTask keeps the row and reports the failure", async () => {
    await db.tasks.put(task("t1"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    blockStorageWrites();

    await expect(store().deleteTask("t1")).resolves.toBeUndefined();

    expect(await db.tasks.get("t1")).toBeDefined();
    expect(store().actionError).toBe(describeSyncError("local_db"));
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", "deleteTask", expect.any(Error));
    expect(store().requestSync).not.toHaveBeenCalled();
  });

  it("deleteTimeLog and deleteQuest keep their rows too", async () => {
    await db.quests.put(quest("q1"));
    await db.timeLogs.put({
      id: "log-1-t1",
      taskId: "t1",
      taskTitleSnapshot: "T",
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime: 1000,
      endTime: 2000,
      durationSeconds: 1,
      dateKey: "2026-01-01",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    blockStorageWrites();

    await store().deleteTimeLog("log-1-t1");
    await store().deleteQuest("q1");

    expect(await db.timeLogs.get("log-1-t1")).toBeDefined();
    expect(await db.quests.get("q1")).toBeDefined();
  });

  it("a successful deletion still records the tombstone before the row goes", async () => {
    await db.tasks.put(task("t1"));
    await store().deleteTask("t1");
    expect(await db.tasks.get("t1")).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(TOMBSTONE_STORAGE_KEY) ?? "{}").deletedTaskIds).toEqual([
      "t1",
    ]);
  });

  it("applying a merged payload stays best-effort when the tombstone save fails", async () => {
    blockStorageWrites();
    await db.tasks.put(task("t1"));
    await expect(
      applyMergedPayloadToLocalDB(payload({ deletedTaskIds: ["t1"] }))
    ).resolves.toBe(true);
    expect(await db.tasks.get("t1")).toBeUndefined();
  });
});

describe("P28-3: desktop apply uses the server's per-kind R1 stamp", () => {
  it("stamps quests and habits without completedAt, tasks with it", () => {
    expect(questOrHabitRowStamp({ createdAt: 1, completedAt: 9 })).toBe(1);
    expect(taskRowStamp({ createdAt: 1, completedAt: 9 })).toBe(9);
    expect(questOrHabitRowStamp({ createdAt: 1, completedAt: 9, updatedAt: 5 })).toBe(5);
  });

  it("a legacy quest with completedAt and no updatedAt resolves to the server's winner", async () => {
    // Server rule: local stamp 1000 (createdAt) < remote 2000 → remote wins.
    // The old desktop rule read completedAt (5000) and kept the local row.
    const local = quest("q1", { title: "Local", createdAt: 1000, completedAt: 5000 });
    const remote = quest("q1", { title: "Remote", createdAt: 2000 });
    await db.quests.put(local);

    const server = mergeSyncPayloads(payload({ quests: [local] }), payload({ quests: [remote] }));
    expect(server.quests[0].title).toBe("Remote");

    await applyMergedPayloadToLocalDB(payload({ quests: [remote] }));
    expect((await db.quests.get("q1"))?.title).toBe(server.quests[0].title);
  });

  it("habits follow the same rule", async () => {
    const habit = (title: string, extra: Partial<Habit> & Record<string, unknown>): Habit => ({
      id: "h1",
      title,
      notes: "",
      questId: null,
      rank: 1000,
      createdAt: 1000,
      ...extra,
    });
    const local = habit("Local", { createdAt: 1000, completedAt: 5000 });
    const remote = habit("Remote", { createdAt: 2000 });
    await db.habits.put(local);
    const server = mergeSyncPayloads(payload({ habits: [local] }), payload({ habits: [remote] }));
    await applyMergedPayloadToLocalDB(payload({ habits: [remote] }));
    expect((await db.habits.get("h1"))?.title).toBe(server.habits?.[0].title);
    expect(server.habits?.[0].title).toBe("Remote");
  });
});

describe("P04-03: the desktop tells the two 507 causes apart", () => {
  it("merged data over the server limits is reported as too_large", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ code: "merged_over_limit", error: "Merged data exceeds server limits" }, 507)
      )
    );
    await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "too_large" });
    expect(describeSyncError("too_large")).toBe("Data is larger than the sync server accepts");
  });

  it("an unreadable server file (or a body without a code) stays http_507", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const body of [{ code: "server_data_unreadable", error: "x" }, { error: "x" }, "not json"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          typeof body === "string" ? new Response(body, { status: 507 }) : jsonResponse(body, 507)
        )
      );
      await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "http_507" });
    }
  });
});

describe("P05-01: more than 5000 tasks still sync", () => {
  it("builds and accepts a local payload of 5001 tasks", async () => {
    await db.tasks.bulkPut(Array.from({ length: 5001 }, (_, i) => task(`tsk-${i}`, { rank: i })));
    const local = await buildLocalSyncPayload(NO_FOCUS);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ payload: local })));
    const res = await performServerSync(NO_FOCUS);
    expect(res.ok).toBe(true);
    expect(res.merged?.tasks).toHaveLength(5001);
  });
});

describe("P20-4: a failed habit materialization after an import is in the breadcrumb ring", () => {
  it("records action_failed (materializeDailyHabits) and keeps the legacy console tag", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("IDB closed");
    vi.spyOn(db.habits, "count").mockRejectedValueOnce(failure);

    const result = await store().importSnapshot(JSON.stringify(payload({ tasks: [task("t1")] })));

    expect(result.ok).toBe(true);
    expect(errors).toHaveBeenCalledWith("[hunt] action_failed", "materializeDailyHabits", failure);
    const crumb = getBreadcrumbs().find(
      (b) => b.event === "action_failed" && b.context?.action === "materializeDailyHabits"
    );
    expect(crumb).toMatchObject({ level: "ERROR", domain: "store" });
    expect(crumb?.context?.message).toBe("IDB closed");
  });
});
