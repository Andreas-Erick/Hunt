// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  MAX_CHECKLIST_ITEMS,
  MAX_CHECKLIST_TEXT_LENGTH,
  MAX_ENTITY_ID_LENGTH,
  MAX_LOG_ID_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  SAFE_ID_RE,
  canonicalString,
  createEmptySyncPayload,
  isSafeSyncId,
  mergeSyncPayloads,
  syncContentKey,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";

// Boundary validation of sync payloads: structural problems reject
// the payload; row-level problems drop the row or coerce the field.

type Row = Record<string, unknown>;
type RowKind = "quest" | "task" | "log";

const MAX = Number.MAX_SAFE_INTEGER;
const QUEST_ID = "quest-1763400000000-a1b2";
const TASK_ID = "tsk-1763400000000-abcd";
const LOG_ID = `log-1763400000000-${TASK_ID}`;

const questRow = (overrides: Row = {}): Row => ({
  id: QUEST_ID,
  slotIndex: 1,
  code: "CORE",
  title: "Launch my idea",
  description: "Ship v1",
  accentColor: "emerald",
  targetWeeklyHours: 12,
  archived: false,
  createdAt: 1000,
  updatedAt: 2000,
  ...overrides,
});

const taskRow = (overrides: Row = {}): Row => ({
  id: TASK_ID,
  title: "Write the essay",
  notes: "Draft first",
  questId: QUEST_ID,
  status: "active",
  rank: 1000,
  accumulatedSeconds: 60,
  scheduledDate: "2026-11-18",
  createdAt: 1000,
  updatedAt: 2000,
  completedAt: 3000,
  ...overrides,
});

const logRow = (overrides: Row = {}): Row => ({
  id: LOG_ID,
  taskId: TASK_ID,
  taskTitleSnapshot: "Write the essay",
  questId: QUEST_ID,
  questCodeSnapshot: "Launch my idea",
  accentColorSnapshot: "emerald",
  startTime: 1_763_400_000_000,
  endTime: 1_763_400_060_000,
  durationSeconds: 60,
  dateKey: "2026-11-17",
  ...overrides,
});

const BASE_ROW: Record<RowKind, (overrides?: Row) => Row> = {
  quest: questRow,
  task: taskRow,
  log: logRow,
};

function rawPayload(parts: Row = {}): Row {
  return { ...createEmptySyncPayload(), ...parts };
}

function validated(input: unknown): { payload: SyncPayload; dropped: number } {
  const check = validateSyncPayload(input);
  if (!check.valid || !check.payload) throw new Error(`unexpectedly rejected: ${check.error}`);
  return { payload: check.payload, dropped: check.dropped ?? 0 };
}

function rowsOf(payload: SyncPayload, kind: RowKind): readonly object[] {
  if (kind === "quest") return payload.quests;
  if (kind === "task") return payload.tasks;
  return payload.timeLogs;
}

