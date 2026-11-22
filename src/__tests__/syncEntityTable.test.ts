// The merge is driven by one table of synced collections (SYNCED_ENTITY_KEYS / TOMBSTONE_KEY).
// These checks tie that table to the payload shape, so a new collection cannot be half-wired.
import { describe, expect, it } from "vitest";
import {
  SYNCED_ENTITY_KEYS,
  TOMBSTONE_KEY,
  createEmptySyncPayload,
  mergeSyncPayloads,
  type SyncPayload,
} from "@/lib/syncTypes";

describe("synced collection table", () => {
  it("lists every row array and every tombstone list of the payload, once", () => {
    const empty = createEmptySyncPayload();
    const rowArrays = Object.keys(empty).filter(
      (k) => Array.isArray(empty[k as keyof SyncPayload]) && !k.startsWith("deleted")
    );
    const tombstoneLists = Object.keys(empty).filter((k) => k.startsWith("deleted"));
    expect([...SYNCED_ENTITY_KEYS].sort()).toEqual(rowArrays.sort());
    expect(Object.values(TOMBSTONE_KEY).sort()).toEqual(tombstoneLists.sort());
  });

  it("a tombstone in either side removes the row from every collection", () => {
    const base = createEmptySyncPayload();
    const row = { id: "x-1", title: "row", createdAt: 1, updatedAt: 1 };
    base.quests = [{ ...row, slotIndex: 0 } as unknown as SyncPayload["quests"][number]];
    base.tasks = [{ ...row, status: "queued", rank: 0, questId: null } as unknown as SyncPayload["tasks"][number]];
    base.habits = [{ ...row, rank: 0, questId: null } as unknown as NonNullable<SyncPayload["habits"]>[number]];
    base.timeLogs = [{ id: "x-1", taskId: "t", startTime: 1, durationSeconds: 1 } as unknown as SyncPayload["timeLogs"][number]];
    const incoming = createEmptySyncPayload();
    for (const key of SYNCED_ENTITY_KEYS) (incoming[TOMBSTONE_KEY[key]] as string[]) = ["x-1"];

    const merged = mergeSyncPayloads(base, incoming);
    for (const key of SYNCED_ENTITY_KEYS) {
      expect(merged[key], key).toEqual([]);
      expect(merged[TOMBSTONE_KEY[key]], key).toEqual(["x-1"]);
    }
  });
});
