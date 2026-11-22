import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import type { Quest, Task, TimeLog } from "@/lib/domainTypes";
import {
  canonicalString,
  compareRank,
  createEmptySyncPayload,
  losingSessionEndAt,
  mergeSyncPayloads,
  pickLogWinner,
  pickRowWinner,
  syncContentKey,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";
import {
  applyMergedPayloadToLocalDB,
  buildLocalSyncPayload,
  recordDeletedTaskTombstone,
} from "@/lib/syncEngine";

const NO_FOCUS = {
  activeTaskId: null,
  isRunning: false,
  sessionStartedAt: null,
  updatedAt: 0,
};

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
    updatedAt: 1000,
    ...overrides,
  };
}

function log(id: string, taskId: string, overrides: Partial<TimeLog> = {}): TimeLog {
  return {
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
    ...overrides,
  };
}

function payload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return { ...createEmptySyncPayload(), ...overrides };
}

function getTombstones() {
  return JSON.parse(
    window.localStorage.getItem("hunt-sync-tombstones-v1") ?? "{}"
  ) as { deletedQuestIds?: string[]; deletedTaskIds?: string[]; deletedLogIds?: string[] };
}

describe("applyMergedPayloadToLocalDB (diff-apply against current local rows)", () => {
  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let a stale merged row overwrite a newer local edit (but keeps max accumulatedSeconds)", async () => {
    await db.tasks.put(
      task("t1", { title: "Edited locally", status: "completed", updatedAt: 5000, accumulatedSeconds: 100 })
    );
    await db.quests.put(quest("q1", { title: "Renamed locally", updatedAt: 5000 }));

    // The server's merge of a snapshot taken BEFORE the local edits.
    const stale = payload({
      tasks: [task("t1", { title: "Old title", status: "queued", updatedAt: 1000, accumulatedSeconds: 160 })],
      quests: [quest("q1", { title: "Old quest title", updatedAt: 1000 })],
    });

    const changed = await applyMergedPayloadToLocalDB(stale);
    expect(changed).toBe(true); // accumulatedSeconds was raised

    const t1 = await db.tasks.get("t1");
    expect(t1?.title).toBe("Edited locally");
    expect(t1?.status).toBe("completed");
    expect(t1?.accumulatedSeconds).toBe(160);
    expect((await db.quests.get("q1"))?.title).toBe("Renamed locally");
  });

  it("applies newer remote rows; server-side questId sanitising (same stamp) is applied", async () => {
    await db.tasks.bulkPut([
      task("newer", { title: "local", updatedAt: 1000 }),
      task("tie", { questId: "q-gone", updatedAt: 2000 }),
    ]);

    await applyMergedPayloadToLocalDB(
      payload({
        tasks: [
          task("newer", { title: "remote", updatedAt: 3000 }),
          // Server-side sanitising (questId nulled) carries the same updatedAt,
          // and the response carries the quest tombstone that caused it.
          task("tie", { questId: null, updatedAt: 2000 }),
          task("brand-new", { title: "from phone" }),
        ],
        deletedQuestIds: ["q-gone"],
      })
    );

    expect((await db.tasks.get("newer"))?.title).toBe("remote");
    expect((await db.tasks.get("tie"))?.questId).toBeNull();
    expect((await db.tasks.get("brand-new"))?.title).toBe("from phone");
  });

  it("R1: equal timestamps with different content resolve to the canonically smaller row, from either side", async () => {
    // "Alpha" < "Beta": the row titled Alpha wins wherever it comes from.
    await db.tasks.bulkPut([
      task("local-smaller", { title: "Alpha", updatedAt: 2000, accumulatedSeconds: 10 }),
      task("remote-smaller", { title: "Beta", updatedAt: 2000 }),
      task("same", { title: "Same", updatedAt: 2000, accumulatedSeconds: 5 }),
      task("same-all", { title: "Same", updatedAt: 2000 }),
    ]);
    await db.quests.bulkPut([
      quest("q-local-smaller", { title: "Alpha", updatedAt: 2000 }),
      quest("q-remote-smaller", { title: "Beta", updatedAt: 2000 }),
    ]);
    const taskPut = vi.spyOn(db.tasks, "bulkPut");

    await applyMergedPayloadToLocalDB(
      payload({
        tasks: [
          task("local-smaller", { title: "Beta", updatedAt: 2000, accumulatedSeconds: 99 }),
          task("remote-smaller", { title: "Alpha", updatedAt: 2000 }),
          // Same content, only accumulatedSeconds differs: keep the local row, max() the counter.
          task("same", { title: "Same", updatedAt: 2000, accumulatedSeconds: 7 }),
          task("same-all", { title: "Same", updatedAt: 2000 }),
        ],
        quests: [
          quest("q-local-smaller", { title: "Beta", updatedAt: 2000 }),
          quest("q-remote-smaller", { title: "Alpha", updatedAt: 2000 }),
        ],
      })
    );

    const ls = await db.tasks.get("local-smaller");
    expect(ls?.title).toBe("Alpha");
    expect(ls?.accumulatedSeconds).toBe(99); // the counter is max()ed independently
    expect((await db.tasks.get("remote-smaller"))?.title).toBe("Alpha");
    expect((await db.tasks.get("same"))?.accumulatedSeconds).toBe(7);
    expect((await db.quests.get("q-local-smaller"))?.title).toBe("Alpha");
    expect((await db.quests.get("q-remote-smaller"))?.title).toBe("Alpha");
    const written = taskPut.mock.calls
      .flatMap((c) => (c[0] as Task[]).map((t) => t.id))
      .sort();
    expect(written).toEqual(["local-smaller", "remote-smaller", "same"]);
  });

  it("R2: a remote version of the same log id replaces ours only when it ended earlier", async () => {
    await db.timeLogs.bulkPut([
      log("log-1-a", "a", { endTime: 721_000, durationSeconds: 720 }),
      log("log-1-b", "b", { endTime: 601_000, durationSeconds: 600 }),
      log("log-1-c", "c", { endTime: 61_000, taskTitleSnapshot: "Zed" }),
    ]);
    const logPut = vi.spyOn(db.timeLogs, "bulkPut");

    await applyMergedPayloadToLocalDB(
      payload({
        timeLogs: [
          log("log-1-a", "a", { endTime: 601_000, durationSeconds: 600 }), // earlier end: wins
          log("log-1-b", "b", { endTime: 721_000, durationSeconds: 720 }), // later end: ignored
          log("log-1-c", "c", { endTime: 61_000, taskTitleSnapshot: "Abe" }), // tie: smaller wins
        ],
      })
    );

    expect((await db.timeLogs.get("log-1-a"))?.durationSeconds).toBe(600);
    expect((await db.timeLogs.get("log-1-b"))?.durationSeconds).toBe(600);
    expect((await db.timeLogs.get("log-1-c"))?.taskTitleSnapshot).toBe("Abe");
    const written = logPut.mock.calls
      .flatMap((c) => (c[0] as TimeLog[]).map((l) => l.id))
      .sort();
    expect(written).toEqual(["log-1-a", "log-1-c"]);
  });

  it("keeps a tombstone recorded after the snapshot (union, never replace) and does not resurrect the row", async () => {
    await db.tasks.bulkPut([task("keep"), task("deleted-after-snapshot")]);
    recordDeletedTaskTombstone("older-deletion");

    // Snapshot is taken (contains the row), then the user deletes it.
    const snapshot = await buildLocalSyncPayload(NO_FOCUS);
    recordDeletedTaskTombstone("deleted-after-snapshot");
    await db.tasks.delete("deleted-after-snapshot");

    // Server response for that snapshot: still has the row, lacks the new tombstone.
    const response = mergeSyncPayloads(
      payload({ deletedTaskIds: ["server-side-deletion"] }),
      snapshot
    );
    expect(response.tasks.map((t) => t.id)).toContain("deleted-after-snapshot");

    await applyMergedPayloadToLocalDB(response);

    expect(await db.tasks.get("deleted-after-snapshot")).toBeUndefined();
    expect(await db.tasks.get("keep")).toBeDefined();
    expect(getTombstones().deletedTaskIds).toEqual(
      expect.arrayContaining(["older-deletion", "deleted-after-snapshot", "server-side-deletion"])
    );

    // And the next upload still carries the deletion.
    const next = await buildLocalSyncPayload(NO_FOCUS);
    expect(next.deletedTaskIds).toContain("deleted-after-snapshot");
    expect(next.tasks.map((t) => t.id)).toEqual(["keep"]);
  });

  it("performs zero writes (and returns false) when the merged payload equals local state", async () => {
    await db.quests.put(quest("q1"));
    await db.tasks.bulkPut([
      task("t1", { questId: "q1", accumulatedSeconds: 60 }),
      task("t2", { rank: 2000, completedAt: undefined }),
    ]);
    await db.timeLogs.put(log("l1", "t1", { questId: "q1" }));
    // Tombstones for rows that no longer exist locally.
    recordDeletedTaskTombstone("long-gone");

    const local = await buildLocalSyncPayload(NO_FOCUS);
    // What the server sends back: same content, different key order, its own stamp.
    const reorder = <T extends object>(row: T): T =>
      Object.fromEntries(Object.entries(row).reverse()) as T;
    const merged: SyncPayload = {
      ...local,
      quests: local.quests.map(reorder),
      tasks: local.tasks.map(reorder),
      timeLogs: local.timeLogs.map(reorder),
      deletedQuestIds: [],
      deletedLogIds: [],
      lastSyncedAt: Date.now() + 5000,
    };

    const spies = [
      vi.spyOn(db.quests, "bulkPut"),
      vi.spyOn(db.tasks, "bulkPut"),
      vi.spyOn(db.timeLogs, "bulkPut"),
      vi.spyOn(db.quests, "bulkDelete"),
      vi.spyOn(db.tasks, "bulkDelete"),
      vi.spyOn(db.timeLogs, "bulkDelete"),
    ];
    const tombstonesBefore = window.localStorage.getItem("hunt-sync-tombstones-v1");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const changed = await applyMergedPayloadToLocalDB(merged);

    expect(changed).toBe(false);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("hunt-sync-tombstones-v1")).toBe(tombstonesBefore);
  });

  it("deletes only tombstoned rows that exist locally", async () => {
    await db.tasks.bulkPut([task("doomed"), task("survivor")]);
    await db.timeLogs.put(log("log-doomed", "doomed"));
    await db.quests.put(quest("quest-doomed"));
    const taskDelete = vi.spyOn(db.tasks, "bulkDelete");
    const questDelete = vi.spyOn(db.quests, "bulkDelete");
    const logDelete = vi.spyOn(db.timeLogs, "bulkDelete");

    const changed = await applyMergedPayloadToLocalDB(
      payload({
        tasks: [task("survivor")],
        deletedTaskIds: ["doomed", "ghost-task"],
        deletedQuestIds: ["quest-doomed", "ghost-quest"],
        deletedLogIds: ["log-doomed", "ghost-log"],
      })
    );

    expect(changed).toBe(true);
    expect(taskDelete).toHaveBeenCalledTimes(1);
    expect(taskDelete.mock.calls[0][0]).toEqual(["doomed"]);
    expect(questDelete.mock.calls[0][0]).toEqual(["quest-doomed"]);
    expect(logDelete.mock.calls[0][0]).toEqual(["log-doomed"]);
    expect(await db.tasks.get("doomed")).toBeUndefined();
    expect(await db.tasks.get("survivor")).toBeDefined();
  });

  it("nulls the questId of a locally-newer task whose quest was deleted elsewhere", async () => {
    await db.quests.put(quest("q-del"));
    await db.tasks.put(task("t1", { questId: "q-del", title: "local edit", updatedAt: 9000 }));

    await applyMergedPayloadToLocalDB(
      payload({
        tasks: [task("t1", { questId: "q-del", title: "stale", updatedAt: 1000 })],
        deletedQuestIds: ["q-del"],
      })
    );

    const t1 = await db.tasks.get("t1");
    expect(t1?.title).toBe("local edit");
    expect(t1?.questId).toBeNull();
    expect(await db.quests.get("q-del")).toBeUndefined();
  });
});