/** The single sanitized row of `kind` built from `raw`, or undefined when it was dropped. */
function sanitizeOne(kind: RowKind, raw: unknown): Map<string, unknown> | undefined {
  const arrayKey = kind === "quest" ? "quests" : kind === "task" ? "tasks" : "timeLogs";
  const [row] = rowsOf(validated(rawPayload({ [arrayKey]: [raw] })).payload, kind);
  return row ? new Map<string, unknown>(Object.entries(row)) : undefined;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("validateSyncPayload: structure", () => {
  it.each([
    ["null", null],
    ["a string", "not-an-object"],
    ["a number", 42],
    ["an array", []],
    ["quests missing", { tasks: [], timeLogs: [] }],
    ["quests not an array", rawPayload({ quests: "bad" })],
    ["tasks not an array", rawPayload({ tasks: {} })],
    ["timeLogs not an array", rawPayload({ timeLogs: null })],
  ])("rejects %s", (_label, input) => {
    const check = validateSyncPayload(input);
    expect(check.valid).toBe(false);
    expect(check.payload).toBeUndefined();
    expect(typeof check.error).toBe("string");
  });

  it.each([
    // History is never pruned, so these sit above what the 16 MB byte cap admits (older caps of
    // 100 quests and 20,000 tasks/logs were reachable by years of normal use).
    ["quests", 5000, (i: number) => questRow({ id: `quest-${i}` })],
    ["tasks", 100_000, (i: number) => taskRow({ id: `tsk-${i}` })],
    ["timeLogs", 100_000, (i: number) => logRow({ id: `log-${i}-${TASK_ID}` })],
  ] as const)("accepts exactly %s %i rows and rejects one more", (key, cap, make) => {
    const rows = Array.from({ length: cap + 1 }, (_, i) => make(i));
    const atCap = validateSyncPayload(rawPayload({ [key]: rows.slice(0, cap) }));
    expect(atCap.valid).toBe(true);
    expect(atCap.payload?.[key]).toHaveLength(cap);
    expect(validateSyncPayload(rawPayload({ [key]: rows })).valid).toBe(false);
  });

  it("accepts empty collections and defaults missing tombstones and focus", () => {
    const { payload, dropped } = validated({ quests: [], tasks: [], timeLogs: [] });
    expect(dropped).toBe(0);
    expect(payload).toEqual({ ...createEmptySyncPayload(), lastSyncedAt: payload.lastSyncedAt });
  });

  it("passes a well-formed payload through with identical content, as a new copy", () => {
    const inputTask = taskRow();
    const input = rawPayload({
      quests: [questRow()],
      tasks: [inputTask],
      timeLogs: [logRow()],
      deletedQuestIds: ["quest-old"],
      deletedTaskIds: ["tsk-old"],
      deletedLogIds: [`log-1-${TASK_ID}`],
      activeFocus: { activeTaskId: TASK_ID, isRunning: true, sessionStartedAt: 5000, updatedAt: 5000 },
      lastSyncedAt: 1,
    });
    const { payload, dropped } = validated(input);
    expect(dropped).toBe(0);
    expect(syncContentKey(payload)).toBe(canonicalString({ ...input, lastSyncedAt: 0 }));
    expect(payload.tasks[0]).not.toBe(inputTask);
    payload.tasks[0].title = "mutated";
    expect(inputTask.title).toBe("Write the essay");
  });

  it("drops rows that cannot be legitimate without rejecting the payload", () => {
    const { payload, dropped } = validated(
      rawPayload({
        quests: [null, 42, "q", [], questRow({ title: 7 }), questRow()],
        tasks: [taskRow({ title: null }), taskRow({ title: { text: "x" } }), taskRow()],
        timeLogs: [logRow({ durationSeconds: -1 }), logRow({ taskId: "" }), logRow()],
      })
    );
    expect(dropped).toBe(9);
    expect(payload.quests.map((q) => q.id)).toEqual([QUEST_ID]);
    expect(payload.tasks.map((t) => t.id)).toEqual([TASK_ID]);
    expect(payload.timeLogs.map((l) => l.id)).toEqual([LOG_ID]);
  });

  it("is idempotent: validating its own output changes nothing", () => {
    const first = validated(
      rawPayload({
        quests: [questRow({ accentColor: "violet", title: "q".repeat(400), slotIndex: NaN })],
        tasks: [taskRow({ status: "bogus", rank: Infinity, accumulatedSeconds: 1e300, scheduledDate: "x" })],
        timeLogs: [logRow({ dateKey: "nope", endTime: -5, durationSeconds: 5e9 })],
      })
    ).payload;
    const second = validated(JSON.parse(JSON.stringify(first)));
    expect(second.dropped).toBe(0);
    expect(syncContentKey(second.payload)).toBe(syncContentKey(first));
  });
});

// ---------------------------------------------------------------------------
// Boundary matrix for every numeric field
// ---------------------------------------------------------------------------

const REMOVED = Symbol("field removed");
const DROPPED = Symbol("row dropped");

const MATRIX_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ["0", 0],
  ["-1", -1],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["-Infinity", -Infinity],
  ["1e300", 1e300],
  ["MAX_SAFE_INTEGER", MAX],
  ["MAX_SAFE_INTEGER+2", MAX + 2],
  ["0.1+0.2", 0.1 + 0.2],
  ["'123'", "123"],
  ["null", null],
  ["undefined", undefined],
];

// Expected result per MATRIX_INPUTS entry: R = field removed, D = row dropped,
// F = 0.1 + 0.2 kept as is, anything else = the sanitized value.
const R = REMOVED;
const D = DROPPED;
const F = 0.1 + 0.2;
const STAMP: unknown[] = [0, R, R, R, R, R, MAX, R, F, R, R, R];

