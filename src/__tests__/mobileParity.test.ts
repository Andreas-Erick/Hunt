// @vitest-environment node
// The phone's merge (w.mergePayloads in hunt-mobile.html) is the shared mergeSyncPayloads from the
// HuntCore block plus phone-only steps and the phone's boundary guard. This suite checks that the
// wrapper adds nothing beyond those steps: on generated inputs both must give the same result.
//
// Phone-only steps are kept out of the generated inputs on purpose: flushing this phone's own losing
// running session (R4, needs a RUNNING base focus) and re-queueing stranded 'active' tasks (needs
// status 'active'). The server deliberately never does either (see the NOTE in mergeSyncPayloads).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_ENTITY_ID_LENGTH,
  MAX_LOG_ID_LENGTH,
  SAFE_ID_CHARS_RE,
  isSafeSyncId,
  mergeSyncPayloads,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";
import { loadMobile, seededRandom, type MobileWindow } from "./helpers/loadMobile";

let w: MobileWindow;
beforeAll(() => {
  w = loadMobile();
});
afterAll(() => {
  w.close();
});

/** Deterministic PRNG helpers (32-bit LCG); the seed is printed in every assertion message. */
function lcg(seed: number) {
  const next = seededRandom(seed);
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof lcg>;

const QUEST_IDS = ["quest-1", "quest-2", "quest-3"] as const;
const TASK_IDS = ["tsk-1", "tsk-2", "tsk-3", "tsk-4", "tsk-5"] as const;
const STARTS = [1000, 2000, 3000, 4000] as const;
const TITLES = ["Alpha", "Beta", "alpha", "", "Ünïcödé", "👨‍👩‍👧‍👦", "مرحبا"] as const;

type Row = Record<string, unknown>;

/** Equal, zero, missing and null stamps collide often: a small value pool. */
function stamp(r: Rng): number | null | undefined {
  return r.pick([undefined, 0, 10, 10, 50, 100, null]);
}

function withStamps(r: Rng, row: Row, keys: string[]): Row {
  for (const k of keys) {
    const v = stamp(r);
    if (v !== undefined) row[k] = v;
  }
  return row;
}

function genQuest(r: Rng): Row {
  return withStamps(
    r,
    {
      id: r.pick(QUEST_IDS),
      slotIndex: r.int(0, 2),
      title: r.pick(TITLES),
      accentColor: r.pick([
        "cyan",
        "amber",
        "emerald",
        "purple",
        "rose",
        "sky",
        "orange",
        "lime",
      ]),
      targetWeeklyHours: r.int(0, 20),
      archived: r.chance(0.2),
    },
    ["updatedAt", "createdAt"]
  );
}

function genTask(r: Rng): Row {
  const task: Row = {
    id: r.pick(TASK_IDS),
    title: r.pick(TITLES),
    status: r.pick(["queued", "completed"]),
    questId: r.chance(0.3) ? null : r.pick(QUEST_IDS),
    rank: r.int(-2, 2) * 1000,
    accumulatedSeconds: r.int(0, 3) * 60,
  };
  if (r.chance(0.5)) task.notes = r.pick(TITLES);
  if (r.chance(0.4)) task.scheduledDate = r.pick(["2026-11-18", "2026-11-19"]);
  return withStamps(r, task, ["updatedAt", "completedAt", "createdAt"]);
}

function genLog(r: Rng): Row {
  const taskId = r.pick(TASK_IDS);
  const startTime = r.pick(STARTS);
  const log: Row = {
    id: `log-${startTime}-${taskId}`,
    taskId,
    taskTitleSnapshot: r.pick(TITLES),
    questId: r.chance(0.3) ? null : r.pick(QUEST_IDS),
    startTime,
    durationSeconds: r.int(1, 4) * 30,
    dateKey: "2026-11-18",
  };
  if (r.chance(0.8)) log.endTime = startTime + r.pick([30000, 60000, 60000]);
  return log;
}

function genFocus(r: Rng, allowRunning: boolean) {
  const activeTaskId = r.chance(0.3) ? null : r.pick(TASK_IDS);
  const isRunning = allowRunning && activeTaskId !== null && r.chance(0.5);
  return {
    activeTaskId,
    isRunning,
    sessionStartedAt: isRunning ? r.pick(STARTS) : null,
    updatedAt: r.pick([0, 10, 50, 100, 300]),
  };
}

function some<T>(r: Rng, items: readonly T[]): T[] {
  return items.filter(() => r.chance(0.25));
}

/**
 * Test vectors deliberately carry what the TS row types forbid (missing / null stamps, bare rows):
 * the one place they are handed to both merges as SyncPayload.
 */
function loose(value: object): SyncPayload {
  return value as SyncPayload;
}

function genPayload(r: Rng, isBase: boolean): SyncPayload {
  const list = <T,>(gen: (rr: Rng) => T, max: number) => Array.from({ length: r.int(0, max) }, () => gen(r));
  return loose({
    quests: list(genQuest, 4),
    tasks: list(genTask, 7),
    timeLogs: list(genLog, 5),
    deletedQuestIds: some(r, QUEST_IDS),
    deletedTaskIds: some(r, TASK_IDS),
    deletedLogIds: some(r, STARTS.map((s) => `log-${s}-${TASK_IDS[0]}`)),
    // base = this phone: never a running session (that would take the phone-only R4 flush path)
    activeFocus: genFocus(r, !isBase),
    lastSyncedAt: 0,
  });
}

interface Comparable {
  quests: unknown;
  tasks: unknown;
  timeLogs: unknown;
  deletedQuestIds: string[];
  deletedTaskIds: string[];
  deletedLogIds: string[];
  activeFocus: unknown;
}

/** Realm-free plain copy of the fields both merges must agree on (tombstones as sorted sets). */
function comparable(merged: unknown): Comparable {
  const m = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? Array.from(new Set(v.map(String))).sort() : []);
  return {
    quests: m.quests,
    tasks: m.tasks,
    timeLogs: m.timeLogs,
    deletedQuestIds: ids(m.deletedQuestIds),
    deletedTaskIds: ids(m.deletedTaskIds),
    deletedLogIds: ids(m.deletedLogIds),
    activeFocus: m.activeFocus,
  };
}

