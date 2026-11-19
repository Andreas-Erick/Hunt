import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  createEmptySyncPayload,
  mergeSyncPayloads,
  validateSyncPayload,
  canonicalString,
  sameContent,
  pickRowWinner,
  pickLogWinner,
  type SyncPayload,
} from "@/lib/syncTypes";
import type { TimeLog } from "@/lib/db";
import {
  buildLocalSyncPayload,
  importAndMergeSnapshotJson,
  recordDeletedTaskTombstone,
} from "@/lib/syncEngine";

describe("Cross-Device Sync & CRDT Merge Engine (syncTypes.ts & syncEngine.ts)", () => {
  beforeEach(async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear();
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
  });

  it("merges disjoint tasks and timeLogs from PC and Phone without loss", () => {
    const pcPayload: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "pc-task-1",
          title: "PC Architecture Task",
          notes: "",
          questId: "quest-slot-0",
          status: "queued",
          rank: 1000,
          accumulatedSeconds: 600,
          createdAt: 1000,
          updatedAt: 1500,
        },
      ],
      timeLogs: [
        {
          id: "log-pc-1",
          taskId: "pc-task-1",
          taskTitleSnapshot: "PC Architecture Task",
          questId: "quest-slot-0",
          questCodeSnapshot: "Launch my idea",
          accentColorSnapshot: "cyan",
          startTime: 1000,
          endTime: 1600,
          durationSeconds: 600,
          dateKey: "2026-11-18",
        },
      ],
    };

    const phonePayload: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "phone-task-1",
          title: "Phone 5km Run",
          notes: "Completed outdoors",
          questId: "quest-slot-2",
          status: "completed",
          rank: 2000,
          accumulatedSeconds: 1800,
          createdAt: 2000,
          updatedAt: 3800,
          completedAt: 3800,
        },
      ],
      timeLogs: [
        {
          id: "log-phone-1",
          taskId: "phone-task-1",
          taskTitleSnapshot: "Phone 5km Run",
          questId: "quest-slot-2",
          questCodeSnapshot: "Run a half marathon",
          accentColorSnapshot: "emerald",
          startTime: 2000,
          endTime: 3800,
          durationSeconds: 1800,
          dateKey: "2026-11-18",
        },
      ],
    };

    const merged = mergeSyncPayloads(pcPayload, phonePayload);
    expect(merged.tasks).toHaveLength(2);
    expect(merged.timeLogs).toHaveLength(2);
    expect(merged.tasks.map((t) => t.id)).toEqual([
      "pc-task-1",
      "phone-task-1",
    ]);
  });

  it("resolves conflicting edits to the same task using latest updatedAt and preserves max accumulatedSeconds", () => {
    const olderState: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "shared-task",
          title: "Old Title",
          notes: "Old notes",
          questId: "quest-slot-0",
          status: "queued",
          rank: 1000,
          accumulatedSeconds: 1200,
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    };

    const newerState: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "shared-task",
          title: "Updated Title on Phone",
          notes: "Updated notes on Phone",
          questId: "quest-slot-0",
          status: "completed",
          rank: 1000,
          accumulatedSeconds: 900, // Even if lower, max(1200, 900) = 1200 is preserved
          createdAt: 1000,
          updatedAt: 5000,
          completedAt: 5000,
        },
      ],
    };

    const merged = mergeSyncPayloads(olderState, newerState);
    expect(merged.tasks).toHaveLength(1);
    expect(merged.tasks[0].title).toBe("Updated Title on Phone");
    expect(merged.tasks[0].status).toBe("completed");
    expect(merged.tasks[0].accumulatedSeconds).toBe(1200);
  });

  it("honors deletedTaskIds tombstones so deleted tasks do not resurrect on sync", () => {
    const serverState: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "tsk-to-delete",
          title: "Delete me",
          notes: "",
          questId: null,
          status: "queued",
          rank: 1000,
          accumulatedSeconds: 0,
          createdAt: 1000,
        },
      ],
    };

    const clientState: SyncPayload = {
      ...createEmptySyncPayload(),
      deletedTaskIds: ["tsk-to-delete"],
    };

    const merged = mergeSyncPayloads(serverState, clientState);
    expect(merged.tasks).toHaveLength(0);
    expect(merged.deletedTaskIds).toContain("tsk-to-delete");
  });

  it("synchronizes activeFocus state across devices and clears it if the task was completed", () => {
    const pcRunning: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "tsk-focus",
          title: "Deep Focus Task",
          notes: "",
          questId: "quest-slot-0",
          status: "active",
          rank: 1000,
          accumulatedSeconds: 0,
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
      activeFocus: {
        activeTaskId: "tsk-focus",
        isRunning: true,
        sessionStartedAt: 2000,
        updatedAt: 2000,
      },
    };

    const phoneIdle = createEmptySyncPayload();
    const mergedRunning = mergeSyncPayloads(phoneIdle, pcRunning);
    expect(mergedRunning.activeFocus.activeTaskId).toBe("tsk-focus");
    expect(mergedRunning.activeFocus.isRunning).toBe(true);

    // Now phone completes the task at timestamp 4000
    const phoneCompleted: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "tsk-focus",
          title: "Deep Focus Task",
          notes: "",
          questId: "quest-slot-0",
          status: "completed",
          rank: 1000,
          accumulatedSeconds: 1800,
          createdAt: 1000,
          updatedAt: 4000,
          completedAt: 4000,
        },
      ],
    };

    const mergedDone = mergeSyncPayloads(mergedRunning, phoneCompleted);
    expect(mergedDone.activeFocus.activeTaskId).toBeNull();
    expect(mergedDone.activeFocus.isRunning).toBe(false);
  });

  it("imports and merges a JSON snapshot into local IndexedDB", async () => {
    await db.tasks.add({
      id: "local-1",
      title: "Local PC Task",
      notes: "",
      questId: null,
      status: "queued",
      rank: 1000,
      accumulatedSeconds: 0,
      createdAt: 1000,
    });

    recordDeletedTaskTombstone("deleted-1");

    const remoteSnapshot: SyncPayload = {
      ...createEmptySyncPayload(),
      tasks: [
        {
          id: "remote-1",
          title: "Imported Phone Task",
          notes: "",
          questId: null,
          status: "queued",
          rank: 2000,
          accumulatedSeconds: 300,
          createdAt: 2000,
        },
        {
          id: "deleted-1",
          title: "Should Stay Deleted",
          notes: "",
          questId: null,
          status: "queued",
          rank: 3000,
          accumulatedSeconds: 0,
          createdAt: 500,
        },
      ],
    };

    await importAndMergeSnapshotJson(JSON.stringify(remoteSnapshot), {
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    });

    const finalLocal = await buildLocalSyncPayload({
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    });

    expect(finalLocal.tasks.map((t) => t.id)).toEqual(["local-1", "remote-1"]);
  });

  it("propagates deletedQuestIds tombstones and unassigns tasks from deleted quests", () => {
    const serverState: SyncPayload = {
      ...createEmptySyncPayload(),
      quests: [
        {
          id: "quest-to-delete",
          slotIndex: 0,
          code: "DEL",
          title: "Old Quest",
          description: "",
          accentColor: "cyan",
          targetWeeklyHours: 10,
          archived: false,
          createdAt: 1000,
        },
      ],
      tasks: [
        {
          id: "task-linked",
          title: "Linked Task",
          notes: "",
          questId: "quest-to-delete",
          status: "queued",
          rank: 1000,
          accumulatedSeconds: 0,
          createdAt: 1000,
        },
      ],
    };

    const clientState: SyncPayload = {
      ...createEmptySyncPayload(),
      deletedQuestIds: ["quest-to-delete"],
    };

    const merged = mergeSyncPayloads(serverState, clientState);
    expect(merged.quests).toHaveLength(0);
    expect(merged.deletedQuestIds).toContain("quest-to-delete");
    expect(merged.tasks[0].questId).toBeNull();
  });

  it("validates sync payload schema and rejects malformed payloads", () => {
    expect(validateSyncPayload(null).valid).toBe(false);
    expect(validateSyncPayload("not-an-object").valid).toBe(false);
    expect(validateSyncPayload({ quests: "bad" }).valid).toBe(false);

    const validCheck = validateSyncPayload(createEmptySyncPayload());
    expect(validCheck.valid).toBe(true);
  });
});

