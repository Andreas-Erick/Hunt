import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import {
  newCorrelationId,
  recordBreadcrumb,
  redactText,
  sanitizeCorrelationId,
  summarizeError,
} from "@/lib/diagnostics";
import {
  authorizeRequestWithSyncKey,
  getOrCreateServerSyncKey,
  isLocalhostPeerRequest,
  type SyncAuthResult,
} from "@/lib/serverSyncAuth";
import {
  DATA_DIR,
  describeSkipped,
  mainFileExists,
  preserveCorruptMainFile,
  readServerSyncFile,
  writeServerSyncFileAtomic,
  type UnreadableFile,
} from "@/lib/serverSyncStore";
import { mergeSyncPayloads, syncContentKey, validateSyncPayload } from "@/lib/syncTypes";

export const dynamic = "force-dynamic";

const KEY_FILE = path.join(DATA_DIR, "hunt-sync.key");

// Byte cap for a request body and for the merged state the server stores and
// returns (clients post their full state). It is the binding limit: the count
// caps in syncTypes.ts (20,000 tasks, 20,000 time logs at ~7 MB) sit above it.
const MAX_PAYLOAD_BYTES = 16_000_000;
const PAYLOAD_TOO_LARGE = "Payload exceeds the server size limit";
const LAN_URL_CACHE_MS = 30_000;

// ---------------------------------------------------------------------------
// Diagnostics (stable event names; never log tokens or payload content)
// ---------------------------------------------------------------------------

/** Request-scoped fields every server log line carries when they are known. */
interface LogMeta {
  correlationId?: string;
  durationMs?: number;
}

type SyncLogEvent =
  | "key_unavailable"
  | "unreadable"
  | "recovered_from_backup"
  | "write_failed"
  | "backup_failed"
  | "snapshot_failed"
  | "merged_over_limit"
  | "post_error";

function logEvent(
  event: SyncLogEvent,
  client: string,
  detail?: unknown,
  meta?: LogMeta
): void {
  // An Error keeps its (redacted) stack and cause so a 500 can be traced to a line.
  const safeDetail =
    detail instanceof Error
      ? summarizeError(detail)
      : typeof detail === "string"
      ? redactText(detail)
      : detail;
  recordBreadcrumb({
    level: "ERROR",
    domain: "sync_server",
    event,
    correlationId: meta?.correlationId,
    durationMs: meta?.durationMs,
    context: { client, detail: safeDetail },
  });
  // The correlation id joins this terminal line to the client's sync_failed log.
  const fields: { client: string; correlationId?: string; durationMs?: number } = { client };
  if (meta?.correlationId) fields.correlationId = meta.correlationId;
  if (typeof meta?.durationMs === "number") fields.durationMs = meta.durationMs;
  const args: unknown[] = [`[hunt-sync] ${event}`, fields];
  if (safeDetail !== undefined) args.push(safeDetail);
  console.error(...args);
}

/** Extracts a safe inbound X-Hunt-Correlation-Id or creates a fresh one. */
function requestCorrelationId(request: Request): string {
  return (
    sanitizeCorrelationId(request.headers.get("x-hunt-correlation-id")) ??
    newCorrelationId()
  );
}

/** The client-controlled X-Hunt-Client header, reduced to a safe log label. */
function clientLabel(request: Request): string {
  const raw = request.headers.get("x-hunt-client") ?? "";
  return raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "unknown";
}

/**
 * Stable machine-readable reason next to the human `error` text. Statuses and
 * texts are unchanged for older phone builds; `code` tells apart failures that
 * share a status (507: unreadable server data vs. merged data over the limits).
 */
export type SyncErrorResponseCode =
  | "unauthorized"
  | "key_unavailable"
  | "unsupported_media_type"
  | "payload_too_large"
  | "malformed_json"
  | "invalid_payload"
  | "server_data_unreadable"
  | "merged_over_limit"
  | "save_failed"
  | "internal";

function errorResponse(
  status: number,
  code: SyncErrorResponseCode,
  error: string,
  correlationId?: string
): NextResponse {
  return NextResponse.json(
    { code, error },
    {
      status,
      headers: correlationId ? { "X-Hunt-Correlation-Id": correlationId } : undefined,
    }
  );
}

// ---------------------------------------------------------------------------
// Peer tracking (in memory only; on globalThis so dev recompiles keep it)
// ---------------------------------------------------------------------------

