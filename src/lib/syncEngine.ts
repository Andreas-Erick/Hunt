import { db } from "./db";
import {
  SYNC_TOKEN_STORAGE_KEY,
  TOMBSTONE_STORAGE_KEY,
  type ActiveFocusState,
  type Habit,
  type Quest,
  type Task,
  type TimeLog,
} from "./domainTypes";
import {
  newCorrelationId,
  recordBreadcrumb,
  redactText,
} from "./diagnostics";
import {
  MAX_TOMBSTONES_PER_KIND,
  mergeSyncPayloads,
  pickLogWinner,
  pickRowWinner,
  validateSyncPayload,
  type SyncPayload,
} from "./syncTypes";

/** A pairing key: 32–256 printable, non-space ASCII characters (same rule as the Android shell). */
const SYNC_TOKEN_RE = /^[\x21-\x7E]{32,256}$/;

/** Client-side timeout for one complete sync round trip (request + body). */
export const SYNC_REQUEST_TIMEOUT_MS = 8000;

/** Value of the `X-Hunt-Client` header this client sends (server peer tracking). */
export const SYNC_CLIENT_ID = "desktop";

/**
 * Why a sync attempt failed.
 * - `unreachable`  network error / timeout talking to the local server
 * - `auth`         HTTP 401 (pairing key missing or rejected)
 * - `too_large`    HTTP 413 (payload over the server's size cap)
 * - `bad_response` the server answered 2xx but the body was not a sync payload
 * - `local_db`     reading or writing this browser's IndexedDB failed
 * - `http_<code>`  any other non-2xx status
 */
export type SyncErrorCode =
  | "unreachable"
  | "auth"
  | "too_large"
  | "bad_response"
  | "local_db"
  | `http_${number}`;

/** Other devices the server has heard from recently (in-memory on the server). */
export interface SyncPeers {
  phone: { lastSeenAt: number | null };
}

export interface ServerSyncResult {
  ok: boolean;
  merged?: SyncPayload;
  lanUrls?: string[];
  /** True when applying the merged payload changed any local IndexedDB row. */
  changed?: boolean;
  peers?: SyncPeers;
  error?: SyncErrorCode;
}

/** Human-readable text for a sync error code (for status lines / tooltips). */
export function describeSyncError(code: string | null | undefined): string {
  if (!code) return "";
  switch (code) {
    case "unreachable":
      return "Local sync server not reachable";
    case "auth":
      return "Pairing key missing or rejected. Open Hunt with the desktop launcher to load the key.";
    case "too_large":
      return "Data is larger than the sync server accepts";
    case "bad_response":
      return "Unexpected response from the sync server";
    case "local_db":
      return "Could not read or save local data in this browser";
    case "http_503":
      return "Sync server could not save data; retrying (see %TEMP%\\hunt-server.log)";
    case "http_507":
      return "Server refused to overwrite its data file (see %TEMP%\\hunt-server.log)";
    default: {
      const m = /^http_(\d+)$/.exec(code);
      return m ? `Sync server error (HTTP ${m[1]})` : "Sync failed";
    }
  }
}

/** The trimmed pairing key, or '' when `raw` is not a valid one. */
function normalizeSyncToken(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const token = raw.trim();
  return SYNC_TOKEN_RE.test(token) ? token : "";
}

/** A `?token=` key that could not be persisted (storage blocked); kept for this page only. */
let unsavedUrlToken = "";

/**
 * Moves a `?token=` pairing key (put there by the desktop launcher) from the
 * address bar into localStorage, then removes that param from the URL; an
 * invalid value is removed too but never stored. Returns the valid key or ''.
 */
function takeUrlSyncToken(): string {
  const { pathname, search, hash } = window.location;
  const params = new URLSearchParams(search);
  if (!params.has("token")) return "";
  const token = normalizeSyncToken(params.get("token"));
  if (token) {
    try {
      window.localStorage.setItem(SYNC_TOKEN_STORAGE_KEY, token);
      unsavedUrlToken = "";
    } catch {
      unsavedUrlToken = token;
    }
  }
  params.delete("token");
  const rest = params.toString();
  try {
    window.history.replaceState(
      window.history.state,
      "",
      pathname + (rest ? `?${rest}` : "") + hash
    );
  } catch {
    // Best effort: a URL that cannot be rewritten does not affect the stored key.
  }
  return token;
}

