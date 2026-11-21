import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, type Task, type TimeLog } from "@/lib/db";
import { createEmptySyncPayload, type SyncPayload } from "@/lib/syncTypes";
import { useCommandStore, sessionLogId, SYNC_DEBOUNCE_MS } from "@/store/useCommandStore";

/** Minimal fetch Response stand-in. */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

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

function serverBody(p: Partial<SyncPayload>, extra: Record<string, unknown> = {}) {
  return {
    payload: { ...createEmptySyncPayload(), lastSyncedAt: 4242, ...p },
    lanUrls: ["http://192.168.1.5:3000", "http://100.64.1.2:3000"],
    peers: { phone: { lastSeenAt: 1234 } },
    ...extra,
  };
}

const flushPromises = () => new Promise((r) => setTimeout(r, 0));

describe("Store sync scheduler (syncNow / requestSync)", () => {
  const originalSyncNow = useCommandStore.getState().syncNow;

  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    window.localStorage.clear();
    useCommandStore.setState({
      syncNow: originalSyncNow,
      activeView: "command",
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      focusUpdatedAt: 0,
      lastCompletedFeedback: null,
      lastSyncedAt: null,
      isSyncOnline: false,
      lanUrls: [],
      phoneLastSeenAt: null,
      syncError: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is single-flight: overlapping calls share one run plus ONE coalesced rerun", async () => {
    const pending: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => pending.push(resolve))
    );
    vi.stubGlobal("fetch", fetchMock);

    const { syncNow } = useCommandStore.getState();
    const p1 = syncNow();
    const p2 = syncNow();
    const p3 = syncNow();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no overlapping request

    pending[0](jsonResponse(serverBody({})));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    pending[1](jsonResponse(serverBody({})));

    await expect(p1).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Request shape: own client id, abortable (timeout), POST to the local route.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sync");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Hunt-Client"]).toBe("desktop");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("stores lanUrls, phoneLastSeenAt and clears syncError on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(serverBody({}))));
    useCommandStore.setState({ syncError: "unreachable" });

    await expect(useCommandStore.getState().syncNow()).resolves.toBe(true);

    const s = useCommandStore.getState();
    expect(s.isSyncOnline).toBe(true);
    expect(s.syncError).toBeNull();
    expect(s.phoneLastSeenAt).toBe(1234);
    expect(s.lastSyncedAt).toBe(4242);
    expect(s.lanUrls).toEqual(["http://192.168.1.5:3000", "http://100.64.1.2:3000"]);
  });

  it("an identical follow-up sync does not call set() at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(serverBody({}))));
    await useCommandStore.getState().syncNow();

    const listener = vi.fn();
    const unsubscribe = useCommandStore.subscribe(listener);
    await useCommandStore.getState().syncNow();
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    [413, "too_large"],
    [401, "auth"],
    [500, "http_500"],
  ])("maps HTTP %i to syncError %s", async (status, code) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "x" }, status)));
    await expect(useCommandStore.getState().syncNow()).resolves.toBe(false);
    expect(useCommandStore.getState().syncError).toBe(code);
    expect(useCommandStore.getState().isSyncOnline).toBe(false);
  });

  it("reports network failures as unreachable and malformed bodies as bad_response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(useCommandStore.getState().syncNow()).resolves.toBe(false);
    expect(useCommandStore.getState().syncError).toBe("unreachable");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ nope: true })));
    await expect(useCommandStore.getState().syncNow()).resolves.toBe(false);
    expect(useCommandStore.getState().syncError).toBe("bad_response");
  });

  describe("debounce (fake timers)", () => {
    beforeEach(() => {
      // setImmediate / queueMicrotask stay real: fake-indexeddb runs on them.
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      });
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    /** Lets fake-indexeddb's real setImmediate turns run until `done()` holds. */
    const settle = async (done: () => boolean) => {
      for (let turn = 0; turn < 2000 && !done(); turn++) await nextTurn();
      expect(done()).toBe(true);
    };
    /** More real turns than a started sync needs to reach fetch. */
    const idle = async () => {
      for (let turn = 0; turn < 100; turn++) await nextTurn();
    };

    it("requestSync() debounces bursts of mutations into one trailing sync", async () => {
      const spy = vi.fn(() => Promise.resolve(true));
      useCommandStore.setState({ syncNow: spy });
      const { requestSync } = useCommandStore.getState();
      // Every call restarts the window: 5 calls 299 ms apart never fire.
      for (let i = 0; i < 5; i++) {
        requestSync();
        await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
      }
      expect(spy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 10);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("mutations request a debounced sync: none at SYNC_DEBOUNCE_MS - 1, exactly one at SYNC_DEBOUNCE_MS", async () => {
      const fetchMock = vi.fn(async () => jsonResponse(serverBody({})));
      vi.stubGlobal("fetch", fetchMock);
      await db.tasks.put(task("t1"));

      const { updateTask } = useCommandStore.getState();
      await updateTask("t1", { notes: "a" });
      await updateTask("t1", { notes: "ab" });
      await updateTask("t1", { notes: "abc" });
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
      await idle();
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await settle(() => useCommandStore.getState().lastSyncedAt === 4242);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 10);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((await db.tasks.get("t1"))?.notes).toBe("abc");
    });
  });

  it("flushes the desktop's own running burst before adopting a newer focus from another session", async () => {
    const start = Date.now() - 60_000;
    const remoteStart = Date.now() - 1_000;
    await db.tasks.bulkPut([
      task("x", { status: "active", updatedAt: start }),
      task("y", { rank: 2000 }),
    ]);
    useCommandStore.setState({
      activeTaskId: "x",
      isRunning: true,
      sessionStartedAt: start,
      focusUpdatedAt: start,
    });

    // The phone (offline until now) started focus on Y later than our session.
    const body = serverBody({
      tasks: [task("x", { status: "active", updatedAt: start }), task("y", { rank: 2000 })],
      activeFocus: {
        activeTaskId: "y",
        isRunning: true,
        sessionStartedAt: remoteStart,
        updatedAt: remoteStart,
      },
    });
    const fetchMock = vi.fn(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    await expect(useCommandStore.getState().syncNow()).resolves.toBe(true);

    const s = useCommandStore.getState();
    expect(s.activeTaskId).toBe("y");
    expect(s.sessionStartedAt).toBe(remoteStart);
    expect(s.focusUpdatedAt).toBe(remoteStart);

    const x = await db.tasks.get("x");
    expect(x?.status).toBe("queued");
    expect(x?.accumulatedSeconds).toBeGreaterThanOrEqual(59);
    expect(x?.accumulatedSeconds).toBeLessThanOrEqual(62);
    const logs = await db.timeLogs.toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].id).toBe(sessionLogId("x", start));
    expect(logs[0].startTime).toBe(start);

    // The flush was pushed right away (coalesced rerun); the stale X in that
    // second response did not overwrite the newer local row.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uploaded = JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string
    ) as SyncPayload;
    expect(uploaded.timeLogs.map((l) => l.id)).toEqual([sessionLogId("x", start)]);
  });

  it("R4: a session replaced on the phone hours ago is logged up to the replacement, not until now", async () => {
    // 10:00 the laptop starts X. 10:20 the phone (offline) starts Y and pauses
    // it at 10:50. 12:00 the phone reconnects and the laptop syncs.
    const now = Date.now();
    const S = now - 2 * 3_600_000;
    const phoneStart = S + 20 * 60_000;
    const phonePause = S + 50 * 60_000;
    await db.tasks.bulkPut([
      task("x", { status: "active", updatedAt: S }),
      task("y", { rank: 2000 }),
    ]);
    useCommandStore.setState({
      activeTaskId: "x",
      isRunning: true,
      sessionStartedAt: S,
      focusUpdatedAt: S,
    });
    const phoneLog: TimeLog = {
      id: sessionLogId("y", phoneStart),
      taskId: "y",
      taskTitleSnapshot: "Task y",
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime: phoneStart,
      endTime: phonePause,
      durationSeconds: 1800,
      dateKey: "2026-11-18",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          serverBody({
            tasks: [
              task("x", { status: "active", updatedAt: S }),
              task("y", { rank: 2000, status: "active", accumulatedSeconds: 1800, updatedAt: phonePause }),
            ],
            timeLogs: [phoneLog],
            activeFocus: { activeTaskId: "y", isRunning: false, sessionStartedAt: null, updatedAt: phonePause },
          })
        )
      )
    );

    await useCommandStore.getState().syncNow();

    const own = await db.timeLogs.get(sessionLogId("x", S));
    expect(own?.startTime).toBe(S);
    expect(own?.endTime).toBe(phoneStart);
    expect(own?.durationSeconds).toBe(1200);
    expect((await db.tasks.get("x"))?.accumulatedSeconds).toBe(1200);
    expect((await db.tasks.get("x"))?.status).toBe("queued");
    expect(useCommandStore.getState().activeTaskId).toBe("y");
  });

  it("R4: a newer pause of an unrelated older session does not cut the running session short", async () => {
    const now = Date.now();
    const S = now - 30 * 60_000;
    await db.tasks.bulkPut([
      task("x", { status: "active", updatedAt: S }),
      task("y", { rank: 2000 }),
    ]);
    useCommandStore.setState({
      activeTaskId: "x",
      isRunning: true,
      sessionStartedAt: S,
      focusUpdatedAt: S,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          serverBody({
            tasks: [task("x", { status: "active", updatedAt: S }), task("y", { rank: 2000 })],
            // The phone paused an older session of Y 5 min after our start.
            activeFocus: { activeTaskId: "y", isRunning: false, sessionStartedAt: null, updatedAt: S + 5 * 60_000 },
          })
        )
      )
    );

    await useCommandStore.getState().syncNow();

    const own = await db.timeLogs.get(sessionLogId("x", S));
    expect(own?.durationSeconds).toBeGreaterThanOrEqual(1799);
    expect(own?.durationSeconds).toBeLessThanOrEqual(1802);
    expect(own?.endTime).toBeGreaterThanOrEqual(now);
  });

  it("does not double-count a session the other device already logged (paused it there)", async () => {
    const start = Date.now() - 60_000;
    const pausedAt = Date.now() - 5_000;
    const phoneLog: TimeLog = {
      id: "log-phone-random",
      taskId: "x",
      taskTitleSnapshot: "Task x",
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime: start,
      endTime: pausedAt,
      durationSeconds: 55,
      dateKey: "2026-11-18",
    };
    await db.tasks.put(task("x", { status: "active", updatedAt: start }));
    useCommandStore.setState({
      activeTaskId: "x",
      isRunning: true,
      sessionStartedAt: start,
      focusUpdatedAt: start,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          serverBody({
            tasks: [task("x", { status: "active", accumulatedSeconds: 55, updatedAt: pausedAt })],
            timeLogs: [phoneLog],
            activeFocus: {
              activeTaskId: "x",
              isRunning: false,
              sessionStartedAt: null,
              updatedAt: pausedAt,
            },
          })
        )
      )
    );

    await useCommandStore.getState().syncNow();

    const s = useCommandStore.getState();
    expect(s.activeTaskId).toBe("x");
    expect(s.isRunning).toBe(false);
    expect(s.sessionStartedAt).toBeNull();
    const logs = await db.timeLogs.toArray();
    expect(logs.map((l) => l.id)).toEqual(["log-phone-random"]);
    const x = await db.tasks.get("x");
    expect(x?.accumulatedSeconds).toBe(55);
    expect(x?.status).toBe("active");
  });

  it("keeps the local focus when the remote focus is older", async () => {
    const now = Date.now();
    await db.tasks.put(task("x", { status: "active", updatedAt: now }));
    useCommandStore.setState({
      activeTaskId: "x",
      isRunning: true,
      sessionStartedAt: now,
      focusUpdatedAt: now,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          serverBody({
            tasks: [task("x", { status: "active", updatedAt: now })],
            activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: now - 10 },
          })
        )
      )
    );

    await useCommandStore.getState().syncNow();
    expect(useCommandStore.getState().activeTaskId).toBe("x");
    expect(useCommandStore.getState().isRunning).toBe(true);
    expect(await db.timeLogs.count()).toBe(0);
  });
});
