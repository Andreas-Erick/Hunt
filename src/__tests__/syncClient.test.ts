import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { db, type Quest, type Task, type TimeLog } from "@/lib/db";
import {
  createEmptySyncPayload,
  validateSyncPayload,
  type ActiveFocusState,
} from "@/lib/syncTypes";
import {
  SYNC_REQUEST_TIMEOUT_MS,
  SnapshotFormatError,
  buildLocalSyncPayload,
  describeSyncError,
  getClientSyncToken,
  importAndMergeSnapshotJson,
  performServerSync,
  recordDeletedTaskTombstone,
} from "@/lib/syncEngine";

const TOKEN_KEY = "hunt-sync-token-v1";
const TOMBSTONE_KEY = "hunt-sync-tombstones-v1";
const KEY64 = "ab12".repeat(16);
const NO_FOCUS: ActiveFocusState = {
  activeTaskId: null,
  isRunning: false,
  sessionStartedAt: null,
  updatedAt: 0,
};

/** Minimal fetch Response stand-in (same shape as the scheduler tests). */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    body: { cancel: async () => undefined },
  } as unknown as Response;
}

function okBody(extra: Record<string, unknown> = {}) {
  return { payload: { ...createEmptySyncPayload(), lastSyncedAt: 4242 }, ...extra };
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function headersOf(mock: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
  return (mock.mock.calls[call][1].headers ?? {}) as Record<string, string>;
}

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
}

/** Seeded PRNG (mulberry32) so fuzz failures are reproducible from the logged seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quest = (id: string): Quest => ({
  id,
  slotIndex: 0,
  code: "Q1",
  title: `Quest ${id}`,
  description: "",
  accentColor: "cyan",
  targetWeeklyHours: 5,
  archived: false,
  createdAt: 1000,
  updatedAt: 1000,
});

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  notes: "",
  questId: null,
  status: "queued",
  rank: 1000,
  accumulatedSeconds: 60,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const timeLog = (id: string, taskId: string): TimeLog => ({
  id,
  taskId,
  taskTitleSnapshot: `Task ${taskId}`,
  questId: null,
  questCodeSnapshot: "Other",
  accentColorSnapshot: "slate",
  startTime: 1000,
  endTime: 61_000,
  durationSeconds: 60,
  dateKey: "2026-11-18",
});

async function seedRows() {
  await db.quests.put(quest("quest-1000-aaaa"));
  await db.tasks.put(task("tsk-1000-bbbb", { questId: "quest-1000-aaaa" }));
  await db.timeLogs.put(timeLog("log-1000-tsk-1000-bbbb", "tsk-1000-bbbb"));
}

async function localSnapshot() {
  return {
    quests: await db.quests.toArray(),
    tasks: await db.tasks.toArray(),
    timeLogs: await db.timeLogs.toArray(),
    tombstones: window.localStorage.getItem(TOMBSTONE_KEY),
  };
}

/** console.error calls made by the sync diagnostics. */
function syncFailureLogs(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((c) => c[0] === "[hunt-sync] sync_failed");
}

type DexieTransaction = typeof db.transaction;

/** Makes db.transaction reject for one mode ("r" = build, "rw" = apply). */
function failTransactions(failMode: "r" | "rw", error: Error) {
  const real = db.transaction.bind(db) as (...args: unknown[]) => unknown;
  return vi
    .spyOn(db, "transaction")
    .mockImplementation(((mode: string, ...rest: unknown[]) =>
      mode === failMode ? Promise.reject(error) : real(mode, ...rest)) as unknown as DexieTransaction);
}

