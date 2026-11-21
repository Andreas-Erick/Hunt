import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { Task } from "@/lib/domainTypes";
import { createSyncScheduler, type SyncPassResult } from "@/lib/syncScheduler";
import { createEmptySyncPayload } from "@/lib/syncTypes";
import {
  disposeCommandStoreScheduler,
  setSyncTransport,
  useCommandStore,
} from "@/store/useCommandStore";
import { createInMemorySyncServer } from "./helpers/inMemorySyncServer";

type Code = "unreachable" | "http_401";

/** A manual clock + timer queue: the scheduler never touches global time. */
function harness(passes: Array<SyncPassResult<Code>>) {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  let runs = 0;
  const scheduler = createSyncScheduler<Code>({
    runOnce: async () => {
      runs += 1;
      return passes.shift() ?? { error: null, wroteLocal: false };
    },
    isTransient: (c) => c === "unreachable",
    loopErrorCode: "unreachable",
    now: () => now,
    random: () => 0, // jitter at its 50 % floor
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  return {
    scheduler,
    runs: () => runs,
    async advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
}

describe("createSyncScheduler (policy with an injected clock)", () => {
  it("backs off exponentially after transient failures, with jitter", async () => {
    const h = harness([
      { error: "unreachable", wroteLocal: false },
      { error: "unreachable", wroteLocal: false },
    ]);
    expect(await h.scheduler.syncNow()).toBe(false);
    expect(await h.scheduler.autoSync()).toBe(false); // paused 2.5 s (5 s · 50 %)
    await h.advance(2_500);
    expect(await h.scheduler.autoSync()).toBe(false); // ran and failed again → 5 s
    expect(h.runs()).toBe(2);
    await h.advance(4_999);
    expect(await h.scheduler.autoSync()).toBe(false);
    expect(h.runs()).toBe(2);
    await h.advance(1);
    expect(await h.scheduler.autoSync()).toBe(true);
    expect(h.runs()).toBe(3);
  });

  it("pauses auto-sync after a deterministic failure until a local edit requests a sync", async () => {
    const h = harness([{ error: "http_401", wroteLocal: false }]);
    await h.scheduler.syncNow();
    await h.advance(10 * 60_000);
    expect(await h.scheduler.autoSync()).toBe(false);
    expect(h.runs()).toBe(1);
    h.scheduler.request();
    await h.advance(300);
    expect(h.runs()).toBe(2);
  });

  it("reruns a pass that wrote local rows, at most 3 times", async () => {
    const wrote = { error: null, wroteLocal: true } as const;
    const h = harness([wrote, wrote, wrote, wrote, wrote]);
    expect(await h.scheduler.syncNow()).toBe(true);
    expect(h.runs()).toBe(4);
    // The leftover goes to a debounced request: a fresh loop whose first pass
    // (the 5th) also wrote, so it reruns once more and ends clean.
    await h.advance(300);
    expect(h.runs()).toBe(6);
  });

  it("coalesces calls made while a pass is in flight into one rerun", async () => {
    const h = harness([]);
    const first = h.scheduler.syncNow();
    const second = h.scheduler.syncNow();
    const third = h.scheduler.syncNow();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
    expect(h.runs()).toBe(2);
  });
});

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("store sync through the in-memory transport adapter", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await Promise.all([db.tasks.clear(), db.quests.clear(), db.habits.clear(), db.timeLogs.clear()]);
  });

  afterEach(() => {
    setSyncTransport(null);
    disposeCommandStoreScheduler();
  });

  it("pushes local rows and pulls another device's rows through the real merge", async () => {
    const server = createInMemorySyncServer();
    server.push({ ...createEmptySyncPayload(), tasks: [task("from-phone", { updatedAt: 5 })] });
    setSyncTransport(server.transport);
    await db.tasks.put(task("local"));

    expect(await useCommandStore.getState().syncNow()).toBe(true);

    expect(server.requests[0].tasks.map((t) => t.id)).toEqual(["local"]);
    expect((await db.tasks.get("from-phone"))?.title).toBe("from-phone");
    expect(server.state.tasks.map((t) => t.id).sort()).toEqual(["from-phone", "local"]);
    expect(useCommandStore.getState().syncError).toBeNull();
  });

  it("reports an HTTP failure from the server as the sync error", async () => {
    const server = createInMemorySyncServer();
    server.failNextWith(503);
    setSyncTransport(server.transport);
    expect(await useCommandStore.getState().syncNow()).toBe(false);
    expect(useCommandStore.getState().syncError).toBe("http_503");
  });
});
