import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { localStore, onLocalChange } from "@/lib/localStore";
import { hasLocalTaskTombstone } from "@/lib/syncEngine";
import type { Task } from "@/lib/domainTypes";

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

describe("localStore write invariants", () => {
  let changes = 0;
  let unsubscribe: () => void;

  beforeEach(async () => {
    window.localStorage.clear();
    await Promise.all([db.tasks.clear(), db.quests.clear(), db.habits.clear(), db.timeLogs.clear()]);
    changes = 0;
    unsubscribe = onLocalChange(() => {
      changes += 1;
    });
  });

  afterEach(() => {
    unsubscribe();
    vi.restoreAllMocks();
  });

  it("stamps an edit newer than a row from a clock that runs ahead (R6)", async () => {
    const future = Date.now() + 60_000;
    await db.tasks.add(task("t", { updatedAt: future }));
    expect(await localStore.updateTask("t", { title: "  edited  " })).toBe(true);
    const row = await db.tasks.get("t");
    expect(row?.title).toBe("edited");
    expect(row?.updatedAt).toBe(future + 1);
    expect(changes).toBe(1);
  });

  it("emits nothing when nothing was written", async () => {
    expect(await localStore.updateTask("missing", { title: "x" })).toBe(false);
    expect(await localStore.createTask({ title: "   ", questId: null })).toBe(false);
    expect(changes).toBe(0);
  });

  it("keeps the row when its tombstone cannot be saved (tombstone and delete are atomic)", async () => {
    await db.tasks.add(task("t"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await expect(localStore.deleteTask("t")).rejects.toThrow();
    expect(await db.tasks.get("t")).toBeDefined();
    expect(changes).toBe(0);
  });

  it("tombstones and deletes together, then emits once", async () => {
    await db.tasks.add(task("t"));
    await localStore.deleteTask("t");
    expect(await db.tasks.get("t")).toBeUndefined();
    expect(hasLocalTaskTombstone("t")).toBe(true);
    expect(changes).toBe(1);
  });

  it("completeQuest moves only open work to Other work; deleteQuest moves everything", async () => {
    await db.quests.add({
      id: "q",
      slotIndex: 0,
      code: "Q",
      title: "Q",
      description: "",
      accentColor: "cyan",
      targetWeeklyHours: 1,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
    });
    await db.tasks.bulkAdd([
      task("open", { questId: "q" }),
      task("done", { questId: "q", status: "completed", completedAt: 5 }),
    ]);
    await localStore.completeQuest("q");
    expect((await db.tasks.get("open"))?.questId).toBeNull();
    expect((await db.tasks.get("done"))?.questId).toBe("q");
    await localStore.deleteQuest("q");
    expect((await db.tasks.get("done"))?.questId).toBeNull();
    expect(await db.quests.get("q")).toBeUndefined();
  });

  it("sync-path writes can stay silent", async () => {
    await db.tasks.add(task("t", { status: "active" }));
    expect(await localStore.requeueIfActive("t", { notify: false })).toBe(true);
    expect(changes).toBe(0);
  });

  it("applies focus effects in order and reports whether anything was written", async () => {
    await db.tasks.bulkAdd([task("a", { status: "active" }), task("b")]);
    const start = Date.now() - 10_000;
    const wrote = await localStore.applyFocusEffects([
      { kind: "flush", taskId: "a", sessionStartedAt: start },
      { kind: "requeueIfActive", taskId: "a" },
      { kind: "markActive", taskId: "b" },
    ]);
    expect(wrote).toBe(true);
    const a = await db.tasks.get("a");
    expect(a?.status).toBe("queued");
    expect(a?.accumulatedSeconds).toBeGreaterThanOrEqual(10);
    expect((await db.tasks.get("b"))?.status).toBe("active");
    expect(await db.timeLogs.count()).toBe(1);
    // R3: flushing the same session again logs nothing.
    expect(await localStore.flushBurst("a", start)).toBe(0);
  });
});