/** The pairing key this desktop sends as `X-Hunt-Token`, or '' when none is known. */
export function getClientSyncToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromUrl = takeUrlSyncToken();
    if (fromUrl) return fromUrl;
    if (unsavedUrlToken) return unsavedUrlToken;
    return normalizeSyncToken(window.localStorage.getItem(SYNC_TOKEN_STORAGE_KEY));
  } catch {
    // Storage blocked: only a key ingested earlier on this page is known.
    return unsavedUrlToken;
  }
}

interface TombstoneStore {
  deletedQuestIds: string[];
  deletedTaskIds: string[];
  deletedLogIds: string[];
  deletedHabitIds: string[];
}

function getLocalTombstones(): TombstoneStore {
  if (typeof window === "undefined") {
    return { deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], deletedHabitIds: [] };
  }
  try {
    const raw = window.localStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) {
      return { deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], deletedHabitIds: [] };
    }
    const parsed = JSON.parse(raw) as Partial<TombstoneStore>;
    const ids = (arr: unknown): string[] =>
      Array.isArray(arr)
        ? arr.filter((x): x is string => typeof x === "string").slice(-MAX_TOMBSTONES_PER_KIND)
        : [];
    return {
      deletedQuestIds: ids(parsed.deletedQuestIds),
      deletedTaskIds: ids(parsed.deletedTaskIds),
      deletedLogIds: ids(parsed.deletedLogIds),
      deletedHabitIds: ids(parsed.deletedHabitIds),
    };
  } catch {
    return { deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [], deletedHabitIds: [] };
  }
}

function saveLocalTombstones(store: TombstoneStore): void {
  if (typeof window === "undefined") return;
  const bounded: TombstoneStore = {
    deletedQuestIds: store.deletedQuestIds.slice(-MAX_TOMBSTONES_PER_KIND),
    deletedTaskIds: store.deletedTaskIds.slice(-MAX_TOMBSTONES_PER_KIND),
    deletedLogIds: store.deletedLogIds.slice(-MAX_TOMBSTONES_PER_KIND),
    deletedHabitIds: store.deletedHabitIds.slice(-MAX_TOMBSTONES_PER_KIND),
  };
  try {
    window.localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // Ignore storage quota errors
  }
}

export function recordDeletedQuestTombstone(questId: string): void {
  const current = getLocalTombstones();
  if (!current.deletedQuestIds.includes(questId)) {
    current.deletedQuestIds.push(questId);
    saveLocalTombstones(current);
  }
}

export function recordDeletedTaskTombstone(taskId: string): void {
  const current = getLocalTombstones();
  if (!current.deletedTaskIds.includes(taskId)) {
    current.deletedTaskIds.push(taskId);
    saveLocalTombstones(current);
  }
}

export function recordDeletedLogTombstone(logId: string): void {
  const current = getLocalTombstones();
  if (!current.deletedLogIds.includes(logId)) {
    current.deletedLogIds.push(logId);
    saveLocalTombstones(current);
  }
}

export function recordDeletedHabitTombstone(habitId: string): void {
  const current = getLocalTombstones();
  if (!current.deletedHabitIds.includes(habitId)) {
    current.deletedHabitIds.push(habitId);
    saveLocalTombstones(current);
  }
}

/** True when this device has recorded a deletion tombstone for the task id. */
export function hasLocalTaskTombstone(taskId: string): boolean {
  return getLocalTombstones().deletedTaskIds.includes(taskId);
}

/** True when this device has recorded a deletion tombstone for the log id. */
export function hasLocalLogTombstone(logId: string): boolean {
  return getLocalTombstones().deletedLogIds.includes(logId);
}

/**
 * Builds a complete SyncPayload from the local device's IndexedDB + focus state.
 * All four tables are read in ONE readonly transaction (consistent snapshot).
 */