interface PeerRegistry {
  phone: number | null;
  desktop: number | null;
}

const peerHost = globalThis as typeof globalThis & {
  __huntSyncPeers?: PeerRegistry;
};

function peerRegistry(): PeerRegistry {
  if (!peerHost.__huntSyncPeers) {
    peerHost.__huntSyncPeers = { phone: null, desktop: null };
  }
  return peerHost.__huntSyncPeers;
}

/** Records a successful sync from the calling client. */
function notePeerSeen(request: Request): void {
  const client = (request.headers.get("x-hunt-client") ?? "").trim().toLowerCase();
  const registry = peerRegistry();
  const now = Date.now();
  if (client === "android" || client === "mobile-web") {
    registry.phone = now;
  } else if (client === "desktop") {
    registry.desktop = now;
  } else if (!client && !isLocalhostPeerRequest(request)) {
    // Legacy phone builds send no X-Hunt-Client header; the only remote
    // clients of this server are the phone.
    registry.phone = now;
  }
}

function peersForResponse() {
  return { phone: { lastSeenAt: peerRegistry().phone } };
}

// ---------------------------------------------------------------------------
// Auth: every request needs the X-Hunt-Token header (no exemptions)
// ---------------------------------------------------------------------------

let keyFailureLogged = false;

function authorize(request: Request, correlationId: string): SyncAuthResult {
  const client = clientLabel(request);
  const secret = getOrCreateServerSyncKey({
    dataDir: DATA_DIR,
    keyFile: KEY_FILE,
    onSuccess: () => {
      keyFailureLogged = false;
    },
    onError: (err) => {
      if (!keyFailureLogged) {
        keyFailureLogged = true;
        logEvent("key_unavailable", client, err, { correlationId });
      }
    },
  });
  return authorizeRequestWithSyncKey(request, secret);
}

/** The 401/503 response for a request that may not use the API, else null. */
function authFailureResponse(request: Request, correlationId: string): NextResponse | null {
  const auth = authorize(request, correlationId);
  if (auth === "ok") return null;
  if (auth === "no_key") {
    return errorResponse(
      503,
      "key_unavailable",
      "Sync key unavailable on the server",
      correlationId
    );
  }
  return errorResponse(
    401,
    "unauthorized",
    "Unauthorized: Invalid or missing X-Hunt-Token",
    correlationId
  );
}

// ---------------------------------------------------------------------------
// Request body (size-capped while streaming)
// ---------------------------------------------------------------------------

/** Lowercased media type of a Content-Type header, without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * The body as UTF-8 text, or null when it exceeds MAX_PAYLOAD_BYTES. Bytes are
 * counted while streaming, so an oversized body is never buffered whole.
 */
async function readBodyWithinLimit(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAYLOAD_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The body is rejected either way.
      }
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks, total));
}

// ---------------------------------------------------------------------------
// LAN addresses (cached: os.networkInterfaces() on every request is wasteful)
// ---------------------------------------------------------------------------

let lanUrlCache: { at: number; port: number; urls: string[] } | null = null;

function getLanUrls(port = 3000): string[] {
  const now = Date.now();
  if (lanUrlCache && lanUrlCache.port === port && now - lanUrlCache.at < LAN_URL_CACHE_MS) {
    return lanUrlCache.urls;
  }

  const interfaces = os.networkInterfaces();
  const candidates: Array<{ url: string; priority: number }> = [];

  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === "IPv4" && !iface.internal) {
        const ip = iface.address;
        if (ip.startsWith("169.254.")) continue;

        let priority = 4;
        const lowerName = name.toLowerCase();
        if (
          ip.startsWith("192.168.") &&
          (lowerName.includes("wi-fi") ||
            lowerName.includes("wlan") ||
            lowerName.includes("eth"))
        ) {
          priority = 1;
        } else if (ip.startsWith("100.") || lowerName.includes("tailscale")) {
          // Tailscale WireGuard interface
          priority = 2;
        } else if (ip.startsWith("192.168.") || ip.startsWith("10.")) {
          priority = 3;
        }

        candidates.push({
          url: `http://${ip}:${port}`,
          priority,
        });
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  const urls = Array.from(new Set(candidates.map((c) => c.url)));
  const result = urls.length > 0 ? urls : [`http://localhost:${port}`];
  lanUrlCache = { at: now, port, urls: result };
  return result;
}