const NUMERIC_FIELDS: ReadonlyArray<readonly [RowKind, string, unknown[]]> = [
  ["quest", "createdAt", STAMP],
  ["quest", "updatedAt", STAMP],
  ["quest", "slotIndex", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  ["quest", "targetWeeklyHours", [0, 0, 10, 10, 10, 168, 168, 168, F, 10, 10, 10]],
  ["task", "createdAt", STAMP],
  ["task", "updatedAt", STAMP],
  ["task", "completedAt", [0, R, R, R, R, R, MAX, R, F, R, null, R]],
  ["task", "rank", [0, -1, R, R, R, 1e300, MAX, MAX + 2, F, R, R, R]],
  ["task", "accumulatedSeconds", [0, 0, 0, 0, 0, 1e9, 1e9, 1e9, F, 0, 0, 0]],
  ["log", "startTime", [0, D, D, D, D, D, MAX, D, F, D, D, D]],
  ["log", "endTime", STAMP],
  ["log", "durationSeconds", [0, D, D, D, D, 1e9, 1e9, 1e9, F, D, D, D]],
];

describe.each(NUMERIC_FIELDS)("boundary matrix: %s.%s", (kind, field, expected) => {
  it.each(MATRIX_INPUTS.map(([label, value], i) => [label, value, expected[i]] as const))(
    "%s",
    (label, value, want) => {
      const row = sanitizeOne(kind, BASE_ROW[kind]({ [field]: value }));
      const where = `${kind}.${field} = ${label}`;
      if (want === DROPPED) {
        expect(row, where).toBeUndefined();
        return;
      }
      expect(row, where).toBeDefined();
      if (want === REMOVED) expect(row?.has(field), where).toBe(false);
      else expect(row?.get(field), where).toBe(want);
    }
  );
});

describe("boundary matrix: activeFocus", () => {
  const focusAfter = (overrides: Row) =>
    validated(
      rawPayload({
        tasks: [taskRow()],
        activeFocus: { activeTaskId: TASK_ID, isRunning: true, sessionStartedAt: 5000, updatedAt: 5000, ...overrides },
      })
    ).payload.activeFocus;

  it.each(MATRIX_INPUTS.map(([label, value], i) => [label, value, i] as const))(
    "updatedAt and sessionStartedAt = %s",
    (label, value, i) => {
      const keptAsStamp = STAMP[i] !== REMOVED;
      expect(focusAfter({ updatedAt: value }).updatedAt, label).toBe(keptAsStamp ? value : 0);
      const started = focusAfter({ sessionStartedAt: value });
      expect(started.sessionStartedAt, label).toBe(keptAsStamp ? value : null);
      expect(started.isRunning, label).toBe(keptAsStamp);
    }
  );

  it("keeps only the four focus fields; an unsafe task id clears and stops the focus", () => {
    const focus = focusAfter({ activeTaskId: `x" onfocus=alert(1)`, extra: "x", nested: { a: 1 } });
    expect(focus).toEqual({ activeTaskId: null, isRunning: false, sessionStartedAt: 5000, updatedAt: 5000 });
    expect(validated(rawPayload({ activeFocus: "running" })).payload.activeFocus).toEqual(
      createEmptySyncPayload().activeFocus
    );
  });
});

describe("slotIndex keeps only the three real slots", () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 0],
    [1.5, 0],
    ["1", 0],
  ])("%s -> %s", (input, want) => {
    expect(sanitizeOne("quest", questRow({ slotIndex: input }))?.get("slotIndex")).toBe(want);
  });
});

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe("ids", () => {
  const HOSTILE_IDS = ["", `x" onfocus=alert(1)`, "');alert(1);//", "a b", "../etc/passwd", "tsk\u0000", 42, null];

  it.each([
    ["quest", "id", MAX_ENTITY_ID_LENGTH],
    ["task", "id", MAX_ENTITY_ID_LENGTH],
    ["log", "id", MAX_LOG_ID_LENGTH],
    ["log", "taskId", MAX_ENTITY_ID_LENGTH],
  ] as const)("%s.%s: kept up to %i safe characters, otherwise the row is dropped", (kind, field, max) => {
    expect(sanitizeOne(kind, BASE_ROW[kind]({ [field]: "x".repeat(max) }))?.get(field)).toBe("x".repeat(max));
    expect(sanitizeOne(kind, BASE_ROW[kind]({ [field]: "x".repeat(max + 1) }))).toBeUndefined();
    for (const id of HOSTILE_IDS) {
      expect(sanitizeOne(kind, BASE_ROW[kind]({ [field]: id })), String(id)).toBeUndefined();
    }
  });

  it("keeps the 128/129 boundary for task and quest ids as SAFE_ID_RE states it", () => {
    expect(isSafeSyncId("x".repeat(128))).toBe(true);
    expect(isSafeSyncId("x".repeat(129))).toBe(false);
    expect(isSafeSyncId("x".repeat(160), MAX_LOG_ID_LENGTH)).toBe(true);
    expect(isSafeSyncId("x".repeat(161), MAX_LOG_ID_LENGTH)).toBe(false);
    for (const id of [...HOSTILE_IDS, "x".repeat(128), "x".repeat(129), TASK_ID, "quest-slot-0", "a:b.c_d-e"]) {
      expect(SAFE_ID_RE.test(String(id)) && typeof id === "string", String(id)).toBe(isSafeSyncId(id));
    }
  });

  it("keeps real generated and seeded ids", () => {
    const ids = [TASK_ID, QUEST_ID, LOG_ID, "tsk-1763400000000-a", "quest-slot-0", "tsk-tom-01", "log-seed-today-1"];
    for (const id of ids) expect(isSafeSyncId(id, MAX_LOG_ID_LENGTH), id).toBe(true);
    // A log id for the longest legal task id still fits.
    expect(isSafeSyncId(`log-${MAX}-${"x".repeat(MAX_ENTITY_ID_LENGTH)}`, MAX_LOG_ID_LENGTH)).toBe(true);
  });

  it("nulls a questId that is not a safe id (task and log)", () => {
    for (const questId of [...HOSTILE_IDS, "x".repeat(129), { id: QUEST_ID }]) {
      expect(sanitizeOne("task", taskRow({ questId }))?.get("questId"), String(questId)).toBeNull();
      expect(sanitizeOne("log", logRow({ questId }))?.get("questId"), String(questId)).toBeNull();
    }
    expect(sanitizeOne("task", taskRow({ questId: null }))?.get("questId")).toBeNull();
    expect(sanitizeOne("task", taskRow())?.get("questId")).toBe(QUEST_ID);
  });

  it("keeps only safe tombstones, with the log length for log tombstones, newest 5000", () => {
    const { payload } = validated(
      rawPayload({
        deletedQuestIds: ["quest-a", "", `x" onfocus=alert(1)`, 7, "x".repeat(129)],
        deletedTaskIds: ["tsk-a", "');alert(1);//", null, "x".repeat(128)],
        deletedLogIds: ["x".repeat(160), "x".repeat(161), `log-1-${TASK_ID}`],
      })
    );
    expect(payload.deletedQuestIds).toEqual(["quest-a"]);
    expect(payload.deletedTaskIds).toEqual(["tsk-a", "x".repeat(128)]);
    expect(payload.deletedLogIds).toEqual(["x".repeat(160), `log-1-${TASK_ID}`]);
    const many = Array.from({ length: 5001 }, (_, i) => `tsk-${i}`);
    const kept = validated(rawPayload({ deletedTaskIds: many })).payload.deletedTaskIds;
    expect(kept).toHaveLength(5000);
    expect(kept[0]).toBe("tsk-1");
    expect(validated(rawPayload({ deletedLogIds: "tsk-1" })).payload.deletedLogIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

describe("text fields", () => {
  const VERBATIM = [
    "",
    "   ",
    "مرحبا بالعالم",
    "שלום עולם",
    "👨‍👩‍👧‍👦",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "' OR 1=1 --",
    "a\u0000b",
  ];

  it.each(VERBATIM)("keeps title %j verbatim as data", (title) => {
    expect(sanitizeOne("task", taskRow({ title }))?.get("title")).toBe(title);
    expect(sanitizeOne("quest", questRow({ title }))?.get("title")).toBe(title);
  });

  it("cuts titles at the limits (300 quest / 1000 task) and keeps them up to it", () => {
    const at = (n: number) => "t".repeat(n);
    expect(sanitizeOne("quest", questRow({ title: at(MAX_QUEST_TITLE_LENGTH) }))?.get("title")).toBe(at(300));
    expect(sanitizeOne("quest", questRow({ title: at(301) }))?.get("title")).toBe(at(300));
    expect(sanitizeOne("task", taskRow({ title: at(MAX_TASK_TITLE_LENGTH) }))?.get("title")).toBe(at(1000));
    expect(sanitizeOne("task", taskRow({ title: at(1001) }))?.get("title")).toBe(at(1000));
    expect(sanitizeOne("task", taskRow({ title: at(10_000) }))?.get("title")).toBe(at(1000));
    expect(sanitizeOne("quest", questRow({ title: at(10_000) }))?.get("title")).toBe(at(300));
  });

  it("never splits a surrogate pair when cutting", () => {
    const title = `${"a".repeat(999)}😀tail`;
    expect(sanitizeOne("task", taskRow({ title }))?.get("title")).toBe("a".repeat(999));
  });

  it("cuts notes, description and taskTitleSnapshot, and removes them when not strings", () => {
    expect(String(sanitizeOne("task", taskRow({ notes: "n".repeat(20_001) }))?.get("notes"))).toHaveLength(20_000);
    expect(String(sanitizeOne("quest", questRow({ description: "d".repeat(20_001) }))?.get("description"))).toHaveLength(20_000);
    expect(String(sanitizeOne("log", logRow({ taskTitleSnapshot: "s".repeat(1001) }))?.get("taskTitleSnapshot"))).toHaveLength(1000);
    expect(sanitizeOne("task", taskRow({ notes: 5 }))?.has("notes")).toBe(false);
    expect(sanitizeOne("quest", questRow({ description: ["x"] }))?.has("description")).toBe(false);
    expect(sanitizeOne("log", logRow({ taskTitleSnapshot: null }))?.has("taskTitleSnapshot")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Enums and dates
// ---------------------------------------------------------------------------

describe("enums and dates", () => {
  it.each(["violet", "__proto__", "constructor", "toString", "", 3, null])("accent %j becomes the default", (accent) => {
    expect(sanitizeOne("quest", questRow({ accentColor: accent }))?.get("accentColor")).toBe("cyan");
    expect(sanitizeOne("log", logRow({ accentColorSnapshot: accent }))?.get("accentColorSnapshot")).toBe("slate");
  });

  it("keeps the real accents ('slate' only on logs)", () => {
    for (const accent of ["cyan", "emerald", "amber"]) {
      expect(sanitizeOne("quest", questRow({ accentColor: accent }))?.get("accentColor")).toBe(accent);
      expect(sanitizeOne("log", logRow({ accentColorSnapshot: accent }))?.get("accentColorSnapshot")).toBe(accent);
    }
    expect(sanitizeOne("quest", questRow({ accentColor: "slate" }))?.get("accentColor")).toBe("cyan");
    expect(sanitizeOne("log", logRow({ accentColorSnapshot: "slate" }))?.get("accentColorSnapshot")).toBe("slate");
  });

  it.each(["<img src=x onerror=alert(1)>", "constructor", "done", "", 1, undefined])("status %j becomes 'queued'", (status) => {
    expect(sanitizeOne("task", taskRow({ status }))?.get("status")).toBe("queued");
  });

  it("keeps every real status", () => {
    for (const status of ["queued", "active", "completed", "archived"]) {
      expect(sanitizeOne("task", taskRow({ status }))?.get("status")).toBe(status);
    }
  });

  it("removes a scheduledDate that is neither null nor YYYY-MM-DD", () => {
    for (const scheduledDate of ["x');alert(1);('", "2026-1-1", "18.11.2026", 20261118, {}]) {
      expect(sanitizeOne("task", taskRow({ scheduledDate }))?.has("scheduledDate"), String(scheduledDate)).toBe(false);
    }
    expect(sanitizeOne("task", taskRow({ scheduledDate: null }))?.get("scheduledDate")).toBeNull();
    expect(sanitizeOne("task", taskRow({ scheduledDate: "2024-02-29" }))?.get("scheduledDate")).toBe("2024-02-29");
  });

  it("keeps a Skipped habit day's skipped: true and drops any other skipped value", () => {
    expect(sanitizeOne("task", taskRow({ skipped: true }))?.get("skipped")).toBe(true);
    for (const skipped of [false, "yes", "true", 1, {}, null]) {
      expect(sanitizeOne("task", taskRow({ skipped }))?.has("skipped"), JSON.stringify(skipped)).toBe(false);
    }
  });

  it("keeps a reminderTime only when it is a local 24-hour HH:MM", () => {
    for (const reminderTime of ["9:30", "24:00", "09:30:00", "noon", 930, null, {}]) {
      expect(sanitizeOne("task", taskRow({ reminderTime }))?.has("reminderTime"), String(reminderTime)).toBe(false);
    }
    expect(sanitizeOne("task", taskRow({ reminderTime: "07:05" }))?.get("reminderTime")).toBe("07:05");
  });

  it("recomputes an invalid log dateKey from endTime, else from startTime", () => {
    const end = 1_763_420_000_000;
    expect(sanitizeOne("log", logRow({ dateKey: "<b>", endTime: end }))?.get("dateKey")).toBe(localDateKey(end));
    const start = 1_700_000_000_000;
    const noEnd = sanitizeOne("log", logRow({ dateKey: 20261118, startTime: start, endTime: "later" }));
    expect(noEnd?.get("dateKey")).toBe(localDateKey(start));
    expect(noEnd?.has("endTime")).toBe(false);
    // Midnight rollover: the end's local day, as both clients derive it.
    const beforeMidnight = new Date(2026, 10, 18, 23, 50).getTime();
    const afterMidnight = new Date(2026, 10, 19, 0, 20).getTime();
    expect(
      sanitizeOne("log", logRow({ dateKey: "", startTime: beforeMidnight, endTime: afterMidnight }))?.get("dateKey")
    ).toBe("2026-11-19");
    // Even the largest accepted timestamp yields a well-formed key.
    const far = sanitizeOne("log", logRow({ dateKey: null, startTime: MAX, endTime: MAX }));
    expect(String(far?.get("dateKey"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Unknown fields, nesting and prototype pollution
// ---------------------------------------------------------------------------

describe("a Task's Checklist", () => {
  const item = (id: string, text: string, done = false) => ({ id, text, done });

  it("keeps a well-formed Checklist, in order", () => {
    const checklist = [item("chk-1", "Passport", true), item("chk-2", "Charger")];
    expect(sanitizeOne("task", taskRow({ checklist }))?.get("checklist")).toEqual(checklist);
  });

  it("rejects a Checklist on a habit day Task", () => {
    const row = taskRow({ id: "habtsk-2026-11-18-hab-1", habitId: "hab-1", checklist: [item("chk-1", "Warm up")] });
    const task = sanitizeOne("task", row);
    expect(task?.get("habitId")).toBe("hab-1");
    expect(task?.has("checklist")).toBe(false);
  });

  it("drops a Checklist that is not a list, and items that cannot be legitimate", () => {
    expect(sanitizeOne("task", taskRow({ checklist: "Passport" }))?.has("checklist")).toBe(false);
    expect(sanitizeOne("task", taskRow({ checklist: { 0: item("chk-1", "a") } }))?.has("checklist")).toBe(false);
    const kept = sanitizeOne("task", taskRow({
      checklist: [
        item("chk-1", "Passport"),
        null,
        "Charger",
        { id: "<b>", text: "bad id", done: false },
        { id: "chk-2", text: 7, done: false },
        { id: "chk-3", text: "No done flag" },
        { id: "chk-4", text: "Stringy done", done: "yes" },
        item("chk-1", "Duplicate id"),
        { ...item("chk-5", "Extra keys"), colour: "red", __proto__: { polluted: 1 } },
      ],
    }))?.get("checklist");
    expect(kept).toEqual([
      item("chk-1", "Passport"),
      item("chk-3", "No done flag"),
      item("chk-4", "Stringy done"),
      item("chk-5", "Extra keys"),
    ]);
  });

  it("cuts item text and keeps at most the first MAX_CHECKLIST_ITEMS items", () => {
    const long = sanitizeOne("task", taskRow({ checklist: [item("chk-1", "x".repeat(MAX_CHECKLIST_TEXT_LENGTH + 9))] }));
    expect((long?.get("checklist") as { text: string }[])[0].text).toHaveLength(MAX_CHECKLIST_TEXT_LENGTH);
    const many = Array.from({ length: MAX_CHECKLIST_ITEMS + 5 }, (_, n) => item(`chk-${n}`, `Item ${n}`));
    const capped = sanitizeOne("task", taskRow({ checklist: many }))?.get("checklist") as { id: string }[];
    expect(capped).toHaveLength(MAX_CHECKLIST_ITEMS);
    expect(capped[0].id).toBe("chk-0");
  });

  it("keeps an emptied Checklist, so a device's own write is never changed", () => {
    expect(sanitizeOne("task", taskRow({ checklist: [] }))?.get("checklist")).toEqual([]);
  });
});

describe("unknown fields, nesting and prototype keys", () => {
  it("keeps scalar unknown fields (questCodeSnapshot, code, archived) and drops objects and arrays", () => {
    const log = sanitizeOne("log", logRow({ questCodeSnapshot: "Launch my idea", extraNumber: 3, extraNull: null, extraObject: { a: 1 }, extraArray: [1] }));
    expect(log?.get("questCodeSnapshot")).toBe("Launch my idea");
    expect(log?.get("extraNumber")).toBe(3);
    expect(log?.get("extraNull")).toBeNull();
    expect(log?.has("extraObject")).toBe(false);
    expect(log?.has("extraArray")).toBe(false);
    const quest = sanitizeOne("quest", questRow({ code: "CORE", archived: true, extraNaN: NaN }));
    expect(quest?.get("code")).toBe("CORE");
    expect(quest?.get("archived")).toBe(true);
    expect(quest?.has("extraNaN")).toBe(false);
    expect(String(sanitizeOne("task", taskRow({ extraText: "e".repeat(10_001) }))?.get("extraText"))).toHaveLength(10_000);
  });

  it("removes a 200,000-deep nested notes array, so canonicalString cannot overflow", () => {
    let deep: unknown[] = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(() => canonicalString({ notes: deep })).toThrow(RangeError);

    const { payload } = validated(rawPayload({ tasks: [taskRow({ notes: deep, meta: deep })] }));
    expect(Object.keys(payload.tasks[0])).not.toContain("notes");
    expect(Object.keys(payload.tasks[0])).not.toContain("meta");
    expect(() => canonicalString(payload)).not.toThrow();
    expect(() => syncContentKey(mergeSyncPayloads(payload, payload))).not.toThrow();
  });

  it("never copies __proto__ / constructor / prototype keys from raw JSON text", () => {
    const text = `{
      "__proto__": { "polluted": "top" },
      "constructor": { "prototype": { "polluted": "ctor" } },
      "quests": [{ "id": "q1", "title": "Q", "__proto__": { "polluted": "quest" },
                   "constructor": { "prototype": { "polluted": "quest-ctor" } }, "prototype": { "polluted": "p" } }],
      "tasks": [{ "id": "t1", "title": "T", "__proto__": { "polluted": "task" }, "constructor": "c", "prototype": 1 }],
      "timeLogs": [{ "id": "log-1-t1", "taskId": "t1", "startTime": 1, "durationSeconds": 1,
                     "__proto__": { "polluted": "log" }, "constructor": null }],
      "activeFocus": { "__proto__": { "polluted": "focus" }, "constructor": { "prototype": { "polluted": "f" } } },
      "deletedTaskIds": [], "deletedLogIds": []
    }`;
    const { payload } = validated(JSON.parse(text) as unknown);
    const forbidden = ["__proto__", "constructor", "prototype"];
    const objects: object[] = [payload, payload.activeFocus, ...payload.quests, ...payload.tasks, ...payload.timeLogs];
    expect(payload.quests).toHaveLength(1);
    expect(payload.tasks).toHaveLength(1);
    expect(payload.timeLogs).toHaveLength(1);
    for (const obj of objects) {
      for (const key of forbidden) expect(Object.prototype.hasOwnProperty.call(obj, key), key).toBe(false);
      expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
      expect(Reflect.get(obj, "polluted")).toBeUndefined();
    }
    mergeSyncPayloads(payload, payload);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/__proto__|constructor|prototype|polluted/);
  });
});

// ---------------------------------------------------------------------------
// Seeded fuzz: random garbage rows never break the validator's invariants
// ---------------------------------------------------------------------------

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("seeded fuzz of row sanitizing", () => {
  const POOL: unknown[] = [
    ...MATRIX_INPUTS.map(([, value]) => value),
    "", "   ", "<script>alert(1)</script>", "x".repeat(300), "👨‍👩‍👧‍👦", true, false, [], {}, [[1]], { a: { b: 1 } },
    TASK_ID, QUEST_ID, "2026-11-18", "cyan", "slate", "completed", "__proto__", "x".repeat(129),
    [{ id: "chk-1", text: "Passport", done: true }, { id: "chk-1", text: "dup", done: false }, { id: 3 }],
    "09:30", "24:00",
  ];
  const FIELDS = [
    "id", "title", "notes", "description", "questId", "taskId", "status", "rank", "accumulatedSeconds",
    "scheduledDate", "createdAt", "updatedAt", "completedAt", "slotIndex", "accentColor", "accentColorSnapshot",
    "targetWeeklyHours", "startTime", "endTime", "durationSeconds", "dateKey", "taskTitleSnapshot",
    "questCodeSnapshot", "checklist", "extra", "constructor", "prototype", "reminderTime",
  ];
  const isScalar = (v: unknown) =>
    v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
  const inRange = (v: unknown, min: number, max: number) => typeof v === "number" && v >= min && v <= max;

  it("keeps every output row typed, bounded and flat, and validation idempotent (300 seeds)", () => {
    const BASE_SEED = 0x5a11d;
    for (let i = 0; i < 300; i++) {
      const seed = BASE_SEED + i;
      const rand = lcg(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
      const row = (base: Row): unknown => {
        if (rand() < 0.1) return pick(POOL);
        const out: Row = { ...base };
        for (const field of FIELDS) if (rand() < 0.3) out[field] = pick(POOL);
        return out;
      };
      const input = rawPayload({
        quests: Array.from({ length: 4 }, () => row(questRow())),
        tasks: Array.from({ length: 6 }, () => row(taskRow())),
        timeLogs: Array.from({ length: 6 }, () => row(logRow())),
        deletedTaskIds: [pick(POOL), pick(POOL)],
        activeFocus: { activeTaskId: pick(POOL), isRunning: pick(POOL), sessionStartedAt: pick(POOL), updatedAt: pick(POOL) },
      });
      const msg = `seed=${seed}`;
      const { payload } = validated(input);

      for (const q of payload.quests) {
        expect(isSafeSyncId(q.id), msg).toBe(true);
        expect(q.title.length, msg).toBeLessThanOrEqual(MAX_QUEST_TITLE_LENGTH);
        expect(["cyan", "emerald", "amber"], msg).toContain(q.accentColor);
        expect([0, 1, 2], msg).toContain(q.slotIndex);
        expect(inRange(q.targetWeeklyHours, 0, 168), msg).toBe(true);
      }
      for (const t of payload.tasks) {
        expect(isSafeSyncId(t.id), msg).toBe(true);
        expect(typeof t.title === "string" && t.title.length <= MAX_TASK_TITLE_LENGTH, msg).toBe(true);
        expect(["queued", "active", "completed", "archived"], msg).toContain(t.status);
        expect(inRange(t.accumulatedSeconds, 0, 1e9), msg).toBe(true);
        expect(t.questId === null || isSafeSyncId(t.questId), msg).toBe(true);
        expect(t.reminderTime === undefined || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t.reminderTime), msg).toBe(true);
      }
      for (const l of payload.timeLogs) {
        expect(isSafeSyncId(l.id, MAX_LOG_ID_LENGTH) && isSafeSyncId(l.taskId), msg).toBe(true);
        expect(inRange(l.startTime, 0, MAX) && inRange(l.durationSeconds, 0, 1e9), msg).toBe(true);
        expect(l.dateKey, msg).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(["cyan", "emerald", "amber", "slate"], msg).toContain(l.accentColorSnapshot);
      }
      for (const t of payload.tasks) {
        if (t.checklist === undefined) continue;
        expect(t.habitId, msg).toBeUndefined();
        for (const i of t.checklist) {
          expect(Object.keys(i).sort(), msg).toEqual(["done", "id", "text"]);
          expect(isSafeSyncId(i.id) && typeof i.text === "string" && typeof i.done === "boolean", msg).toBe(true);
        }
      }
      for (const r of [...payload.quests, ...payload.tasks, ...payload.timeLogs]) {
        for (const [key, value] of Object.entries(r)) {
          if (key === "checklist") continue; // a list of flat items, checked above
          expect(isScalar(value), `${msg} ${key}`).toBe(true);
          expect(["__proto__", "constructor", "prototype"], msg).not.toContain(key);
        }
      }
      const f = payload.activeFocus;
      expect(f.isRunning ? f.activeTaskId !== null && f.sessionStartedAt !== null : true, msg).toBe(true);

      const again = validated(JSON.parse(JSON.stringify(payload)));
      expect(again.dropped, msg).toBe(0);
      expect(syncContentKey(again.payload), msg).toBe(syncContentKey(payload));
    }
  });
});

// ---------------------------------------------------------------------------
// Route level: the real /api/sync handler with a throwaway data directory
// ---------------------------------------------------------------------------

describe("/api/sync with hostile rows", () => {
  const KEY = "v".repeat(64);
  const HOSTILE_ID = `x"><img src=x onerror=alert(1)>`;
  let dir = "";
  let route: typeof import("@/app/api/sync/route");

  const syncFile = () => path.join(dir, "hunt-sync.json");
  const call = (method: "GET" | "POST", payload?: unknown) =>
    new Request("http://192.168.1.5:3000/api/sync", {
      method,
      headers: { "Content-Type": "application/json", "X-Hunt-Token": KEY, "X-Hunt-Client": "desktop" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  // A fresh data directory and route import per test: no test reads rows that
  // another one stored, so the order does not matter.
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-sync-validation-test-"));
    fs.writeFileSync(path.join(dir, "hunt-sync.key"), KEY, "utf8");
    process.env.HUNT_DATA_DIR = dir;
    vi.resetModules();
    route = await import("@/app/api/sync/route");
  });

  afterEach(() => {
    delete process.env.HUNT_DATA_DIR;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stores the valid row and drops a task whose id is an HTML payload (200, not 400)", async () => {
    const res = await route.POST(
      call("POST", rawPayload({ tasks: [taskRow({ id: HOSTILE_ID }), taskRow({ id: "tsk-valid" })] }))
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { payload: SyncPayload };
    expect(json.payload.tasks.map((t) => t.id)).toEqual(["tsk-valid"]);

    const storedText = fs.readFileSync(syncFile(), "utf8");
    expect(storedText).not.toContain("onerror");
    const stored = JSON.parse(storedText) as SyncPayload;
    expect(stored.tasks.map((t) => t.id)).toEqual(["tsk-valid"]);
  });

  it("still reads a stored file that holds row-level garbage (no 507)", async () => {
    fs.writeFileSync(
      syncFile(),
      JSON.stringify(
        rawPayload({
          quests: [questRow({ accentColor: "violet" })],
          tasks: [taskRow({ id: "tsk-kept" }), taskRow({ id: "tsk-bad", title: 42 }), { id: HOSTILE_ID, title: "x" }],
          timeLogs: [logRow({ durationSeconds: -5 })],
        })
      ),
      "utf8"
    );
    const res = await route.GET(call("GET"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { payload: SyncPayload };
    expect(json.payload.tasks.map((t) => t.id)).toEqual(["tsk-kept"]);
    expect(json.payload.quests[0].accentColor).toBe("cyan");
    expect(json.payload.timeLogs).toEqual([]);
  });
});

describe("quest completion boundary validation", () => {
  it("preserves valid boolean archived & stamp completedAt and strips invalid boundary values", () => {
    const valid = validateSyncPayload({
      ...createEmptySyncPayload(),
      quests: [
        questRow({ id: "quest-done-0", archived: true, completedAt: 0 }),
        questRow({ id: "quest-done-max", archived: true, completedAt: MAX }),
        questRow({ id: "quest-open", archived: false, completedAt: null }),
        questRow({
          id: "quest-bad-meta",
          archived: "yes",
          completedAt: -1,
        }),
        questRow({
          id: "quest-nan-meta",
          archived: 1,
          completedAt: Number.NaN,
        }),
        questRow({
          id: "quest-inf-meta",
          archived: null,
          completedAt: MAX + 1,
        }),
      ],
    });
    expect(valid.valid).toBe(true);
    const qs = valid.payload!.quests;
    expect(qs).toHaveLength(6);

    expect(qs[0]).toMatchObject({ id: "quest-done-0", archived: true, completedAt: 0 });
    expect(qs[1]).toMatchObject({ id: "quest-done-max", archived: true, completedAt: MAX });
    expect(qs[2]).toMatchObject({ id: "quest-open", archived: false, completedAt: null });

    expect(qs[3].archived).toBeUndefined();
    expect(qs[3].completedAt).toBeUndefined();
    expect(qs[4].archived).toBeUndefined();
    expect(qs[4].completedAt).toBeUndefined();
    expect(qs[5].archived).toBeUndefined();
    expect(qs[5].completedAt).toBeUndefined();
  });
});