export async function buildLocalSyncPayload(
  activeFocus: ActiveFocusState
): Promise<SyncPayload> {
  const [quests, tasks, timeLogs, habits] = await db.transaction(
    "r",
    db.quests,
    db.tasks,
    db.timeLogs,
    db.habits,
    () =>
      Promise.all([
        db.quests.toArray(),
        db.tasks.toArray(),
        db.timeLogs.toArray(),
        db.habits.toArray(),
      ])
  );
  const tombstones = getLocalTombstones();

  return {
    quests,
    tasks,
    timeLogs,
    habits,
    deletedQuestIds: tombstones.deletedQuestIds,
    deletedTaskIds: tombstones.deletedTaskIds,
    deletedLogIds: tombstones.deletedLogIds,
    deletedHabitIds: tombstones.deletedHabitIds,
    activeFocus,
    lastSyncedAt: Date.now(),
  };
}

type Timestamped = { updatedAt?: number; completedAt?: number; createdAt?: number };

/** Last-write-wins timestamp of a row (same rule as the server merge). */
function rowTs(row: Timestamped): number {
  return row.updatedAt ?? row.completedAt ?? row.createdAt ?? 0;
}

/** Field-wise equality; a missing field equals an `undefined` one. */
function sameRow(a: object, b: object): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const eq = (x: unknown, y: unknown) =>
    x === y ||
    (typeof x === "object" &&
      x !== null &&
      typeof y === "object" &&
      y !== null &&
      JSON.stringify(x) === JSON.stringify(y));
  for (const k in ra) if (!eq(ra[k], rb[k])) return false;
  for (const k in rb) if (!(k in ra) && rb[k] !== undefined) return false;
  return true;
}

/** Appends ids of `extra` missing from `base`; returns `base` itself if nothing is new. */
function unionIds(base: string[], extra: unknown): string[] {
  if (!Array.isArray(extra) || extra.length === 0) return base;
  const seen = new Set(base);
  let out: string[] | null = null;
  for (const id of extra) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    (out ??= base.slice()).push(id);
  }
  return out ?? base;
}

function hasStringId<T extends { id: unknown }>(row: T | null | undefined): row is T {
  return !!row && typeof row === "object" && typeof row.id === "string";
}

/**
 * Applies a merged SyncPayload (e.g. the server's response) into local IndexedDB.
 *
 * The payload reflects a snapshot taken BEFORE the request went out, so it is
 * diff-merged against the CURRENT local rows inside one rw transaction:
 * - quests/tasks: the newer row wins; EQUAL timestamps are resolved by the
 *   shared rule R1 (pickRowWinner: smaller canonical content wins, identical
 *   keeps the local row), compared after nulling a `questId` that points at a
 *   tombstoned quest (that nulling is also applied to the result);
 *   `accumulatedSeconds` takes the max of both
 * - logs: two versions of one id are resolved by the shared rule R2
 *   (pickLogWinner: the earlier endTime wins)
 * - tombstones are UNIONED with the local list (never replaced), so a deletion
 *   recorded after the snapshot survives
 * - only rows that exist are deleted, only rows that differ are written
 *
 * Returns true when anything changed. An idle sync performs zero writes and so
 * triggers zero useLiveQuery re-runs.
 */