function unreadableResponse(
  client: string,
  skipped: UnreadableFile[],
  meta: LogMeta & { correlationId: string }
) {
  logEvent(
    "unreadable",
    client,
    `Sync file(s) exist but none could be read; refusing to merge or overwrite. ${describeSkipped(skipped)}`,
    meta
  );
  return errorResponse(
    507,
    "server_data_unreadable",
    "Server sync data is unreadable; refusing to overwrite it",
    meta.correlationId
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  const startedAt = Date.now();
  const denied = authFailureResponse(request, correlationId);
  if (denied) return denied;

  const current = readServerSyncFile();
  if (!current.payload) {
    return unreadableResponse(clientLabel(request), current.skipped, {
      correlationId,
      durationMs: Date.now() - startedAt,
    });
  }

  notePeerSeen(request);
  return NextResponse.json(
    {
      payload: current.payload,
      lanUrls: getLanUrls(3000),
      peers: peersForResponse(),
    },
    { headers: { "X-Hunt-Correlation-Id": correlationId } }
  );
}

export async function POST(request: Request) {
  const correlationId = requestCorrelationId(request);
  const startedAt = Date.now();
  const denied = authFailureResponse(request, correlationId);
  if (denied) return denied;

  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return errorResponse(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json",
      correlationId
    );
  }

  const client = clientLabel(request);
  try {
    const rawBody = await readBodyWithinLimit(request);
    if (rawBody === null) {
      return errorResponse(413, "payload_too_large", PAYLOAD_TOO_LARGE, correlationId);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return errorResponse(400, "malformed_json", "Malformed JSON payload", correlationId);
      }
      throw err;
    }

    const validation = validateSyncPayload(parsed);
    if (!validation.valid) {
      return errorResponse(400, "invalid_payload", validation.error, correlationId);
    }

    // Everything from here to the response is synchronous, so merges of
    // concurrent requests are serialized.
    const current = readServerSyncFile();
    if (!current.payload) {
      return unreadableResponse(client, current.skipped, {
        correlationId,
        durationMs: Date.now() - startedAt,
      });
    }

    const merged = mergeSyncPayloads(current.payload, validation.payload);

    // Never persist a merged state the server itself could not read back
    // (store exactly what a later read will return, e.g. newest 5000 tombstones).
    const mergedCheck = validateSyncPayload(merged);
    if (!mergedCheck.valid) {
      logEvent("merged_over_limit", client, mergedCheck.error, {
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return errorResponse(
        507,
        "merged_over_limit",
        `Merged data exceeds server limits: ${mergedCheck.error}`,
        correlationId
      );
    }
    const toStore = mergedCheck.payload;
    if (Buffer.byteLength(JSON.stringify(toStore), "utf8") > MAX_PAYLOAD_BYTES) {
      logEvent("merged_over_limit", client, "merged state exceeds the byte cap", {
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return errorResponse(
        507,
        "merged_over_limit",
        "Merged data exceeds server limits: size limit reached",
        correlationId
      );
    }

    // Idle syncs (nothing new) must not touch the disk: compare content,
    // ignoring the lastSyncedAt stamp and key order.
    const recovered = current.source === "backup" || current.source === "snapshot";
    if (recovered) {
      // The write below replaces the unreadable main file: keep its bytes and say why.
      const kept = mainFileExists() ? preserveCorruptMainFile() : null;
      logEvent(
        "recovered_from_backup",
        client,
        {
          source: current.source,
          skipped: describeSkipped(current.skipped),
          keptCorruptCopy: kept,
        },
        { correlationId, durationMs: Date.now() - startedAt }
      );
    }
    if (recovered || syncContentKey(toStore) !== syncContentKey(current.payload)) {
      const stored = writeServerSyncFileAtomic(toStore, {
        rotate: current.source === "main",
        report: (event, err) => logEvent(event, client, err, { correlationId }),
      });
      if (!stored) {
        return errorResponse(
          503,
          "save_failed",
          "Server could not save sync data",
          correlationId
        );
      }
    }

    notePeerSeen(request);
    return NextResponse.json(
      {
        payload: toStore,
        lanUrls: getLanUrls(3000),
        peers: peersForResponse(),
      },
      { headers: { "X-Hunt-Correlation-Id": correlationId } }
    );
  } catch (err) {
    logEvent("post_error", client, err, {
      correlationId,
      durationMs: Date.now() - startedAt,
    });
    return errorResponse(500, "internal", "Internal sync error", correlationId);
  }
}
