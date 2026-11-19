// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, type MockInstance } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createEmptySyncPayload, mergeSyncPayloads, type SyncPayload } from "@/lib/syncTypes";
import type { Task, TimeLog } from "@/lib/db";

// Partial mock: everything is the real module, but the merge can be forced to
// throw so the route's 500 path is observable.
vi.mock("@/lib/syncTypes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/syncTypes")>();
  return { ...actual, mergeSyncPayloads: vi.fn(actual.mergeSyncPayloads) };
});

type Route = typeof import("@/app/api/sync/route");

const MAX_PAYLOAD_BYTES = 16_000_000;
const SEED = 0x5eed01;
const BASE_URL = "http://192.168.2.136:3000/api/sync";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToken(rand: () => number): string {
  let out = "";
  for (let i = 0; i < 64; i++) out += "0123456789abcdef"[Math.floor(rand() * 16)];
  return out;
}

const rand = mulberry32(SEED);
const KEY = hexToken(rand);

let dir = "";
let route: Route;

const keyFile = () => path.join(dir, "hunt-sync.key");
const syncFile = () => path.join(dir, "hunt-sync.json");
const tmpFile = () => path.join(dir, "hunt-sync.tmp.json");

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

function body(p: Partial<SyncPayload>): string {
  return JSON.stringify({ ...createEmptySyncPayload(), ...p });
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Hunt-Token": KEY,
    "X-Hunt-Client": "desktop",
    ...extra,
  };
}

function get(headers: Record<string, string>, url = BASE_URL): Request {
  return new Request(url, { method: "GET", headers });
}

function post(headers: Record<string, string>, payload?: string, url = BASE_URL): Request {
  return new Request(url, { method: "POST", headers, body: payload });
}

function silenceConsoleError(): MockInstance {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function loggedText(spy: MockInstance): string {
  return spy.mock.calls
    .map((args: unknown[]) =>
      args
        .map((a) =>
          a instanceof Error
            ? `${a.name}: ${a.message} ${a.stack ?? ""}`
            : typeof a === "string"
              ? a
              : JSON.stringify(a)
        )
        .join(" ")
    )
    .join("\n");
}

/** A client-facing error body: exactly `{ error }`, with no stack, path, env value or key. */
async function expectSafeError(
  res: Response,
  status: number,
  message: string,
  label?: string
): Promise<string> {
  expect(res.status, label).toBe(status);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ error: message });
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(dir);
  expect(text).not.toContain("\\");
  expect(text).not.toMatch(/\bat \S+ \(|\n\s+at /);
  expect(text).not.toContain("node_modules");
  return text;
}

function realisticLogs(count: number, taskIds: string[]): TimeLog[] {
  const t0 = 1_700_000_000_000;
  return Array.from({ length: count }, (_, i) => {
    const startTime = t0 + i * 3_600_000;
    const taskId = taskIds[i % taskIds.length];
    return {
      id: `log-${startTime}-${taskId}`,
      taskId,
      taskTitleSnapshot: `Deep work block ${i % taskIds.length}`,
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime,
      endTime: startTime + 1_500_000,
      durationSeconds: 1500,
      dateKey: new Date(startTime).toISOString().slice(0, 10),
    };
  });
}