export async function applyMergedPayloadToLocalDB(
  merged: SyncPayload
): Promise<boolean> {
  const local = getLocalTombstones();
  const tomb: TombstoneStore = {
    deletedQuestIds: unionIds(local.deletedQuestIds, merged.deletedQuestIds),
    deletedTaskIds: unionIds(local.deletedTaskIds, merged.deletedTaskIds),
    deletedLogIds: unionIds(local.deletedLogIds, merged.deletedLogIds),
    deletedHabitIds: unionIds(local.deletedHabitIds, merged.deletedHabitIds),
  };
  if (
    tomb.deletedQuestIds !== local.deletedQuestIds ||
    tomb.deletedTaskIds !== local.deletedTaskIds ||
    tomb.deletedLogIds !== local.deletedLogIds ||
    tomb.deletedHabitIds !== local.deletedHabitIds
  ) {
    saveLocalTombstones(tomb);
  }

  const deletedQuests = new Set(tomb.deletedQuestIds);
  const deletedTasks = new Set(tomb.deletedTaskIds);
  const deletedLogs = new Set(tomb.deletedLogIds);
  const deletedHabits = new Set(tomb.deletedHabitIds);

  const remoteQuests = (merged.quests ?? []).filter(
    (q): q is Quest => hasStringId(q) && !deletedQuests.has(q.id)
  );
  const remoteTasks = (merged.tasks ?? []).filter(
    (t): t is Task => hasStringId(t) && !deletedTasks.has(t.id)
  );
  const remoteLogs = (merged.timeLogs ?? []).filter(
    (l): l is TimeLog => hasStringId(l) && !deletedLogs.has(l.id)
  );
  const remoteHabits = (merged.habits ?? []).filter(
    (h): h is Habit => hasStringId(h) && !deletedHabits.has(h.id)
  );

  const unlinkDeletedQuest = <T extends { questId: string | null }>(row: T): T =>
    row.questId && deletedQuests.has(row.questId) ? { ...row, questId: null } : row;

  return db.transaction("rw", db.quests, db.tasks, db.timeLogs, db.habits, async () => {
    const [
      localQuests,
      localTasks,
      localLogs,
      localHabits,
      questDeletes,
      taskDeletes,
      logDeletes,
      habitDeletes,
    ] = await Promise.all([
      db.quests.bulkGet(remoteQuests.map((q) => q.id)),
      db.tasks.bulkGet(remoteTasks.map((t) => t.id)),
      db.timeLogs.bulkGet(remoteLogs.map((l) => l.id)),
      db.habits.bulkGet(remoteHabits.map((h) => h.id)),
      // Primary keys of tombstoned rows that actually exist locally.
      deletedQuests.size
        ? db.quests.where("id").anyOf(Array.from(deletedQuests)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedTasks.size
        ? db.tasks.where("id").anyOf(Array.from(deletedTasks)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedLogs.size
        ? db.timeLogs.where("id").anyOf(Array.from(deletedLogs)).primaryKeys()
        : Promise.resolve([] as string[]),
      deletedHabits.size
        ? db.habits.where("id").anyOf(Array.from(deletedHabits)).primaryKeys()
        : Promise.resolve([] as string[]),
    ]);

    const questPuts: Quest[] = [];
    remoteQuests.forEach((remote, i) => {
      const current = localQuests[i];
      if (!current) {
        questPuts.push(remote);
        return;
      }
      // R1: newer wins; equal stamps → deterministic content tie-break.
      const winner = pickRowWinner(current, rowTs(current), remote, rowTs(remote));
      if (winner !== current && !sameRow(winner, current)) questPuts.push(winner);
    });

    const taskPuts: Task[] = [];
    remoteTasks.forEach((remote, i) => {
      const current = localTasks[i];
      if (!current) {
        taskPuts.push(unlinkDeletedQuest(remote));
        return;
      }
      // R1 compares the rows AFTER questId sanitising (as the server does).
      const localRow = unlinkDeletedQuest(current);
      const remoteRow = unlinkDeletedQuest(remote);
      const winner = pickRowWinner(localRow, rowTs(localRow), remoteRow, rowTs(remoteRow));
      const seconds = Math.max(
        current.accumulatedSeconds || 0,
        remote.accumulatedSeconds || 0
      );
      const next: Task =
        (winner.accumulatedSeconds || 0) === seconds
          ? winner
          : { ...winner, accumulatedSeconds: seconds };
      if (!sameRow(next, current)) taskPuts.push(next);
    });

    const logPuts: TimeLog[] = [];
    remoteLogs.forEach((remote, i) => {
      const current = localLogs[i];
      if (!current) {
        logPuts.push(remote);
        return;
      }
      // R2: the remote version replaces ours only if it differs AND wins.
      if (!sameRow(remote, current) && pickLogWinner(current, remote) === remote) {
        logPuts.push(remote);
      }
    });

    const habitPuts: Habit[] = [];
    remoteHabits.forEach((remote, i) => {
      const current = localHabits[i];
      if (!current) {
        habitPuts.push(unlinkDeletedQuest(remote));
        return;
      }
      const localRow = unlinkDeletedQuest(current);
      const remoteRow = unlinkDeletedQuest(remote);
      const winner = pickRowWinner(localRow, rowTs(localRow), remoteRow, rowTs(remoteRow));
      if (winner !== current && !sameRow(winner, current)) habitPuts.push(winner);
    });

    if (questDeletes.length) await db.quests.bulkDelete(questDeletes);
    if (taskDeletes.length) await db.tasks.bulkDelete(taskDeletes);
    if (logDeletes.length) await db.timeLogs.bulkDelete(logDeletes);
    if (habitDeletes.length) await db.habits.bulkDelete(habitDeletes);
    if (questPuts.length) await db.quests.bulkPut(questPuts);
    if (taskPuts.length) await db.tasks.bulkPut(taskPuts);
    if (logPuts.length) await db.timeLogs.bulkPut(logPuts);
    if (habitPuts.length) await db.habits.bulkPut(habitPuts);

    return (
      questDeletes.length +
        taskDeletes.length +
        logDeletes.length +
        habitDeletes.length +
        questPuts.length +
        taskPuts.length +
        logPuts.length +
        habitPuts.length >
      0
    );
  });
}

function mapHttpStatus(status: number): SyncErrorCode {
  if (status === 401) return "auth";
  if (status === 413) return "too_large";
  return `http_${status}`;
}

function normalizePeers(raw: unknown): SyncPeers {
  const phone =
    raw && typeof raw === "object"
      ? (raw as { phone?: { lastSeenAt?: unknown } }).phone
      : undefined;
  const seen = phone && typeof phone === "object" ? phone.lastSeenAt : null;
  return {
    phone: {
      lastSeenAt:
        typeof seen === "number" && Number.isFinite(seen) && seen > 0 ? seen : null,
    },
  };
}

/** Own fields of a JSON object, or none for anything else. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The server's merge time when it is a sane stamp, now otherwise. */
function serverMergeStamp(rawPayload: unknown): number {
  const ts = asRecord(rawPayload).lastSyncedAt;
  return typeof ts === "number" && ts > 0 && ts <= Number.MAX_SAFE_INTEGER ? ts : Date.now();
}

type SyncFailurePhase = "build" | "request" | "response" | "apply";

/** Last failure code written to the console; cleared by a successful sync. */
let lastLoggedFailureCode: SyncErrorCode | null = null;

/**
 * Internal diagnostic for a failed sync: one structured console.error per
 * change of failure code, so a retry loop does not flood the console. Logs
 * only the error's name and message, never the pairing key or payload rows.
 */
function logSyncFailure(
  phase: SyncFailurePhase,
  code: SyncErrorCode,
  err?: unknown,
  status?: number,
  correlationId?: string,
  durationMs?: number
): void {
  const e = asRecord(err);
  const rawMessage = typeof err === "string" ? err : e.message;
  const safeMessage =
    typeof rawMessage === "string" ? redactText(rawMessage) : undefined;
  recordBreadcrumb({
    level: "ERROR",
    domain: "sync",
    event: "sync_failed",
    correlationId,
    durationMs,
    context: {
      phase,
      code,
      status,
      name: typeof e.name === "string" ? e.name : undefined,
      message: safeMessage,
    },
  });
  if (code === lastLoggedFailureCode) return;
  lastLoggedFailureCode = code;
  console.error("[hunt-sync] sync_failed", {
    phase,
    code,
    status,
    name: typeof e.name === "string" ? e.name : undefined,
    message: safeMessage,
  });
}

function syncFailed(
  phase: SyncFailurePhase,
  code: SyncErrorCode,
  err?: unknown,
  status?: number,
  correlationId?: string,
  startedAt?: number
): ServerSyncResult {
  const durationMs =
    typeof startedAt === "number" ? Math.max(0, Date.now() - startedAt) : undefined;
  logSyncFailure(phase, code, err, status, correlationId, durationMs);
  return { ok: false, error: code };
}

/**
 * Performs a 2-way sync with the local Next.js `/api/sync` endpoint and applies
 * the merged result to local IndexedDB (diff-apply, see above).
 * Never throws; never waits longer than SYNC_REQUEST_TIMEOUT_MS on the network.
 */
export async function performServerSync(
  currentFocus: ActiveFocusState
): Promise<ServerSyncResult> {
  if (typeof window === "undefined") {
    return { ok: false, error: "unreachable" };
  }

  const correlationId = newCorrelationId();
  const startedAt = Date.now();

  let localPayload: SyncPayload;
  try {
    localPayload = await buildLocalSyncPayload(currentFocus);
  } catch (err) {
    return syncFailed("build", "local_db", err, undefined, correlationId, startedAt);
  }

  let body: unknown;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), SYNC_REQUEST_TIMEOUT_MS)
    : null;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Hunt-Client": SYNC_CLIENT_ID,
      "X-Hunt-Correlation-Id": correlationId,
    };
    const token = getClientSyncToken();
    if (token) headers["X-Hunt-Token"] = token;
    const res = await fetch("/api/sync", {
      method: "POST",
      headers,
      body: JSON.stringify(localPayload),
      cache: "no-store",
      signal: controller?.signal,
    });

    if (!res.ok) {
      try {
        await res.body?.cancel();
      } catch {
        // The status code is all this result needs.
      }
      return syncFailed(
        "response",
        mapHttpStatus(res.status),
        undefined,
        res.status,
        correlationId,
        startedAt
      );
    }

    try {
      body = await res.json();
    } catch (err) {
      // A JSON SyntaxError message can quote body text: log the name only.
      return syncFailed(
        "response",
        controller?.signal.aborted ? "unreachable" : "bad_response",
        { name: asRecord(err).name },
        res.status,
        correlationId,
        startedAt
      );
    }
  } catch (err) {
    return syncFailed("request", "unreachable", err, undefined, correlationId, startedAt);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const data = asRecord(body);
  const check = validateSyncPayload(data.payload);
  if (!check.valid || !check.payload) {
    return syncFailed(
      "response",
      "bad_response",
      check.error,
      undefined,
      correlationId,
      startedAt
    );
  }
  const merged: SyncPayload = {
    ...check.payload,
    lastSyncedAt: serverMergeStamp(data.payload),
  };

  let changed: boolean;
  try {
    changed = await applyMergedPayloadToLocalDB(merged);
  } catch (err) {
    return syncFailed("apply", "local_db", err, undefined, correlationId, startedAt);
  }

  lastLoggedFailureCode = null;
  recordBreadcrumb({
    level: "DEBUG",
    domain: "sync",
    event: "sync_succeeded",
    correlationId,
    durationMs: Date.now() - startedAt,
    context: { changed },
  });
  return {
    ok: true,
    merged,
    lanUrls: Array.isArray(data.lanUrls)
      ? data.lanUrls.filter((u): u is string => typeof u === "string")
      : undefined,
    changed,
    peers: normalizePeers(data.peers),
  };
}

/** An imported snapshot is not JSON or not a sync payload; nothing was written. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

/**
 * Merges an imported JSON snapshot string directly into local IndexedDB (for offline sync).
 * Throws SnapshotFormatError for unparseable or invalid input (before touching
 * IndexedDB); storage errors propagate unchanged.
 */
export async function importAndMergeSnapshotJson(
  jsonText: string,
  currentFocus: ActiveFocusState
): Promise<SyncPayload> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new SnapshotFormatError("Not valid JSON");
  }
  const check = validateSyncPayload(parsed);
  if (!check.valid || !check.payload) {
    throw new SnapshotFormatError(check.error ?? "Invalid snapshot");
  }
  const local = await buildLocalSyncPayload(currentFocus);
  const merged = mergeSyncPayloads(local, check.payload);
  await applyMergedPayloadToLocalDB(merged);
  return merged;
}
