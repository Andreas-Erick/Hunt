import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import type { Quest } from "@/lib/domainTypes";
import { buildLocalSyncPayload } from "@/lib/syncEngine";
import {
  createEmptySyncPayload,
  MAX_LONG_TEXT_LENGTH,
  validateSyncPayload,
  type ActiveFocusState,
} from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";

/**
 * The sync validator cuts long text and caps row counts. A device must never
 * write what the validator would change or refuse: an equal-stamp tie-break
 * would otherwise overwrite the writer's own copy, and an over-count payload
 * rejects every sync from that device.
 */

const NO_FOCUS: ActiveFocusState = { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 };
const store = () => useCommandStore.getState();
const LONG = "n".repeat(MAX_LONG_TEXT_LENGTH + 5000);

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear()]);
  window.localStorage.clear();
  useCommandStore.setState(useCommandStore.getInitialState(), true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The server would store exactly what this device holds. */
async function expectValidatorChangesNothing(): Promise<void> {
  const payload = await buildLocalSyncPayload(NO_FOCUS);
  const check = validateSyncPayload(payload);
  expect(check.valid).toBe(true);
  expect(check.payload?.tasks.map((t) => t.notes)).toEqual(payload.tasks.map((t) => t.notes));
  expect(check.payload?.quests.map((q) => q.description)).toEqual(payload.quests.map((q) => q.description));
  expect(check.payload?.habits?.map((h) => h.notes)).toEqual(payload.habits?.map((h) => h.notes));
}

describe("long text is cut where it is written, to the sync limit", () => {
  it("createTask and updateTask store at most MAX_LONG_TEXT_LENGTH of notes", async () => {
    await store().createTask({ title: "a", notes: LONG, questId: null });
    const [created] = await db.tasks.toArray();
    expect(created.notes).toHaveLength(MAX_LONG_TEXT_LENGTH);

    await store().updateTask(created.id, { notes: LONG });
    expect((await db.tasks.get(created.id))?.notes).toHaveLength(MAX_LONG_TEXT_LENGTH);
    await expectValidatorChangesNothing();
  });

  it("updateTask keeps the trailing newline a user is still typing after", async () => {
    await store().createTask({ title: "a", questId: null });
    const [created] = await db.tasks.toArray();
    await store().updateTask(created.id, { notes: "line one\n" });
    expect((await db.tasks.get(created.id))?.notes).toBe("line one\n");
  });

  it("createQuest and updateQuest store at most MAX_LONG_TEXT_LENGTH of description", async () => {
    await store().createQuest({ title: "q", description: LONG });
    const [created] = await db.quests.toArray();
    expect(created.description).toHaveLength(MAX_LONG_TEXT_LENGTH);

    await store().updateQuest(created.id, { description: LONG });
    expect((await db.quests.get(created.id))?.description).toHaveLength(MAX_LONG_TEXT_LENGTH);
    await expectValidatorChangesNothing();
  });

  it("createHabit and updateHabit store at most MAX_LONG_TEXT_LENGTH of notes", async () => {
    await store().createHabit({ title: "h", notes: LONG, questId: null });
    const [created] = await db.habits.toArray();
    expect(created.notes).toHaveLength(MAX_LONG_TEXT_LENGTH);

    await store().updateHabit(created.id, { notes: LONG });
    expect((await db.habits.get(created.id))?.notes).toHaveLength(MAX_LONG_TEXT_LENGTH);
    await expectValidatorChangesNothing();
  });

  it("a cut never leaves half of a surrogate pair", async () => {
    const straddling = "a".repeat(MAX_LONG_TEXT_LENGTH - 1) + "😀";
    await store().createTask({ title: "a", notes: straddling, questId: null });
    const [created] = await db.tasks.toArray();
    expect(created.notes).toBe("a".repeat(MAX_LONG_TEXT_LENGTH - 1));
  });
});

describe("row counts that years of history reach still sync", () => {
  function quest(i: number): Quest {
    return {
      id: `quest-${i}`,
      slotIndex: 0,
      code: "Q",
      title: `Quest ${i}`,
      description: "",
      accentColor: "cyan",
      targetWeeklyHours: 10,
      archived: true,
      createdAt: 1000 + i,
      updatedAt: 1000 + i,
    };
  }

  it("accepts 500 quests (about ten years of weekly quests kept as history)", () => {
    const payload = { ...createEmptySyncPayload(), quests: Array.from({ length: 500 }, (_, i) => quest(i)) };
    const check = validateSyncPayload(payload);
    expect(check.error).toBeUndefined();
    expect(check.payload?.quests).toHaveLength(500);
  });
});
