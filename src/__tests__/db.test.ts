import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, seedInitialDataIfNeeded as seedWithCheck } from "@/lib/db";
import { toLocalDateKey, formatChronoMMSS, formatTacticalDuration } from "@/lib/dateUtils";
import { QUEST_ACCENT_STYLES } from "@/lib/questAccents";
import { SEED_SERVER_CHECK_TIMEOUT_MS, syncDataExistsElsewhere } from "@/lib/syncEngine";
import { MAX_ENTITY_ID_LENGTH, isSafeSyncId } from "@/lib/syncTypes";

/** The seed as bootSequence wires it: with the real sync-side check. */
const seedInitialDataIfNeeded = () => seedWithCheck(syncDataExistsElsewhere);

describe("Database & Formatting Utilities (db.ts)", () => {
  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    await db.habits.clear();
    window.localStorage.clear();
  });

  describe("toLocalDateKey()", () => {
    it("formats a local Date timestamp into YYYY-MM-DD", () => {
      const localDate = new Date(2026, 10, 18, 14, 30, 0); // Nov 18, 2026
      expect(toLocalDateKey(localDate.getTime())).toBe("2026-11-18");
    });

    it("zero-pads single-digit months and days", () => {
      const janFifth = new Date(2026, 0, 5, 9, 5, 0); // Jan 5, 2026
      expect(toLocalDateKey(janFifth.getTime())).toBe("2026-01-05");
    });
  });

  describe("formatChronoMMSS()", () => {
    it("formats 0 seconds as 00:00", () => {
      const res = formatChronoMMSS(0);
      expect(res.formatted).toBe("00:00");
      expect(res.minutes).toBe("00");
      expect(res.seconds).toBe("00");
      expect(res.hoursPrefix).toBeNull();
    });

    it("clamps negative inputs to 00:00", () => {
      expect(formatChronoMMSS(-45).formatted).toBe("00:00");
    });

    it("formats sub-hour durations as MM:SS", () => {
      const res = formatChronoMMSS(2165); // 36m 05s
      expect(res.formatted).toBe("36:05");
      expect(res.minutes).toBe("36");
      expect(res.seconds).toBe("05");
      expect(res.hoursPrefix).toBeNull();
    });

    it("formats multi-hour durations as H:MM:SS", () => {
      const res = formatChronoMMSS(3665); // 1h 01m 05s
      expect(res.formatted).toBe("1:01:05");
      expect(res.hoursPrefix).toBe("1");
    });
  });

  describe("formatTacticalDuration()", () => {
    it("formats seconds, minutes, and hours cleanly", () => {
      expect(formatTacticalDuration(45)).toBe("45s");
      expect(formatTacticalDuration(125)).toBe("2m 05s");
      expect(formatTacticalDuration(5040)).toBe("1h 24m");
    });
  });

  describe("QUEST_ACCENT_STYLES", () => {
    it("defines styles for cyan, emerald, amber, and slate", () => {
      expect(QUEST_ACCENT_STYLES.cyan.hex).toBe("#00f0ff");
      expect(QUEST_ACCENT_STYLES.emerald.hex).toBe("#00ff9d");
      expect(QUEST_ACCENT_STYLES.amber.hex).toBe("#ffb800");
      expect(QUEST_ACCENT_STYLES.slate.hex).toBe("#64748b");
    });
  });

  /** The local sync server answers 200 with an empty payload (seeding allowed). */
  const emptyServerFetch = () =>
    vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          payload: {
            quests: [],
            tasks: [],
            timeLogs: [],
            deletedQuestIds: [],
            deletedTaskIds: [],
            deletedLogIds: [],
            activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
            lastSyncedAt: 1,
          },
        }),
      }) as unknown as Response
    );

  describe("seedInitialDataIfNeeded()", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", emptyServerFetch());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Spec: a starter template, not fabricated history. Review and the
    // heatmap must start empty, and nothing fake may sync to the phone.
    it("seeds 3 quests and queued starter tasks, with no history, on an empty database", async () => {
      await seedInitialDataIfNeeded();

      const quests = await db.quests.orderBy("slotIndex").toArray();
      expect(quests).toHaveLength(3);
      expect(quests[0].id).toBe("quest-slot-0");
      expect(quests[1].id).toBe("quest-slot-1");
      expect(quests[2].id).toBe("quest-slot-2");

      const tasks = await db.tasks.toArray();
      expect(tasks.length).toBeGreaterThan(5);
      for (const t of tasks) {
        expect(t.status, t.id).toBe("queued");
        expect(t.accumulatedSeconds, t.id).toBe(0);
        expect(t.completedAt, t.id).toBeUndefined();
      }

      expect(await db.timeLogs.count()).toBe(0);
    });

    it("dates the starter tasks today, tomorrow and the day after by calendar days", async () => {
      // 00:30 on the day after the 2026 EU spring-forward: now - 24 h lands two
      // calendar days back in DST zones; calendar stepping must not.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 2, 30, 0, 30));
      try {
        await seedInitialDataIfNeeded();
      } finally {
        vi.useRealTimers();
      }
      const dates = Array.from(new Set((await db.tasks.toArray()).map((t) => t.scheduledDate)));
      expect(dates.sort()).toEqual(["2026-03-30", "2026-03-31", "2026-04-01"]);
    });

    it("is idempotent and does not duplicate quests when called twice", async () => {
      await seedInitialDataIfNeeded();
      const firstTaskCount = await db.tasks.count();

      // Add a custom task and re-run seed
      await db.tasks.add({
        id: "custom-task",
        title: "Custom task",
        notes: "",
        questId: "quest-slot-0",
        status: "queued",
        rank: 500,
        accumulatedSeconds: 0,
        createdAt: Date.now(),
      });

      await seedInitialDataIfNeeded();
      const questsCount = await db.quests.count();
      const secondTaskCount = await db.tasks.count();

      expect(questsCount).toBe(3);
      expect(secondTaskCount).toBe(firstTaskCount + 1);
    });

    // Seeded rows sync like real ones, so their ids must pass the sync id rules.
    it("seeds only ids that the sync id validation accepts", async () => {
      await seedInitialDataIfNeeded();
      const quests = await db.quests.toArray();
      const tasks = await db.tasks.toArray();
      expect(quests.length).toBeGreaterThan(0);
      expect(tasks.length).toBeGreaterThan(0);

      const entityIds = [
        ...quests.map((q) => q.id),
        ...tasks.map((t) => t.id),
        ...tasks.flatMap((t) => (t.questId ? [t.questId] : [])),
      ];
      for (const id of entityIds) {
        expect(isSafeSyncId(id, MAX_ENTITY_ID_LENGTH), id).toBe(true);
      }
      // Every task's quest link points at a seeded quest.
      const questIds = new Set(quests.map((q) => q.id));
      for (const t of tasks) {
        if (t.questId) expect(questIds.has(t.questId), t.id).toBe(true);
      }
    });
  });

  describe("seedInitialDataIfNeeded() asks the local sync server first", () => {
    const jsonResponse = (body: unknown, status = 200) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      }) as unknown as Response;

    afterEach(() => {
      vi.unstubAllGlobals();
      window.localStorage.clear();
    });

    const emptyServer = {
      quests: [],
      tasks: [],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 1,
    };

    async function localCounts() {
      return [await db.quests.count(), await db.tasks.count(), await db.timeLogs.count()];
    }

    it("does not seed demo data when the server already holds rows", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          payload: {
            ...emptyServer,
            tasks: [
              {
                id: "real-task",
                title: "Real",
                notes: "",
                questId: null,
                status: "queued",
                rank: 1000,
                accumulatedSeconds: 0,
                createdAt: 1,
              },
            ],
          },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await seedInitialDataIfNeeded();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/sync");
      expect(init.method).toBe("GET");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(await localCounts()).toEqual([0, 0, 0]);
    });

    it("does not seed when the server only holds tombstones", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ payload: { ...emptyServer, deletedTaskIds: ["tsk-01"] } }))
      );
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);
    });

    it("does not seed when the server answers but its data cannot be read", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "x" }, 507)));
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);
    });

    it("seeds when the server is reachable but empty", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ payload: emptyServer })));
      await seedInitialDataIfNeeded();
      expect((await localCounts())[0]).toBe(3);
    });

    // The page is served by this same server: a failed check means "slow", not
    // "no server", and seeding then would push demo rows into the real dataset.
    it("does not seed when the server is unreachable (network error)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);
    });

    it("does not seed when the check is aborted (AbortError)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")))
      );
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);
    });

    it("does not seed when the server is slower than the check timeout (real abort)", async () => {
      // setImmediate stays real: fake-indexeddb schedules its requests with it.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        let signal: AbortSignal | undefined;
        const fetchMock = vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              signal = init?.signal ?? undefined;
              // Answers only after the client gave up (e.g. a cold next dev compile).
              init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted.", "AbortError"))
              );
            })
        );
        vi.stubGlobal("fetch", fetchMock);
        let settled = false;
        const seeding = seedInitialDataIfNeeded().then(() => {
          settled = true;
        });

        // The abort timer is armed just before fetch is called.
        for (let turn = 0; turn < 1000 && fetchMock.mock.calls.length === 0; turn++) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(SEED_SERVER_CHECK_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await seeding;
        expect(signal?.aborted).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(await localCounts()).toEqual([0, 0, 0]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not seed when a 2xx body is not JSON or not a sync payload", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("Unexpected token < in JSON");
            },
          }) as unknown as Response
        )
      );
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);

      vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ hello: "world" })));
      await seedInitialDataIfNeeded();
      expect(await localCounts()).toEqual([0, 0, 0]);
    });
  });
});