describe("syncTypes: merge and validation details", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the NEWEST 5000 tombstones", () => {
    const ids = Array.from({ length: 5005 }, (_, i) => `t${i}`);
    const check = validateSyncPayload({ ...createEmptySyncPayload(), deletedTaskIds: ids });
    expect(check.valid).toBe(true);
    expect(check.payload?.deletedTaskIds).toHaveLength(5000);
    expect(check.payload?.deletedTaskIds[0]).toBe("t5");
    expect(check.payload?.deletedTaskIds[4999]).toBe("t5004");
  });

  it("raises (never lowers) accumulatedSeconds to the total of the task's logs", () => {
    // Both devices worked on the same task while disconnected.
    const phone = payload({
      tasks: [task("shared", { accumulatedSeconds: 1800, updatedAt: 3000 })],
      timeLogs: [log("log-phone", "shared", { durationSeconds: 1800 })],
    });
    const laptop = payload({
      tasks: [task("shared", { accumulatedSeconds: 1200, updatedAt: 4000 })],
      timeLogs: [log("log-laptop", "shared", { durationSeconds: 1200, startTime: 5000 })],
    });
    const merged = mergeSyncPayloads(phone, laptop);
    expect(merged.tasks[0].accumulatedSeconds).toBe(3000);

    // Never lowered when the counter already exceeds the logged total.
    const high = mergeSyncPayloads(
      payload({ tasks: [task("x", { accumulatedSeconds: 9999 })] }),
      payload({ timeLogs: [log("lx", "x", { durationSeconds: 60 })] })
    );
    expect(high.tasks[0].accumulatedSeconds).toBe(9999);
  });

  it("resets the focus of a completed task with a deterministic timestamp (not the server clock)", () => {
    vi.spyOn(Date, "now").mockReturnValue(9_999_999_999);
    const merged = mergeSyncPayloads(
      payload({
        activeFocus: { activeTaskId: "done", isRunning: true, sessionStartedAt: 2000, updatedAt: 2000 },
      }),
      payload({
        tasks: [task("done", { status: "completed", completedAt: 4000, updatedAt: 4000 })],
      })
    );
    expect(merged.activeFocus).toEqual({
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 4001,
    });
  });

  it("syncContentKey ignores lastSyncedAt and key order but not content", () => {
    const a = payload({ tasks: [task("t1")], lastSyncedAt: 1 });
    const b: SyncPayload = {
      ...a,
      tasks: [Object.fromEntries(Object.entries(task("t1")).reverse()) as unknown as Task],
      lastSyncedAt: 2,
    };
    expect(syncContentKey(a)).toBe(syncContentKey(b));
    expect(syncContentKey(a)).not.toBe(
      syncContentKey({ ...a, tasks: [task("t1", { title: "changed" })] })
    );
  });

  it("canonicalString sorts keys at every level and drops undefined fields", () => {
    expect(canonicalString({ b: 1, a: { d: undefined, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}]},"b":1}'
    );
    expect(canonicalString(task("t1"))).toBe(
      canonicalString(Object.fromEntries(Object.entries(task("t1")).reverse()))
    );
  });

  it("R5 compareRank: rank first, ties by id, a non-numeric rank counts as 0", () => {
    const rows = [
      task("b", { rank: 5000 }),
      task("a", { rank: 5000 }),
      task("c", { rank: 1000 }),
      { ...task("n"), rank: undefined as unknown as number },
    ];
    expect(rows.slice().sort(compareRank).map((t) => t.id)).toEqual(["n", "c", "a", "b"]);
    expect(rows.slice().reverse().sort(compareRank).map((t) => t.id)).toEqual([
      "n",
      "c",
      "a",
      "b",
    ]);
  });

  it("R5: the server merge orders equal-rank tasks by id whatever the input order", () => {
    const one = mergeSyncPayloads(
      payload({ tasks: [task("laptop-new", { rank: 5000 })] }),
      payload({ tasks: [task("phone-new", { rank: 5000 }), task("first", { rank: 1000 })] })
    );
    const two = mergeSyncPayloads(
      payload({ tasks: [task("phone-new", { rank: 5000 }), task("first", { rank: 1000 })] }),
      payload({ tasks: [task("laptop-new", { rank: 5000 })] })
    );
    expect(one.tasks.map((t) => t.id)).toEqual(["first", "laptop-new", "phone-new"]);
    expect(two.tasks.map((t) => t.id)).toEqual(["first", "laptop-new", "phone-new"]);
  });

  it("R1: the server merge resolves equal-stamp conflicts the same way in both directions", () => {
    const phone = payload({
      tasks: [task("t", { questId: null, updatedAt: 3000, accumulatedSeconds: 50 })],
      quests: [quest("q", { title: "Phone", updatedAt: 3000 })],
    });
    const laptop = payload({
      tasks: [task("t", { questId: "q", updatedAt: 3000, accumulatedSeconds: 70 })],
      quests: [quest("q", { title: "Laptop", updatedAt: 3000 })],
    });
    const a = mergeSyncPayloads(phone, laptop);
    const b = mergeSyncPayloads(laptop, phone);
    // In JSON, `"questId":"q"` sorts before `"questId":null`; "Laptop" < "Phone".
    expect(a.tasks[0].questId).toBe("q");
    expect(b.tasks[0].questId).toBe("q");
    expect(a.tasks[0].accumulatedSeconds).toBe(70);
    expect(b.tasks[0].accumulatedSeconds).toBe(70);
    expect(a.quests[0].title).toBe("Laptop");
    expect(b.quests[0].title).toBe("Laptop");
    // A fixed point: merging the result with either side again changes nothing.
    expect(syncContentKey(mergeSyncPayloads(a, phone))).toBe(syncContentKey(a));
    expect(syncContentKey(mergeSyncPayloads(a, laptop))).toBe(syncContentKey(a));
    // A newer stamp still wins regardless of content.
    const newer = mergeSyncPayloads(
      laptop,
      payload({ tasks: [task("t", { title: "Z", updatedAt: 3001 })] })
    );
    expect(newer.tasks[0].title).toBe("Z");
  });

  it("R1: quest sanitising happens before the tie-break (a tombstoned quest id is not content)", () => {
    const base = payload({ tasks: [task("t", { questId: "gone", updatedAt: 3000 })] });
    const inc = payload({
      tasks: [task("t", { questId: null, updatedAt: 3000 })],
      deletedQuestIds: ["gone"],
    });
    expect(mergeSyncPayloads(base, inc).tasks[0].questId).toBeNull();
    expect(mergeSyncPayloads(inc, base).tasks[0].questId).toBeNull();
  });

  it("R2: the server keeps the earlier-ended version of a log id, in both directions", () => {
    const phone = payload({
      timeLogs: [log("log-5-t", "t", { startTime: 5, endTime: 601_005, durationSeconds: 601 })],
    });
    const laptop = payload({
      timeLogs: [log("log-5-t", "t", { startTime: 5, endTime: 721_005, durationSeconds: 721 })],
    });
    expect(mergeSyncPayloads(phone, laptop).timeLogs[0].durationSeconds).toBe(601);
    expect(mergeSyncPayloads(laptop, phone).timeLogs[0].durationSeconds).toBe(601);

    const missingEnd = { ...log("x", "t"), endTime: undefined as unknown as number };
    expect(pickLogWinner(missingEnd, log("x", "t"))).toEqual(log("x", "t"));
    expect(pickLogWinner(log("x", "t"), missingEnd)).toEqual(log("x", "t"));
    const same = log("x", "t");
    expect(pickLogWinner(same, { ...same })).toBe(same);
  });

  it("pickRowWinner keeps the existing object for identical content (accumulatedSeconds ignored)", () => {
    const a = task("t", { accumulatedSeconds: 1 });
    expect(pickRowWinner(a, 1000, task("t", { accumulatedSeconds: 2 }), 1000)).toBe(a);
  });

  it("R4 losingSessionEndAt: ends at a later different session or log start, never via updatedAt", () => {
    const S = 1_000_000;
    const now = S + 7_200_000;
    const running = (activeTaskId: string, sessionStartedAt: number) => ({
      activeTaskId,
      isRunning: true,
      sessionStartedAt,
      updatedAt: sessionStartedAt,
    });
    // The winner started a different session 20 min later.
    expect(losingSessionEndAt("x", S, running("y", S + 1_200_000), [], now)).toBe(
      S + 1_200_000
    );
    // A later log of another session (started 10 min in) bounds it even earlier.
    expect(
      losingSessionEndAt(
        "x",
        S,
        running("y", S + 1_200_000),
        [log("l", "z", { startTime: S + 600_000 })],
        now
      )
    ).toBe(S + 600_000);
    // The session's own log and older logs are no bound.
    expect(
      losingSessionEndAt(
        "x",
        S,
        null,
        [log("own", "x", { startTime: S }), log("old", "z", { startTime: S - 5 })],
        now
      )
    ).toBe(now);
    // A pause/clear (not running) only carries updatedAt, which is not used.
    expect(
      losingSessionEndAt(
        "x",
        S,
        { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: S + 60_000 },
        [],
        now
      )
    ).toBe(now);
    // The same session, or an older one, is no bound.
    expect(losingSessionEndAt("x", S, running("x", S), [], now)).toBe(now);
    expect(losingSessionEndAt("x", S, running("y", S - 60_000), [], now)).toBe(now);
    // Never shorter than 1 s.
    expect(losingSessionEndAt("x", S, running("y", S + 10), [], now)).toBe(S + 1000);
  });

  it("an idle merge reproduces the stored content exactly (so the server can skip the write)", () => {
    const stored = mergeSyncPayloads(
      createEmptySyncPayload(),
      payload({
        quests: [quest("q1")],
        tasks: [task("b", { rank: 2000 }), task("a", { rank: 1000, questId: "q1" })],
        timeLogs: [log("l1", "a", { durationSeconds: 30 })],
        deletedTaskIds: ["gone"],
      })
    );
    const again = mergeSyncPayloads(stored, payload({ ...stored, lastSyncedAt: 123 }));
    expect(syncContentKey(again)).toBe(syncContentKey(stored));
  });
});