describe("sameContent fast path (must agree with canonicalString)", () => {
  it("is true only for rows with equal canonical content", () => {
    const rnd = (seed: number) => () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const r = rnd(42);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const values = [undefined, null, 0, 1, "a", "b", "", true, false, [1, 2], { x: 1 }, { x: 2 }];
    const keys = ["id", "title", "rank", "notes", "questId", "meta"];
    const makeRow = () => {
      const row: Record<string, unknown> = {};
      for (const k of keys) if (r() < 0.7) row[k] = pick(values);
      return row;
    };
    for (let i = 0; i < 5000; i++) {
      const a = makeRow();
      const b = r() < 0.4 ? { ...a } : makeRow();
      if (r() < 0.2) b[pick(keys)] = pick(values);
      const canonEqual = canonicalString(a) === canonicalString(b);
      // fast path may say "not sure" (false) but must never claim equality that canonical denies
      if (sameContent(a, b)) expect(canonEqual).toBe(true);
      // plain copies are always recognised
      expect(sameContent(a, { ...a })).toBe(true);
    }
  });

  it("ignores the skipped key and undefined fields", () => {
    expect(sameContent({ id: "t", accumulatedSeconds: 5 }, { id: "t", accumulatedSeconds: 9 }, "accumulatedSeconds")).toBe(true);
    expect(sameContent({ id: "t", notes: undefined }, { id: "t" })).toBe(true);
    expect(sameContent({ id: "t", notes: "" }, { id: "t" })).toBe(false);
  });

  it("keeps the R1/R2 results unchanged for identical rows", () => {
    const task = { id: "t1", title: "A", rank: 1000, updatedAt: 5, accumulatedSeconds: 3 };
    const copy = { ...task, accumulatedSeconds: 7 };
    expect(pickRowWinner(task, 5, copy, 5)).toBe(task);
    const log = { id: "l1", taskId: "t1", startTime: 1, endTime: 2, durationSeconds: 1 } as unknown as TimeLog;
    expect(pickLogWinner(log, { ...log })).toBe(log);
  });
});