/** Each side gets its own deep copy, so neither merge can see the other's mutations. */
function both(a: SyncPayload, b: SyncPayload) {
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    phone: comparable(w.mergePayloads(copy(a), copy(b))),
    server: comparable(mergeSyncPayloads(copy(a), copy(b))),
  };
}

describe("phone merge parity with syncTypes.mergeSyncPayloads", () => {
  it("matches on 400 seeded random input pairs (colliding ids, equal/zero/missing stamps, completed focus tasks)", () => {
    const seed = 20261118;
    const r = lcg(seed);
    let completedFocusCases = 0;
    for (let i = 0; i < 400; i++) {
      const a = genPayload(r, true);
      const b = genPayload(r, false);
      const { phone, server } = both(a, b);
      expect(phone, `seed ${seed}, iteration ${i}\nbase ${JSON.stringify(a)}\ninc ${JSON.stringify(b)}`).toEqual(server);
      const focusTask = [...a.tasks, ...b.tasks].find(
        (t) => t.id === a.activeFocus.activeTaskId && t.status === "completed"
      );
      if (focusTask) completedFocusCases++;
    }
    expect(completedFocusCases, `seed ${seed}: the generator must reach the completed-focus rule`).toBeGreaterThan(10);
  });

  it("uses ?? stamp fallbacks like the reference: {updatedAt:0, createdAt:50} loses to {updatedAt:10}", () => {
    const empty = { quests: [], tasks: [], timeLogs: [], deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], lastSyncedAt: 0, activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 } };
    const base = loose({
      ...empty,
      quests: [{ id: "quest-1", slotIndex: 0, title: "old", updatedAt: 0, createdAt: 50 }],
      tasks: [{ id: "tsk-1", title: "old", status: "queued", rank: 0, updatedAt: 0, createdAt: 50 }],
    });
    const inc = loose({
      ...empty,
      quests: [{ id: "quest-1", slotIndex: 0, title: "new", updatedAt: 10 }],
      tasks: [{ id: "tsk-1", title: "new", status: "queued", rank: 0, updatedAt: 10 }],
    });
    const { phone, server } = both(base, inc);
    expect(phone).toEqual(server);
    expect(phone.quests).toEqual([expect.objectContaining({ title: "new" })]);
    expect(phone.tasks).toEqual([expect.objectContaining({ title: "new" })]);
  });

  it("clears a focus on a completed task with the reference reset stamp (+1)", () => {
    const base = loose({
      quests: [],
      tasks: [{ id: "tsk-1", title: "done", status: "completed", rank: 0, completedAt: 200, updatedAt: 200 }],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      lastSyncedAt: 0,
      activeFocus: { activeTaskId: "tsk-1", isRunning: false, sessionStartedAt: null, updatedAt: 300 },
    });
    const inc = loose({ ...base, tasks: [], activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 } });
    const { phone, server } = both(base, inc);
    expect(phone.activeFocus).toEqual({ activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 301 });
    expect(phone).toEqual(server);

    const later = loose({ ...base, activeFocus: { ...base.activeFocus, updatedAt: 100 } });
    const second = both(later, inc);
    expect(second.phone.activeFocus).toEqual(expect.objectContaining({ activeTaskId: null, updatedAt: 201 }));
    expect(second.phone).toEqual(second.server);
  });

  it("is stable: merging a merge result with itself changes nothing", () => {
    const seed = 99;
    const r = lcg(seed);
    for (let i = 0; i < 100; i++) {
      const merged = w.mergePayloads(genPayload(r, true), genPayload(r, false));
      const again = w.mergePayloads(merged, merged);
      expect(comparable(again), `seed ${seed}, iteration ${i}`).toEqual(comparable(merged));
    }
  });
});