describe("/api/sync security", () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-sync-security-test-"));
    fs.writeFileSync(keyFile(), KEY, "utf8");
    process.env.HUNT_DATA_DIR = dir;
    route = await import("@/app/api/sync/route");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete process.env.HUNT_DATA_DIR;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("authentication has no exemptions", () => {
    const spoofed: Array<{ name: string; url: string; headers: Record<string, string> }> = [
      {
        name: "Host localhost + X-Forwarded-For 127.0.0.1",
        url: BASE_URL,
        headers: { host: "localhost:3000", "x-forwarded-for": "127.0.0.1" },
      },
      {
        name: "Host 127.0.0.1 without X-Forwarded-For",
        url: "http://127.0.0.1:3000/api/sync",
        headers: { host: "127.0.0.1:3000" },
      },
      {
        name: "Host localhost + X-Forwarded-For ::1",
        url: "http://localhost:3000/api/sync",
        headers: { host: "localhost", "x-forwarded-for": "::1" },
      },
    ];

    for (const { name, url, headers } of spoofed) {
      it(`rejects a tokenless GET and POST claiming to be local (${name})`, async () => {
        const responses = [
          await route.GET(get(headers, url)),
          await route.POST(
            post({ ...headers, "Content-Type": "application/json" }, body({}), url)
          ),
        ];
        for (const res of responses) {
          expect(res.status).toBe(401);
          const text = await res.text();
          expect(text).not.toContain(KEY);
          expect(text).not.toContain("syncToken");
        }
      });
    }

    it("never accepts the key as a ?token= query parameter", async () => {
      const url = `${BASE_URL}?token=${KEY}`;
      expect((await route.GET(get({}, url))).status).toBe(401);
      expect(
        (await route.POST(post({ "Content-Type": "application/json" }, body({}), url))).status
      ).toBe(401);
      expect((await route.GET(get({ "X-Hunt-Token": "wrong" }, url))).status).toBe(401);
    });

    it("rejects wrong, malformed and boundary tokens", async () => {
      const flipped = KEY.slice(0, -1) + (KEY.endsWith("0") ? "1" : "0");
      const wrong = [
        "",
        "   ",
        flipped,
        KEY.slice(1),
        `${KEY}0`,
        `Bearer ${KEY}`,
        "a".repeat(10_000),
        "é".repeat(64), // same length, more UTF-8 bytes than the key
        "<script>alert(1)</script>",
        "' OR 1=1 --",
        "; cat /etc/passwd",
      ];
      for (const token of wrong) {
        const res = await route.GET(get({ "X-Hunt-Token": token }));
        expect(res.status, `token ${JSON.stringify(token.slice(0, 40))}`).toBe(401);
      }
    });

    it("accepts the header token and never echoes the key back", async () => {
      for (const headers of [
        authed(),
        authed({ host: "localhost:3000", "x-forwarded-for": "127.0.0.1" }),
      ]) {
        const res = await route.GET(get(headers));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain(KEY);
        expect(JSON.parse(text)).not.toHaveProperty("syncToken");

        const posted = await route.POST(post(headers, body({})));
        expect(posted.status).toBe(200);
        const postedText = await posted.text();
        expect(postedText).not.toContain(KEY);
        expect(JSON.parse(postedText)).not.toHaveProperty("syncToken");
        expect(posted.headers.get("Access-Control-Allow-Origin")).toBeNull();
      }
    });
  });

  describe("fails closed when the sync key is unavailable", () => {
    // The real key plus 40 seeded random 64-hex tokens, each with a reproducible label.
    const tokens = () => {
      const seeded = mulberry32(SEED + 1);
      return [KEY, ...Array.from({ length: 40 }, () => hexToken(seeded))].map((token, i) => ({
        token,
        label: `seed ${SEED + 1} token #${i}`,
      }));
    };

    it("answers 503 for every 64-hex token when the key file cannot be read", async () => {
      const errors = silenceConsoleError();
      const realRead = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        if (file === keyFile()) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return (realRead as (...args: unknown[]) => unknown)(file, ...rest);
      }) as unknown as typeof fs.readFileSync);

      for (const { token, label } of tokens()) {
        const res = await route.GET(get({ "X-Hunt-Token": token }));
        await expectSafeError(res, 503, "Sync key unavailable on the server", label);
        const posted = await route.POST(post(authed({ "X-Hunt-Token": token }), body({})));
        expect(posted.status, label).toBe(503);
      }

      // Logged once per outage, with a stable event name, the sanitized client
      // label of the request that hit it, and never the key.
      const keyEvents = errors.mock.calls.filter((c) => c[0] === "[hunt-sync] key_unavailable");
      expect(keyEvents).toHaveLength(1);
      expect(keyEvents[0][1]).toEqual({ client: "unknown" });
      expect(loggedText(errors)).not.toContain(KEY);

      // The key file is left alone (no silent regeneration) and works again.
      vi.mocked(fs.readFileSync).mockRestore();
      expect(fs.readFileSync(keyFile(), "utf8")).toBe(KEY);
      expect((await route.GET(get(authed()))).status).toBe(200);
    });

    it("answers 503 when the key file is missing and cannot be created", async () => {
      silenceConsoleError();
      const realWrite = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation(((
        file: fs.PathOrFileDescriptor,
        ...rest: unknown[]
      ) => {
        if (file === keyFile()) {
          throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
        }
        return (realWrite as (...args: unknown[]) => unknown)(file, ...rest);
      }) as unknown as typeof fs.writeFileSync);
      fs.rmSync(keyFile());
      try {
        for (const { token, label } of tokens()) {
          const res = await route.GET(get({ "X-Hunt-Token": token }));
          expect(res.status, label).toBe(503);
          const posted = await route.POST(post(authed({ "X-Hunt-Token": token }), body({})));
          expect(posted.status, label).toBe(503);
        }
        expect(fs.existsSync(keyFile())).toBe(false);
      } finally {
        vi.mocked(fs.writeFileSync).mockRestore();
        fs.writeFileSync(keyFile(), KEY, "utf8");
      }
    });

    it("answers 503 when the data directory sits under a regular file", async () => {
      silenceConsoleError();
      const blocker = path.join(dir, "not-a-directory");
      fs.writeFileSync(blocker, "x", "utf8");
      process.env.HUNT_DATA_DIR = path.join(blocker, "data");
      vi.resetModules();
      const blocked: Route = await import("@/app/api/sync/route");
      process.env.HUNT_DATA_DIR = dir;

      for (const { token, label } of tokens()) {
        const res = await blocked.GET(get({ "X-Hunt-Token": token }));
        expect(res.status, label).toBe(503);
        const posted = await blocked.POST(post(authed({ "X-Hunt-Token": token }), body({})));
        expect(posted.status, label).toBe(503);
      }
    });
  });

  describe("content type", () => {
    it("rejects non-JSON media types with 415 and leaves the stored file untouched", async () => {
      const seeded = await route.POST(post(authed(), body({ tasks: [task("ct-1")] })));
      expect(seeded.status).toBe(200);
      const before = fs.readFileSync(syncFile(), "utf8");

      const change = body({ tasks: [task("ct-2")] });
      for (const type of [
        "text/plain",
        "text/plain;charset=UTF-8",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "application/jsonp",
        "application/json-patch+json",
        "text/json",
        "",
      ]) {
        const res = await route.POST(post(authed({ "Content-Type": type }), change));
        await expectSafeError(res, 415, "Content-Type must be application/json");
      }
      const noType = await route.POST(
        new Request(BASE_URL, { method: "POST", headers: { "X-Hunt-Token": KEY } })
      );
      expect(noType.status).toBe(415);
      expect(fs.readFileSync(syncFile(), "utf8")).toBe(before);
    });

    it("accepts application/json with parameters, any case and spacing", async () => {
      for (const type of [
        "application/json; charset=utf-8",
        "Application/JSON ; charset=UTF-8",
        "application/json",
      ]) {
        const res = await route.POST(
          post(authed({ "Content-Type": type }), body({ tasks: [task(`ct-ok-${type.length}`)] }))
        );
        expect(res.status, type).toBe(200);
      }
    });
  });

  describe("body size cap", () => {
    it("rejects an oversized declared Content-Length before reading the body", async () => {
      const cases: Array<[string, number]> = [
        ["999999999", 413],
        [String(MAX_PAYLOAD_BYTES + 1), 413],
        ["1e9", 413],
        [String(MAX_PAYLOAD_BYTES), 200],
        ["0", 200],
        ["-1", 200],
        ["abc", 200],
      ];
      for (const [declared, status] of cases) {
        const res = await route.POST(post(authed({ "Content-Length": declared }), body({})));
        expect(res.status, `content-length ${declared}`).toBe(status);
        if (status === 413) {
          await expectSafeError(res, 413, "Payload exceeds the server size limit");
        }
      }
    });

    it(
      "cancels a streamed body as soon as it crosses the cap",
      async () => {
        const chunk = new Uint8Array(64 * 1024).fill(0x20);
        let pulls = 0;
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        });
        const res = await route.POST(
          new Request(BASE_URL, {
            method: "POST",
            headers: authed(),
            body: stream,
            duplex: "half",
          } as RequestInit)
        );
        await expectSafeError(res, 413, "Payload exceeds the server size limit");
        expect(cancelled).toBe(true);
        expect(pulls).toBeLessThanOrEqual(Math.ceil(MAX_PAYLOAD_BYTES / chunk.byteLength) + 4);
      },
      30_000
    );

    it(
      "counts UTF-8 bytes, not string length",
      async () => {
        const count = Math.floor(MAX_PAYLOAD_BYTES / 3) + 1; // '€' is 3 bytes in UTF-8
        const euros = "€".repeat(count);
        expect(euros.length).toBeLessThan(MAX_PAYLOAD_BYTES);
        expect(Buffer.byteLength(euros, "utf8")).toBeGreaterThan(MAX_PAYLOAD_BYTES);
        const res = await route.POST(post(authed(), euros));
        expect(res.status).toBe(413);
      },
      30_000
    );

    it(
      "accepts a body of exactly the cap and rejects one byte more",
      async () => {
        const json = body({ tasks: [task("cap-edge")] });
        const exact = json + " ".repeat(MAX_PAYLOAD_BYTES - Buffer.byteLength(json, "utf8"));
        expect(Buffer.byteLength(exact, "utf8")).toBe(MAX_PAYLOAD_BYTES);
        expect((await route.POST(post(authed(), exact))).status).toBe(200);
        expect((await route.POST(post(authed(), `${exact} `))).status).toBe(413);
      },
      30_000
    );

    it(
      "syncs 20,000 realistic time logs (above the old 2 MB cap, within the count caps)",
      async () => {
        const taskIds = Array.from({ length: 40 }, (_, i) => `tsk-${1_700_000_000_000 + i}-ab12`);
        const payload = body({
          tasks: taskIds.map((id, i) => task(id, { rank: (i + 1) * 1000 })),
          timeLogs: realisticLogs(20_000, taskIds),
        });
        expect(payload.length).toBeGreaterThan(2_000_000);

        const res = await route.POST(post(authed({ "X-Hunt-Client": "android" }), payload));
        expect(res.status).toBe(200);
        const json = (await res.json()) as { payload: SyncPayload };
        expect(json.payload.timeLogs).toHaveLength(20_000);
        const stored = JSON.parse(fs.readFileSync(syncFile(), "utf8")) as SyncPayload;
        expect(stored.timeLogs).toHaveLength(20_000);
      },
      60_000
    );

    it(
      "refuses (507) to store a merged state over the cap, even when each body fits",
      async () => {
        // Fresh, empty data directory so the sizes below are exact.
        const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-sync-merged-cap-test-"));
        fs.writeFileSync(path.join(freshDir, "hunt-sync.key"), KEY, "utf8");
        process.env.HUNT_DATA_DIR = freshDir;
        vi.resetModules();
        const fresh: Route = await import("@/app/api/sync/route");
        process.env.HUNT_DATA_DIR = dir;
        const errors = silenceConsoleError();
        try {
          const batch = (prefix: string) =>
            body({
              tasks: Array.from({ length: 480 }, (_, i) =>
                task(`tsk-${prefix}-${i}`, { notes: "n".repeat(19_000) })
              ),
            });
          const first = batch("a");
          const second = batch("b");
          expect(first.length).toBeLessThan(MAX_PAYLOAD_BYTES);
          expect(first.length + second.length).toBeGreaterThan(MAX_PAYLOAD_BYTES);

          expect((await fresh.POST(post(authed(), first))).status).toBe(200);
          const stored = fs.readFileSync(path.join(freshDir, "hunt-sync.json"), "utf8");

          const res = await fresh.POST(post(authed(), second));
          await expectSafeError(res, 507, "Merged data exceeds server limits: size limit reached");
          expect(fs.readFileSync(path.join(freshDir, "hunt-sync.json"), "utf8")).toBe(stored);
          expect(errors.mock.calls.some((c) => c[0] === "[hunt-sync] merged_over_limit")).toBe(true);
        } finally {
          fs.rmSync(freshDir, { recursive: true, force: true });
        }
      },
      60_000
    );
  });

  describe("storage and internal failures", () => {
    it("answers 503 when the file cannot be written, keeps the previous data and logs safely", async () => {
      const seeded = await route.POST(post(authed(), body({ tasks: [task("w-1")] })));
      expect(seeded.status).toBe(200);
      const previous = fs.readFileSync(syncFile(), "utf8");
      const previousIds = (JSON.parse(previous) as SyncPayload).tasks.map((t) => t.id);

      const errors = silenceConsoleError();
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${tmpFile()}'`), {
          code: "EPERM",
        });
      });
      const hostileClient = `desk top<script>alert(1)</script>${"x".repeat(100)}`;
      const res = await route.POST(
        post(authed({ "X-Hunt-Client": hostileClient }), body({ tasks: [task("w-2")] }))
      );
      const text = await expectSafeError(res, 503, "Server could not save sync data");
      expect(text).not.toMatch(/[\\/]/);

      expect(fs.readFileSync(syncFile(), "utf8")).toBe(previous);
      expect(fs.existsSync(tmpFile())).toBe(false);
      const after = await route.GET(get(authed()));
      expect(after.status).toBe(200);
      const afterJson = (await after.json()) as { payload: SyncPayload };
      expect(afterJson.payload.tasks.map((t) => t.id)).toEqual(previousIds);

      const writeEvent = errors.mock.calls.find((c) => c[0] === "[hunt-sync] write_failed");
      expect(writeEvent).toBeDefined();
      const context = writeEvent?.[1] as { client: string };
      expect(context.client).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
      expect(context.client).toBe("desktopscriptalert1scriptxxxxxxx");
      expect(loggedText(errors)).not.toContain(KEY);

      // The same POST succeeds once the disk recovers.
      const retry = await route.POST(post(authed(), body({ tasks: [task("w-2")] })));
      expect(retry.status).toBe(200);
      const stored = JSON.parse(fs.readFileSync(syncFile(), "utf8")) as SyncPayload;
      expect(stored.tasks.map((t) => t.id)).toContain("w-2");
    });

    it("answers 500 without details when the merge throws", async () => {
      const errors = silenceConsoleError();
      vi.mocked(mergeSyncPayloads).mockImplementationOnce(() => {
        throw new TypeError(`Cannot read properties of undefined (reading 'id') at ${dir}`);
      });
      const res = await route.POST(post(authed(), body({ tasks: [task("m-1")] })));
      const text = await expectSafeError(res, 500, "Internal sync error");
      expect(text).not.toMatch(/[\\/]/);
      expect(errors.mock.calls.some((c) => c[0] === "[hunt-sync] post_error")).toBe(true);
      expect(loggedText(errors)).not.toContain(KEY);
    });

    it("answers 400 for malformed JSON without echoing the input", async () => {
      for (const raw of [
        "",
        "   ",
        "{ not json",
        "[",
        '"unterminated',
        '{"tasks": []}}',
        "{ <script>alert(1)</script>",
      ]) {
        const res = await route.POST(post(authed(), raw));
        await expectSafeError(res, 400, "Malformed JSON payload");
      }
      for (const raw of ["null", "42", "[]", '"text"']) {
        const res = await route.POST(post(authed(), raw));
        expect(res.status, raw).toBe(400);
        expect(((await res.json()) as { error: string }).error).not.toBe("Malformed JSON payload");
      }
    });

    it("answers with exactly the state it stored (re-validated), not the raw merge", async () => {
      const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
      const first = await route.POST(post(authed(), body({ deletedTaskIds: ids("del-a", 5000) })));
      expect(first.status).toBe(200);

      // The raw union holds 5010 task tombstones; the stored state keeps the newest 5000.
      const res = await route.POST(post(authed(), body({ deletedTaskIds: ids("del-b", 10) })));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { payload: SyncPayload };
      const stored = JSON.parse(fs.readFileSync(syncFile(), "utf8")) as SyncPayload;
      expect(stored.deletedTaskIds).toHaveLength(5000);
      expect(stored.deletedTaskIds).toContain("del-b-9");
      expect(json.payload).toEqual(stored);
    });
  });

  it("route source holds no 64-hex key literal and no key echo", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "api", "sync", "route.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/[0-9a-f]{64}/i);
    expect(source).not.toContain("syncToken");
    expect(source).not.toContain("searchParams");
  });
});
