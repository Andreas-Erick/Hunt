// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createEmptySyncPayload, type SyncPayload } from "@/lib/syncTypes";
import type { Task } from "@/lib/db";

// The route resolves its data directory at import time; point it at a
// throwaway directory so the real data/hunt-sync.json is never touched.
const KEY = "k".repeat(64);
let dir = "";
let route: typeof import("@/app/api/sync/route");

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

function body(p: Partial<SyncPayload>): SyncPayload {
  return { ...createEmptySyncPayload(), ...p };
}

function request(method: "GET" | "POST", client: string | null, payload?: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Hunt-Token": KEY,
  };
  if (client) headers["X-Hunt-Client"] = client;
  return new Request("http://192.168.2.136:3000/api/sync", {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

const syncFile = () => path.join(dir, "hunt-sync.json");
const backupFile = () => path.join(dir, "hunt-sync.backup.json");
const snapshotDir = () => path.join(dir, "backups");
const read = (f: string) => fs.readFileSync(f, "utf8");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("/api/sync route", () => {
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-sync-route-test-"));
    fs.writeFileSync(path.join(dir, "hunt-sync.key"), KEY, "utf8");
    process.env.HUNT_DATA_DIR = dir;
    route = await import("@/app/api/sync/route");
  });

  afterAll(() => {
    delete process.env.HUNT_DATA_DIR;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not advertise wildcard CORS (all clients are same-origin or native)", async () => {
    const res = await route.GET(request("GET", "desktop"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects requests without a valid token", async () => {
    const res = await route.POST(
      new Request("http://192.168.2.136:3000/api/sync", {
        method: "POST",
        headers: { "X-Hunt-Token": "wrong" },
        body: "{}",
      })
    );
    expect(res.status).toBe(401);
  });

  it("reports when the phone was last seen (desktop requests do not count)", async () => {
    let res = await route.POST(request("POST", "desktop", body({ tasks: [task("t1")] })));
    expect(res.status).toBe(200);
    let json = await res.json();
    expect(json.peers).toEqual({ phone: { lastSeenAt: null } });
    expect(json.payload.tasks.map((t: Task) => t.id)).toEqual(["t1"]);

    const before = Date.now();
    res = await route.POST(request("POST", "android", body({})));
    json = await res.json();
    expect(json.peers.phone.lastSeenAt).toBeGreaterThanOrEqual(before);

    res = await route.GET(request("GET", "desktop"));
    json = await res.json();
    expect(json.peers.phone.lastSeenAt).toBeGreaterThanOrEqual(before);
    expect(Array.isArray(json.lanUrls)).toBe(true);
  });

  it("does not rewrite hunt-sync.json when a sync brings nothing new", async () => {
    const contentBefore = read(syncFile());
    const backupBefore = fs.existsSync(backupFile()) ? read(backupFile()) : null;

    // Same content as stored; different key order and lastSyncedAt.
    const stored = JSON.parse(contentBefore) as SyncPayload;
    const echo = {
      ...stored,
      tasks: stored.tasks.map((t) => Object.fromEntries(Object.entries(t).reverse())),
      lastSyncedAt: Date.now(),
    };
    const res = await route.POST(request("POST", "mobile-web", echo));
    expect(res.status).toBe(200);

    expect(read(syncFile())).toBe(contentBefore);
    expect(fs.existsSync(backupFile()) ? read(backupFile()) : null).toBe(backupBefore);
  });

  it("on a real change keeps the previous version as backup plus a daily snapshot", async () => {
    const previous = read(syncFile());

    const res = await route.POST(
      request("POST", "desktop", body({ tasks: [task("t2", { createdAt: 2000, updatedAt: 2000 })] }))
    );
    expect(res.status).toBe(200);

    const now = JSON.parse(read(syncFile())) as SyncPayload;
    expect(now.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(read(backupFile())).toBe(previous);
    const snapshot = path.join(snapshotDir(), `hunt-sync-${today()}.json`);
    expect(read(snapshot)).toBe(previous);

    // A second change the same day updates the backup but not the daily snapshot.
    const second = read(syncFile());
    await route.POST(request("POST", "desktop", body({ tasks: [task("t3")] })));
    expect(read(backupFile())).toBe(second);
    expect(read(snapshot)).toBe(previous);
  });

  it("keeps only the newest 14 daily snapshots", async () => {
    fs.rmSync(path.join(snapshotDir(), `hunt-sync-${today()}.json`));
    for (let day = 1; day <= 20; day++) {
      fs.writeFileSync(
        path.join(snapshotDir(), `hunt-sync-2020-01-${String(day).padStart(2, "0")}.json`),
        "{}"
      );
    }

    await route.POST(request("POST", "desktop", body({ tasks: [task("t4")] })));

    const names = fs.readdirSync(snapshotDir()).sort();
    expect(names).toHaveLength(14);
    expect(names).toContain(`hunt-sync-${today()}.json`);
    expect(names).not.toContain("hunt-sync-2020-01-07.json");
    expect(names).toContain("hunt-sync-2020-01-08.json");
  });

  it("recovers from a corrupt main file via the backup without clobbering the backup", async () => {
    const goodBackup = read(backupFile());
    fs.writeFileSync(syncFile(), "{ corrupt", "utf8");

    const res = await route.POST(request("POST", "desktop", body({ tasks: [task("t5")] })));
    expect(res.status).toBe(200);

    expect(read(backupFile())).toBe(goodBackup);
    const restored = JSON.parse(read(syncFile())) as SyncPayload;
    const backupIds = (JSON.parse(goodBackup) as SyncPayload).tasks.map((t) => t.id);
    expect(restored.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([...backupIds, "t5"]));
  });

  it("refuses (507) to merge over sync files it cannot read, and leaves them untouched", async () => {
    fs.writeFileSync(syncFile(), "{ corrupt", "utf8");
    fs.writeFileSync(backupFile(), "also corrupt", "utf8");
    fs.rmSync(snapshotDir(), { recursive: true, force: true });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await route.POST(request("POST", "desktop", body({ tasks: [task("only-me")] })));
    expect(res.status).toBe(507);
    expect(read(syncFile())).toBe("{ corrupt");
    expect(read(backupFile())).toBe("also corrupt");

    const get = await route.GET(request("GET", "desktop"));
    expect(get.status).toBe(507);

    expect(errors).toHaveBeenCalledWith(
      "[hunt-sync] unreadable",
      { client: "desktop" },
      expect.any(String)
    );
    expect(JSON.stringify(errors.mock.calls)).not.toContain(KEY);
    errors.mockRestore();
  });
});