describe("phone boundary guards agree with the server validator", () => {
  it("uses the same id constants and isSafeSyncId", () => {
    expect(w.eval("SAFE_ID_CHARS_RE.source")).toBe(SAFE_ID_CHARS_RE.source);
    expect(w.eval("MAX_ENTITY_ID_LENGTH")).toBe(MAX_ENTITY_ID_LENGTH);
    expect(w.eval("MAX_LOG_ID_LENGTH")).toBe(MAX_LOG_ID_LENGTH);
    const samples: unknown[] = [
      "", "a", "tsk-1.a:b", "log-1700000000000-tsk-1", "x".repeat(128), "x".repeat(129), "x".repeat(160),
      "x".repeat(161), "a b", "a/b", "a'b", "ä", "__proto__", "constructor", 5, null, undefined, {}, ["a"],
    ];
    for (const id of samples) {
      for (const max of [undefined, MAX_LOG_ID_LENGTH]) {
        expect(w.isSafeSyncId(id, max), `${JSON.stringify(id)} / ${max}`).toBe(isSafeSyncId(id, max));
      }
    }
  });

  it("keeps exactly the rows and tombstones the server keeps (300 seeded hostile payloads)", () => {
    const seed = 4242;
    const r = lcg(seed);
    const ids = ["quest-1", "tsk-1", "tsk-2.a:b", "", "a b", "<img>", "x".repeat(129), "x".repeat(150), "__proto__"];
    const logIds = ["log-1-tsk-1", "log-2-tsk-2.a:b", "x".repeat(150), "x".repeat(161), "bad id", ""];
    const titles: unknown[] = ["t", "", 5, null, { a: 1 }, ["x"]];
    const durations: unknown[] = [0, 60, -1, null, "60", 1e12];
    const starts: unknown[] = [0, 1000, -1, "1000", null, 2 ** 60, undefined];
    const maybe = (v: unknown, key: string, row: Record<string, unknown>) => {
      if (v !== undefined) row[key] = v;
      return row;
    };
    const row = () => (r.chance(0.1) ? r.pick([null, 5, "row", ["x"]]) : null);
    for (let i = 0; i < 300; i++) {
      const list = <T,>(gen: () => T) => Array.from({ length: r.int(0, 5) }, gen);
      const payload = {
        quests: list(() => row() ?? maybe(r.pick(titles), "title", { id: r.pick(ids), slotIndex: r.int(0, 2) })),
        tasks: list(() => row() ?? maybe(r.pick(titles), "title", { id: r.pick(ids), status: "queued", rank: 0 })),
        timeLogs: list(() =>
          row() ??
          maybe(r.pick(starts), "startTime", {
            id: r.pick(logIds),
            taskId: r.pick(ids),
            durationSeconds: r.pick(durations),
          })
        ),
        deletedQuestIds: list(() => r.pick(ids)),
        deletedTaskIds: list(() => r.pick(ids)),
        deletedLogIds: list(() => r.pick(logIds)),
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
        lastSyncedAt: 0,
      };
      const copy = () => JSON.parse(JSON.stringify(payload)) as unknown;
      const server = validateSyncPayload(copy());
      expect(server.valid, `seed ${seed}, iteration ${i}`).toBe(true);
      const phone = comparableIds(w.guardSyncState(copy()).value);
      expect(phone, `seed ${seed}, iteration ${i}
${JSON.stringify(payload).slice(0, 2000)}`).toEqual(comparableIds(server.payload));
    }
  });
});

function comparableIds(p: unknown) {
  const v = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
  const rowIds = (k: string) => (Array.isArray(v[k]) ? (v[k] as { id: string }[]).map((x) => x.id) : []);
  const set = (k: string) => (Array.isArray(v[k]) ? Array.from(new Set((v[k] as string[]).map(String))).sort() : []);
  return {
    quests: rowIds("quests"),
    tasks: rowIds("tasks"),
    timeLogs: rowIds("timeLogs"),
    deletedQuestIds: set("deletedQuestIds"),
    deletedTaskIds: set("deletedTaskIds"),
    deletedLogIds: set("deletedLogIds"),
  };
}