describe("desktop sync client (syncEngine.ts)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    window.localStorage.clear();
    setUrl("/");
    // A successful sync resets the failure-log de-duplication between tests.
    stubFetch(async () => jsonResponse(okBody()));
    expect((await performServerSync(NO_FOCUS)).ok).toBe(true);
    vi.unstubAllGlobals();
    // Expected failures below log diagnostics; keep the test output quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setUrl("/");
  });

  describe("pairing key (DDL-01)", () => {
    it("is '' with nothing stored, and the request then carries no X-Hunt-Token header", async () => {
      expect(getClientSyncToken()).toBe("");
      const fetchMock = stubFetch(async () => jsonResponse(okBody()));

      await expect(performServerSync(NO_FOCUS)).resolves.toMatchObject({ ok: true });

      const headers = headersOf(fetchMock);
      expect(headers).not.toHaveProperty("X-Hunt-Token");
      expect(headers["X-Hunt-Client"]).toBe("desktop");
    });

    it("sends a stored key as X-Hunt-Token", async () => {
      window.localStorage.setItem(TOKEN_KEY, KEY64);
      const fetchMock = stubFetch(async () => jsonResponse(okBody()));

      await performServerSync(NO_FOCUS);

      expect(headersOf(fetchMock)["X-Hunt-Token"]).toBe(KEY64);
    });

    it("is '' during server rendering (no window), even with a key stored", () => {
      window.localStorage.setItem(TOKEN_KEY, KEY64);
      vi.stubGlobal("window", undefined);

      expect(getClientSyncToken()).toBe("");
    });

    it("persists ?token=<64 chars>&x=1#h and strips only the token from the address bar", () => {
      const routerState = { __NA: true, tree: ["", {}] };
      window.history.replaceState(routerState, "", `/?token=${KEY64}&x=1#h`);
      const replace = vi.spyOn(window.history, "replaceState");

      expect(getClientSyncToken()).toBe(KEY64);

      expect(window.localStorage.getItem(TOKEN_KEY)).toBe(KEY64);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace.mock.calls[0][2]).toBe("/?x=1#h");
      // The framework's history state survives the rewrite.
      expect(window.history.state).toEqual(routerState);
      expect(window.location.search).toBe("?x=1");
      expect(window.location.hash).toBe("#h");
      // Already ingested: later calls read storage and leave the URL alone.
      expect(getClientSyncToken()).toBe(KEY64);
      expect(replace).toHaveBeenCalledTimes(1);
    });

    it("drops the '?' when the token was the only param and trims surrounding whitespace", () => {
      setUrl(`/?token=%20${KEY64}%0A`);
      expect(getClientSyncToken()).toBe(KEY64);
      expect(window.location.href).toBe(`${window.location.origin}/`);
    });

    it("a launcher key in the URL replaces an older stored key", () => {
      window.localStorage.setItem(TOKEN_KEY, "c".repeat(64));
      setUrl(`/?token=${KEY64}`);
      expect(getClientSyncToken()).toBe(KEY64);
      expect(window.localStorage.getItem(TOKEN_KEY)).toBe(KEY64);
    });

    it.each([
      ["a newline inside", `${"a".repeat(20)}\n${"b".repeat(20)}`],
      ["20 characters", "a".repeat(20)],
      ["31 characters", "a".repeat(31)],
      ["257 characters", "a".repeat(257)],
      ["an inner space", `${"a".repeat(20)} ${"b".repeat(20)}`],
      ["whitespace only", " ".repeat(40)],
      ["empty", ""],
      ["non-ASCII", "ü".repeat(40)],
      ["an emoji", "👨‍👩‍👧‍👦".repeat(10)],
      ["a NUL byte", `${"a".repeat(20)}\0${"b".repeat(20)}`],
    ])("ignores a URL token with %s (not stored, still stripped)", (_label, bad) => {
      setUrl(`/?token=${encodeURIComponent(bad)}&keep=1`);

      expect(getClientSyncToken()).toBe("");

      expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(window.location.search).toBe("?keep=1");
    });

    it.each([
      ["a newline inside", `${"a".repeat(20)}\n${"b".repeat(20)}`],
      ["20 characters", "a".repeat(20)],
      ["257 characters", "a".repeat(257)],
      ["non-ASCII", "é".repeat(40)],
    ])("ignores a stored key with %s", (_label, bad) => {
      window.localStorage.setItem(TOKEN_KEY, bad);
      expect(getClientSyncToken()).toBe("");
    });

    it.each([
      ["32 characters", "a".repeat(32)],
      ["256 characters", "z".repeat(256)],
      ["every printable ASCII symbol", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~0123456789"],
    ])("accepts a key of %s", (_label, good) => {
      setUrl(`/?token=${encodeURIComponent(good)}`);
      expect(getClientSyncToken()).toBe(good);
      expect(window.localStorage.getItem(TOKEN_KEY)).toBe(good);
    });

    it("keeps a URL key for this page when storage refuses to save it", async () => {
      vi.resetModules();
      const fresh = await import("@/lib/syncEngine");
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
      setUrl(`/?token=${KEY64}`);

      expect(fresh.getClientSyncToken()).toBe(KEY64);
      expect(window.location.search).toBe("");
      expect(fresh.getClientSyncToken()).toBe(KEY64);
    });

    it("property: only a trimmed 32–256 printable-ASCII key is ever stored or returned", () => {
      const seed = 0x5eed01;
      const rand = mulberry32(seed);
      const alphabet = ["a", "Z", "9", "-", "_", "~", " ", "\t", "\n", "\0", "é", "€", "😀", "%", "&", "=", "#", "+"];
      for (let i = 0; i < 200; i++) {
        window.localStorage.clear();
        const len = Math.floor(rand() * 300);
        let raw = "";
        for (let j = 0; j < len; j++) {
          raw += rand() < 0.8 ? "k" : alphabet[Math.floor(rand() * alphabet.length)];
        }
        setUrl(`/?token=${encodeURIComponent(raw)}&n=${i}`);

        const got = getClientSyncToken();

        const msg = `seed=${seed} iteration=${i} len=${len}`;
        const trimmed = raw.trim();
        const valid = /^[\x21-\x7E]{32,256}$/.test(trimmed);
        expect(got, msg).toBe(valid ? trimmed : "");
        expect(window.localStorage.getItem(TOKEN_KEY), msg).toBe(valid ? trimmed : null);
        expect(new URLSearchParams(window.location.search).has("token"), msg).toBe(false);
        expect(window.location.search, msg).toBe(`?n=${i}`);
      }
    });

    it("never stores a syncToken echoed in a 200 response", async () => {
      stubFetch(async () => jsonResponse(okBody({ syncToken: "f".repeat(64) })));

      await expect(performServerSync(NO_FOCUS)).resolves.toMatchObject({ ok: true });

      expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
      expect(window.localStorage.length).toBe(0);
    });

    it("the module source holds no 64-hex key literal", () => {
      const source = fs.readFileSync(path.resolve(__dirname, "..", "lib", "syncEngine.ts"), "utf8");
      expect(source).not.toMatch(/[0-9a-f]{64}/i);
    });
  });

  describe("server response validation (DDL-02)", () => {
    it.each([
      ["payload {}", { payload: {} }],
      ["payload {quests:{}}", { payload: { quests: {} } }],
      ["payload null", { payload: null }],
      ["payload []", { payload: [] }],
      ["payload missing", { lanUrls: ["http://x:3000"] }],
      ["body null", null],
      ["body []", []],
      ["body a string", "<script>alert(1)</script>"],
      ["timeLogs not an array", { payload: { quests: [], tasks: [], timeLogs: "x" } }],
    ])("%s gives bad_response and leaves IndexedDB untouched", async (_label, body) => {
      await seedRows();
      recordDeletedTaskTombstone("tsk-1-zzzz");
      const before = await localSnapshot();
      stubFetch(async () => jsonResponse(body));

      const res = await performServerSync(NO_FOCUS);

      expect(res).toEqual({ ok: false, error: "bad_response" });
      expect(await localSnapshot()).toEqual(before);
    });

    it("never stores a row whose title is not a string", async () => {
      stubFetch(async () =>
        jsonResponse({
          payload: {
            ...createEmptySyncPayload(),
            tasks: [{ id: "x", title: 5 }, task("tsk-2000-good")],
          },
        })
      );

      await performServerSync(NO_FOCUS);

      expect(await db.tasks.get("x")).toBeUndefined();
      for (const t of await db.tasks.toArray()) expect(typeof t.title).toBe("string");
    });

    it("applies a valid response and keeps the server's merge time", async () => {
      stubFetch(async () =>
        jsonResponse(
          okBody({
            payload: {
              ...createEmptySyncPayload(),
              tasks: [task("tsk-3000-new1")],
              lastSyncedAt: 4242,
            },
            lanUrls: ["http://192.168.2.136:3000", 7],
            peers: { phone: { lastSeenAt: 99 } },
          })
        )
      );

      const res = await performServerSync(NO_FOCUS);

      expect(res.ok).toBe(true);
      expect(res.changed).toBe(true);
      expect(res.merged?.lastSyncedAt).toBe(4242);
      expect(res.lanUrls).toEqual(["http://192.168.2.136:3000"]);
      expect(res.peers).toEqual({ phone: { lastSeenAt: 99 } });
      expect(await db.tasks.get("tsk-3000-new1")).toMatchObject({ title: "Task tsk-3000-new1" });
    });

    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-1", -1],
      ["0", 0],
      ["a string", "4242"],
    ])("falls back to a local stamp when the server's lastSyncedAt is %s", async (_l, stamp) => {
      stubFetch(async () =>
        jsonResponse({ payload: { ...createEmptySyncPayload(), lastSyncedAt: stamp } })
      );
      const res = await performServerSync(NO_FOCUS);
      expect(res.ok).toBe(true);
      const ts = res.merged?.lastSyncedAt ?? Number.NaN;
      expect(Number.isFinite(ts) && ts > 0).toBe(true);
    });

    it("a __proto__ key in the response neither pollutes Object.prototype nor reaches IndexedDB", async () => {
      const raw = `{"payload":{"quests":[],"tasks":[{"id":"tsk-4000-aaaa","title":"t","__proto__":{"polluted":1}}],"timeLogs":[],"__proto__":{"polluted":1}}}`;
      stubFetch(async () => jsonResponse(JSON.parse(raw)));

      await expect(performServerSync(NO_FOCUS)).resolves.toMatchObject({ ok: true });

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      const stored = await db.tasks.get("tsk-4000-aaaa");
      expect(stored).toMatchObject({ title: "t" });
      expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(false);
    });

    it("stores the validated copy, never the raw response rows (bad enum values do not reach IndexedDB)", async () => {
      const badQuest = { ...quest("quest-6000-aaaa"), accentColor: "magenta" };
      stubFetch(async () =>
        jsonResponse({ payload: { ...createEmptySyncPayload(), quests: [badQuest] } })
      );

      await expect(performServerSync(NO_FOCUS)).resolves.toMatchObject({ ok: true });

      const stored = await db.quests.get("quest-6000-aaaa");
      expect(stored).toBeDefined();
      expect(["cyan", "emerald", "amber"]).toContain(stored?.accentColor);
    });
  });

  describe("snapshot import (DDL-02)", () => {
    it.each(["{", "null", "[]", "{}", '{"quests":{}}', "", "   ", "x".repeat(10_000), '{"quests":[],"tasks":[]}'])(
      "rejects %j with SnapshotFormatError and leaves IndexedDB unchanged",
      async (text) => {
        await seedRows();
        const before = await localSnapshot();

        const err = await importAndMergeSnapshotJson(text, NO_FOCUS).then(
          () => null,
          (e: unknown) => e
        );

        expect(err).toBeInstanceOf(SnapshotFormatError);
        expect((err as Error).name).toBe("SnapshotFormatError");
        expect((err as Error).message.length).toBeGreaterThan(0);
        expect(await localSnapshot()).toEqual(before);
      }
    );

    it("an exported snapshot imports back into an emptied database", async () => {
      await seedRows();
      recordDeletedTaskTombstone("tsk-1-gone");
      const exported = await buildLocalSyncPayload(NO_FOCUS);
      const text = JSON.stringify(exported, null, 2);
      await db.quests.clear();
      await db.tasks.clear();
      await db.timeLogs.clear();
      window.localStorage.clear();

      await importAndMergeSnapshotJson(text, NO_FOCUS);

      const after = await buildLocalSyncPayload(NO_FOCUS);
      expect(after.quests).toEqual(exported.quests);
      expect(after.tasks).toEqual(exported.tasks);
      expect(after.timeLogs).toEqual(exported.timeLogs);
      expect(after.deletedTaskIds).toEqual(["tsk-1-gone"]);
    });

    it("merges a snapshot with the local rows (union, not replace)", async () => {
      await seedRows();
      const remote = { ...createEmptySyncPayload(), tasks: [task("tsk-5000-remo")] };

      await importAndMergeSnapshotJson(JSON.stringify(remote), NO_FOCUS);

      expect((await db.tasks.toArray()).map((t) => t.id).sort()).toEqual([
        "tsk-1000-bbbb",
        "tsk-5000-remo",
      ]);
      expect(await db.quests.count()).toBe(1);
      expect(await db.timeLogs.count()).toBe(1);
    });

    it("never stores a snapshot row whose title is not a string", async () => {
      const text = JSON.stringify({ quests: [], tasks: [{ id: "x", title: 5 }], timeLogs: [] });

      await importAndMergeSnapshotJson(text, NO_FOCUS).catch((e: unknown) => {
        expect((e as Error).name).toBe("SnapshotFormatError");
      });

      expect(await db.tasks.get("x")).toBeUndefined();
    });

    it("merges the validated copy, never the raw snapshot rows (bad enum values do not reach IndexedDB)", async () => {
      const badQuest = { ...quest("quest-7000-aaaa"), accentColor: "magenta" };
      const text = JSON.stringify({ ...createEmptySyncPayload(), quests: [badQuest] });

      await importAndMergeSnapshotJson(text, NO_FOCUS);

      const stored = await db.quests.get("quest-7000-aaaa");
      expect(stored).toBeDefined();
      expect(["cyan", "emerald", "amber"]).toContain(stored?.accentColor);
    });

    it("imports a snapshot with 5000-deep nesting and constructor.prototype bait without storing either key", async () => {
      const deep = "[".repeat(5000) + "]".repeat(5000);
      const text = `{"quests":[],"tasks":[{"id":"tsk-8000-aaaa","title":"t","deep":${deep},"constructor":{"prototype":{"polluted":1}}}],"timeLogs":[]}`;

      await importAndMergeSnapshotJson(text, NO_FOCUS);

      const stored = await db.tasks.get("tsk-8000-aaaa");
      expect(stored).toMatchObject({ title: "t" });
      expect(Object.prototype.hasOwnProperty.call(stored, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(stored, "deep")).toBe(false);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("lets a storage failure propagate unchanged (not as SnapshotFormatError)", async () => {
      const quota = new DOMException("Quota exceeded", "QuotaExceededError");
      failTransactions("rw", quota);
      const text = JSON.stringify(createEmptySyncPayload());

      await expect(importAndMergeSnapshotJson(text, NO_FOCUS)).rejects.toBe(quota);
    });

    it("fuzz: any input either imports or fails with SnapshotFormatError, never anything else", async () => {
      const seed = 0x1a2b3c;
      const rand = mulberry32(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
      const scalar = () =>
        pick<unknown>([null, 0, -1, Number.MAX_SAFE_INTEGER, "", "   ", "<script>alert(1)</script>", true, {}, []]);
      const rows = () =>
        rand() < 0.3
          ? scalar()
          : Array.from({ length: Math.floor(rand() * 3) }, (_, k) =>
              rand() < 0.5 ? scalar() : { id: rand() < 0.8 ? `fz-${k}` : scalar(), title: rand() < 0.8 ? "t" : scalar() }
            );
      await seedRows();
      for (let i = 0; i < 120; i++) {
        const msg = `seed=${seed} iteration=${i}`;
        const value =
          rand() < 0.15 ? scalar() : { quests: rows(), tasks: rows(), timeLogs: rows(), activeFocus: scalar() };
        const text = rand() < 0.1 ? JSON.stringify(value).slice(0, -1) : JSON.stringify(value);
        const before = await localSnapshot();

        const err = await importAndMergeSnapshotJson(text, NO_FOCUS).then(
          () => null,
          (e: unknown) => e
        );

        if (err !== null) {
          expect((err as Error).name, msg).toBe("SnapshotFormatError");
          expect(await localSnapshot(), msg).toEqual(before);
        }
        for (const t of await db.tasks.toArray()) {
          expect(typeof t.id === "string" && typeof t.title === "string", msg).toBe(true);
        }
      }
    });
  });

  describe("failure diagnostics (DDL-08)", () => {
    it("a rejected apply transaction yields local_db and three identical failures log once", async () => {
      window.localStorage.setItem(TOKEN_KEY, KEY64);
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      failTransactions("rw", new DOMException("Quota exceeded", "QuotaExceededError"));
      stubFetch(async () => jsonResponse(okBody()));

      for (let i = 0; i < 3; i++) {
        await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "local_db" });
      }

      const logs = syncFailureLogs(errors);
      expect(logs).toHaveLength(1);
      expect(logs[0][1]).toMatchObject({
        phase: "apply",
        code: "local_db",
        name: "QuotaExceededError",
        message: "Quota exceeded",
      });
      expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY64);
    });

    it("logs again after a success resets it, and when the code changes", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const responses = [401, 401, 200, 401, 503, 503];
      let n = 0;
      stubFetch(async () => {
        const status = responses[n++];
        return status === 200 ? jsonResponse(okBody()) : jsonResponse({ error: "x" }, status);
      });

      const codes: Array<string | undefined> = [];
      for (let i = 0; i < responses.length; i++) codes.push((await performServerSync(NO_FOCUS)).error);

      expect(codes).toEqual(["auth", "auth", undefined, "auth", "http_503", "http_503"]);
      expect(syncFailureLogs(errors).map((c) => c[1])).toEqual([
        { phase: "response", code: "auth", status: 401, name: undefined, message: undefined },
        { phase: "response", code: "auth", status: 401, name: undefined, message: undefined },
        { phase: "response", code: "http_503", status: 503, name: undefined, message: undefined },
      ]);
    });

    it("a failing local read is logged with phase build", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      failTransactions("r", new Error("read failed"));
      const fetchMock = stubFetch(async () => jsonResponse(okBody()));

      await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "local_db" });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(syncFailureLogs(errors)[0][1]).toMatchObject({ phase: "build", code: "local_db", name: "Error" });
    });

    it("an unparsable body is logged by error name only (no body text)", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => JSON.parse('{"payload": SECRET-ROW-TEXT'),
        }))
      );

      await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "bad_response" });

      const logs = syncFailureLogs(errors);
      expect(logs[0][1]).toMatchObject({ phase: "response", code: "bad_response", name: "SyntaxError" });
      expect(JSON.stringify(errors.mock.calls)).not.toContain("SECRET");
    });

    it("an invalid payload is logged with the validator's reason", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const invalid = { quests: {} };
      const reason = validateSyncPayload(invalid).error;
      stubFetch(async () => jsonResponse({ payload: invalid }));

      await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "bad_response" });

      expect(reason).toEqual(expect.any(String));
      expect(syncFailureLogs(errors)).toEqual([
        [
          "[hunt-sync] sync_failed",
          { phase: "response", code: "bad_response", status: undefined, name: undefined, message: reason },
        ],
      ]);
    });

    it("times out after SYNC_REQUEST_TIMEOUT_MS as unreachable and logs the AbortError", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let fetchStarted: (signal: AbortSignal) => void = () => undefined;
      const started = new Promise<AbortSignal>((resolve) => (fetchStarted = resolve));
      stubFetch(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            signal.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError"))
            );
            fetchStarted(signal);
          })
      );

      const pending = performServerSync(NO_FOCUS);
      const signal = await started;
      vi.advanceTimersByTime(SYNC_REQUEST_TIMEOUT_MS - 1);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);

      await expect(pending).resolves.toEqual({ ok: false, error: "unreachable" });
      expect(syncFailureLogs(errors)[0][1]).toMatchObject({
        phase: "request",
        code: "unreachable",
        name: "AbortError",
      });
    });

    it("a network error is logged with phase request", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      stubFetch(async () => Promise.reject(new TypeError("Failed to fetch")));

      await expect(performServerSync(NO_FOCUS)).resolves.toEqual({ ok: false, error: "unreachable" });

      expect(syncFailureLogs(errors)[0][1]).toMatchObject({
        phase: "request",
        name: "TypeError",
        message: "Failed to fetch",
      });
    });
  });

  describe("describeSyncError", () => {
    it.each([
      ["auth", "Pairing key missing or rejected. Open Hunt with the desktop launcher to load the key."],
      ["too_large", "Data is larger than the sync server accepts"],
      ["http_503", "Sync server could not save data; retrying (see %TEMP%\\hunt-server.log)"],
      ["http_507", "Server refused to overwrite its data file (see %TEMP%\\hunt-server.log)"],
      ["http_418", "Sync server error (HTTP 418)"],
      ["something_else", "Sync failed"],
      ["", ""],
      [null, ""],
      [undefined, ""],
    ])("%j → %j", (code, text) => {
      expect(describeSyncError(code)).toBe(text);
    });

    it("no longer quotes a fixed size limit", () => {
      expect(describeSyncError("too_large")).not.toMatch(/MB/);
    });
  });
});
