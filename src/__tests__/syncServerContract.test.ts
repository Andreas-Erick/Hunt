// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createEmptySyncPayload, type SyncPayload } from "@/lib/syncTypes";
import type { Task } from "@/lib/domainTypes";

type Route = typeof import("@/app/api/sync/route");

const KEY = "s".repeat(64);
const CORRELATION_ID = "audit-corr-0001";
let dir = "";
let route: Route;

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

function post(payload: unknown, extra: Record<string, string> = {}): Request {
  return new Request("http://192.168.1.5:3000/api/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hunt-Token": KEY,
      "X-Hunt-Client": "desktop",
      "X-Hunt-Correlation-Id": CORRELATION_ID,
      ...extra,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

function body(p: Partial<SyncPayload>): SyncPayload {
  return { ...createEmptySyncPayload(), ...p };
}

function silenceConsoleError(): MockInstance {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-sync-audit-test-"));
  fs.writeFileSync(path.join(dir, "hunt-sync.key"), KEY, "utf8");
  process.env.HUNT_DATA_DIR = dir;
  vi.resetModules();
  route = await import("@/app/api/sync/route");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HUNT_DATA_DIR;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("every error envelope carries a stable code", () => {
  it("401 unauthorized, 400 invalid_payload", async () => {
    const denied = await route.POST(post(body({}), { "X-Hunt-Token": "wrong" }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({
      code: "unauthorized",
      error: "Unauthorized: Invalid or missing X-Hunt-Token",
    });
    expect(denied.headers.get("X-Hunt-Correlation-Id")).toBe(CORRELATION_ID);

    const invalid = await route.POST(post({ quests: "nope" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      code: "invalid_payload",
      error: "Invalid or oversized quests array",
    });
  });

  it("507 for an unreadable server file is server_data_unreadable, not merged_over_limit", async () => {
    silenceConsoleError();
    fs.writeFileSync(syncFile(), "{ corrupt", "utf8");
    const res = await route.POST(post(body({ tasks: [task("t1")] })));
    expect(res.status).toBe(507);
    expect(await res.json()).toEqual({
      code: "server_data_unreadable",
      error: "Server sync data is unreadable; refusing to overwrite it",
    });
  });
});

describe("the task count cap is no longer the binding limit", () => {
  it("stores and returns 5001 tasks", async () => {
    const tasks = Array.from({ length: 5001 }, (_, i) => task(`tsk-${i}`, { rank: i }));
    const res = await route.POST(post(body({ tasks })));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { payload: SyncPayload };
    expect(json.payload.tasks).toHaveLength(5001);
    const stored = JSON.parse(fs.readFileSync(syncFile(), "utf8")) as SyncPayload;
    expect(stored.tasks).toHaveLength(5001);
  });
});

describe("the temp file is flushed to disk before the rename", () => {
  it("fsyncs the temp file, then renames it over hunt-sync.json", async () => {
    const order: string[] = [];
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      order.push("fsync");
      realFsync(fd);
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      order.push(`rename:${path.basename(String(from))}`);
      realRename(from, to);
    });

    const res = await route.POST(post(body({ tasks: [task("t1")] })));

    expect(res.status).toBe(200);
    expect(order).toEqual(["fsync", "rename:hunt-sync.tmp.json"]);
    expect(fs.existsSync(tmpFile())).toBe(false);
    expect((JSON.parse(fs.readFileSync(syncFile(), "utf8")) as SyncPayload).tasks[0].id).toBe("t1");
  });
});

describe("server log lines carry the correlation id and the stack", () => {
  it("write_failed and backup_failed name the request's correlation id", async () => {
    expect((await route.POST(post(body({ tasks: [task("t1")] })))).status).toBe(200);
    const errors = silenceConsoleError();
    vi.spyOn(fs, "copyFileSync").mockImplementation(() => {
      throw new Error("EBUSY: resource busy");
    });
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("EPERM: operation not permitted");
    });

    const res = await route.POST(post(body({ tasks: [task("t2")] })));
    expect(res.status).toBe(503);

    for (const event of ["[hunt-sync] backup_failed", "[hunt-sync] write_failed"]) {
      const call = errors.mock.calls.find((c) => c[0] === event);
      expect(call, event).toBeDefined();
      expect(call?.[1]).toEqual({ client: "desktop", correlationId: CORRELATION_ID });
    }
  });

  it("post_error logs a redacted stack and the duration, the response stays generic", async () => {
    const errors = silenceConsoleError();
    const realExists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (p === syncFile()) throw new TypeError(`unexpected failure with key ${KEY.replace(/s/g, "a")}`);
      return realExists(p);
    });

    const res = await route.POST(post(body({ tasks: [task("t1")] })));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: "internal", error: "Internal sync error" });

    const call = errors.mock.calls.find((c) => c[0] === "[hunt-sync] post_error");
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual({
      client: "desktop",
      correlationId: CORRELATION_ID,
      durationMs: expect.any(Number),
    });
    const detail = call?.[2] as { name?: string; message: string; stack?: string };
    expect(detail.name).toBe("TypeError");
    expect(detail.stack).toMatch(/TypeError/);
    expect(detail.stack).toMatch(/\n\s+at /);
    expect(JSON.stringify(call)).not.toContain("a".repeat(64));
  });
});
