import type { ActiveFocusState } from "./domainTypes";
import {
  newCorrelationId,
  recordBreadcrumb,
  redactText,
} from "./diagnostics";
import { asRecord } from "./jsonRecord";
import { applyMergedPayloadToLocalDB, buildLocalSyncPayload } from "./applySnapshot";
import { TOMBSTONE_KINDS, getLocalTombstones } from "./syncTombstones";
import { getClientSyncToken } from "./syncToken";
import {
  syncPayloadHasContent,
  validateSyncPayload,
  type SyncPayload,
} from "./syncTypes";

/*
 * The desktop's HTTP sync client: one 2-way round trip with the local
 * `/api/sync` server, plus the seed's "data exists elsewhere" check.
 *
 * Token handling (syncToken.ts), tombstones (syncTombstones.ts) and the local
 * IndexedDB snapshot (applySnapshot.ts) live in their own modules; their
 * public names are re-exported here so existing imports keep working.
 */
export { getClientSyncToken } from "./syncToken";
export {
  hasLocalLogTombstone,
  hasLocalTaskTombstone,
  recordDeletedHabitTombstone,
  recordDeletedLogTombstone,
  recordDeletedQuestTombstone,
  recordDeletedTaskTombstone,
} from "./syncTombstones";
export {
  SnapshotFormatError,
  applyMergedPayloadToLocalDB,
  buildLocalSyncPayload,
  importAndMergeSnapshotJson,
} from "./applySnapshot";

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
 * applySnapshot.ts). Never throws; never waits longer than SYNC_REQUEST_TIMEOUT_MS on the
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
