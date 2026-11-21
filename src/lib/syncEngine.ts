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
  questOrHabitRowStamp,
  syncPayloadHasContent,
  taskRowStamp,
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
 * - `too_large`    HTTP 413 (payload over the server's size cap), or a 507
 *                  whose body code is `merged_over_limit` (merged data over it)
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

export type ServerSyncResult =
  | {
      ok: true;
      merged: SyncPayload;
      /** True when applying the merged payload changed any local IndexedDB row. */
      changed: boolean;
      lanUrls?: string[];
      peers?: SyncPeers;
      error?: undefined;
    }
  | {
      ok: false;
      error: SyncErrorCode;
      merged?: undefined;
      changed?: undefined;
      lanUrls?: undefined;
      peers?: undefined;
    };

type NamedSyncErrorCode = Exclude<SyncErrorCode, `http_${number}`>;

/** Text for every named code: a new SyncErrorCode literal must get one here. */
const SYNC_ERROR_TEXT: Readonly<Record<NamedSyncErrorCode, string>> = {
  unreachable: "Local sync server not reachable",
  auth: "Pairing key missing or rejected. Open Hunt with the desktop launcher to load the key.",
  too_large: "Data is larger than the sync server accepts",
  bad_response: "Unexpected response from the sync server",
  local_db: "Could not read or save local data in this browser",
};

/** HTTP statuses with their own text; any other one gets the generic fallback. */
const HTTP_STATUS_TEXT: Readonly<Partial<Record<number, string>>> = {
  503: "Sync server could not save data; retrying (see %TEMP%\\hunt-server.log)",
  507: "Server refused to overwrite its data file (see %TEMP%\\hunt-server.log)",
};

function isNamedSyncErrorCode(code: string): code is NamedSyncErrorCode {
  return Object.prototype.hasOwnProperty.call(SYNC_ERROR_TEXT, code);
}

/** Human-readable text for a sync error code (for status lines / tooltips). */
export function describeSyncError(code: string | null | undefined): string {
  if (!code) return "";
  if (isNamedSyncErrorCode(code)) return SYNC_ERROR_TEXT[code];
  const m = /^http_(\d+)$/.exec(code);
  if (!m) return "Sync failed";
  return (
    HTTP_STATUS_TEXT[Number(m[1])] ??
    `Sync server hit an error. Restart Hunt from the desktop launcher (details in %TEMP%\\hunt-server.log, HTTP ${m[1]})`
  );
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

/** The tombstone lists of a SyncPayload, one per deletable kind. */
const TOMBSTONE_KINDS = [
  "deletedQuestIds",
  "deletedTaskIds",
  "deletedLogIds",
  "deletedHabitIds",
] as const satisfies readonly (keyof SyncPayload)[];

type TombstoneKind = (typeof TOMBSTONE_KINDS)[number];
type TombstoneStore = Record<TombstoneKind, string[]>;

/** Builds a store from one list per kind (the compiler requires every kind here). */
function buildTombstones(listFor: (kind: TombstoneKind) => string[]): TombstoneStore {
  return {
    deletedQuestIds: listFor("deletedQuestIds"),
    deletedTaskIds: listFor("deletedTaskIds"),
    deletedLogIds: listFor("deletedLogIds"),
    deletedHabitIds: listFor("deletedHabitIds"),
  };
}

function emptyTombstones(): TombstoneStore {
  return buildTombstones(() => []);
}

function getLocalTombstones(): TombstoneStore {
  if (typeof window === "undefined") return emptyTombstones();
  try {
    const raw = window.localStorage.getItem(TOMBSTONE_STORAGE_KEY);
    if (!raw) return emptyTombstones();
    const parsed = asRecord(JSON.parse(raw));
    return buildTombstones((kind) => {
      const list: unknown = parsed[kind];
      return Array.isArray(list)
        ? list.filter((x): x is string => typeof x === "string").slice(-MAX_TOMBSTONES_PER_KIND)
        : [];
    });
  } catch {
    return emptyTombstones();
  }
}

/** Persists the (bounded) store; false when localStorage refused it (quota, blocked). */
function saveLocalTombstones(store: TombstoneStore): boolean {
  if (typeof window === "undefined") return false;
  const bounded = buildTombstones((kind) => store[kind].slice(-MAX_TOMBSTONES_PER_KIND));
  try {
    window.localStorage.setItem(TOMBSTONE_STORAGE_KEY, JSON.stringify(bounded));
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a local deletion. Throws when the tombstone cannot be saved: the
 * caller must then NOT delete the row, or the next sync would bring it back
 * from the server (no row and no tombstone are sent).
 */
function recordTombstone(kind: TombstoneKind, id: string): void {
  const current = getLocalTombstones();
  if (current[kind].includes(id)) return;
  current[kind].push(id);
  if (!saveLocalTombstones(current)) {
    throw new Error("Could not record the deletion in this browser's storage");
  }
}

export function recordDeletedQuestTombstone(questId: string): void {
  recordTombstone("deletedQuestIds", questId);
}

export function recordDeletedTaskTombstone(taskId: string): void {
  recordTombstone("deletedTaskIds", taskId);
}

export function recordDeletedLogTombstone(logId: string): void {
  recordTombstone("deletedLogIds", logId);
}

export function recordDeletedHabitTombstone(habitId: string): void {
  recordTombstone("deletedHabitIds", habitId);
}

export const SEED_SERVER_CHECK_TIMEOUT_MS = 1500;

/**
 * True when this browser or the local sync server already holds sync data, so
 * demo rows must NOT be seeded into an empty local DB (fresh browser profile,
 * cleared site data, another origin such as 127.0.0.1 or the LAN URL): seeding
 * then would push fake rows into the synced dataset and on to the phone.
 *
 * Local deletion tombstones count without asking the server. Otherwise returns
 * false (seed) ONLY after a successful 2xx whose sync payload holds no rows and
 * no tombstones. Everything else returns true (do NOT seed): rows or tombstones
 * on the server, an HTTP error (it exists but its data could not be read), and
 * also a timeout/abort, a network error or a body that is not a sync payload.
 * The desktop page is served by this same server, so a failed check means
 * "slow" (cold compile, resume, antivirus), not "no server".
 */
export async function syncDataExistsElsewhere(): Promise<boolean> {
  const local = getLocalTombstones();
  if (TOMBSTONE_KINDS.some((kind) => local[kind].length > 0)) return true;
  if (typeof fetch !== "function") return true;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), SEED_SERVER_CHECK_TIMEOUT_MS)
    : null;
  try {
    const headers: Record<string, string> = { "X-Hunt-Client": SYNC_CLIENT_ID };
    const token = getClientSyncToken();
    if (token) headers["X-Hunt-Token"] = token;
    const res = await fetch("/api/sync", {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!res.ok) return true;
    const check = validateSyncPayload(asRecord(await res.json()).payload);
    if (!check.valid) return true;
    return syncPayloadHasContent(check.payload);
  } catch {
    // Abort (timeout), network error or unparsable body: unknown → do not seed.
    return true;
  } finally {
    if (timer) clearTimeout(timer);
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
  return {
    quests,
    tasks,
    timeLogs,
    habits,
    ...getLocalTombstones(),
    activeFocus,
    lastSyncedAt: Date.now(),
  };
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
 * - quests/tasks/habits: the newer row wins by the server's per-kind stamp
 *   (questOrHabitRowStamp / taskRowStamp); EQUAL timestamps are resolved by the
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
  const tomb = buildTombstones((kind) => unionIds(local[kind], merged[kind]));
  if (TOMBSTONE_KINDS.some((kind) => tomb[kind] !== local[kind])) {
    // Best effort: the server already holds these tombstones and sends them again.
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
      const winner = pickRowWinner(
        current,
        questOrHabitRowStamp(current),
        remote,
        questOrHabitRowStamp(remote)
      );
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
      const winner = pickRowWinner(
        localRow,
        taskRowStamp(localRow),
        remoteRow,
        taskRowStamp(remoteRow)
      );
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
      const winner = pickRowWinner(
        localRow,
        questOrHabitRowStamp(localRow),
        remoteRow,
        questOrHabitRowStamp(remoteRow)
      );
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

/**
 * The error code of a non-2xx answer. Only a 507 body is read: its `code`
 * tells merged data over the server limits (shown as too_large) apart from an
 * unreadable server file (http_507). Any other body is cancelled unread.
 */
async function failedResponseCode(res: Response): Promise<SyncErrorCode> {
  if (res.status === 507) {
    try {
      if (asRecord(await res.json()).code === "merged_over_limit") return "too_large";
    } catch {
      // No readable envelope (older server): the status is all there is.
    }
    return mapHttpStatus(res.status);
  }
  try {
    await res.body?.cancel();
  } catch {
    // The status code is all this result needs.
  }
  return mapHttpStatus(res.status);
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
  // The correlation id matches the server's X-Hunt-Correlation-Id log line.
  console.error("[hunt-sync] sync_failed", {
    phase,
    code,
    status,
    name: typeof e.name === "string" ? e.name : undefined,
    message: safeMessage,
    correlationId,
    durationMs,
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
 * The transport seam under a sync pass: sends one POST body (the local
 * SyncPayload as JSON) with the client headers to the sync server and returns
 * its HTTP response. Must reject only for a network-level failure or an abort
 * through `signal`.
 */
export type SyncTransport = (request: {
  body: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}) => Promise<Response>;

/** Production adapter: the local Next.js `/api/sync` endpoint over fetch. */
export const httpSyncTransport: SyncTransport = ({ body, headers, signal }) =>
  fetch("/api/sync", { method: "POST", headers, body, cache: "no-store", signal });

/**
 * Performs a 2-way sync through `transport` (default: the local `/api/sync`
 * endpoint) and applies the merged result to local IndexedDB (diff-apply, see
 * above). Never throws; never waits longer than SYNC_REQUEST_TIMEOUT_MS on the
 * network.
 */
export async function performServerSync(
  currentFocus: ActiveFocusState,
  transport: SyncTransport = httpSyncTransport
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
    const res = await transport({
      body: JSON.stringify(localPayload),
      headers,
      signal: controller?.signal,
    });

    if (!res.ok) {
      return syncFailed(
        "response",
        await failedResponseCode(res),
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
  if (!check.valid) {
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
  if (!check.valid) {
    throw new SnapshotFormatError(check.error);
  }
  const local = await buildLocalSyncPayload(currentFocus);
  const merged = mergeSyncPayloads(local, check.payload);
  await applyMergedPayloadToLocalDB(merged);
  return merged;
}
