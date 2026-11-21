import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import {
  newCorrelationId,
  recordBreadcrumb,
  redactText,
  sanitizeCorrelationId,
} from "@/lib/diagnostics";
import {
  authorizeRequestWithSyncKey,
  getOrCreateServerSyncKey,
  isLocalhostPeerRequest,
  type SyncAuthResult,
} from "@/lib/serverSyncAuth";
import {
  createEmptySyncPayload,
  mergeSyncPayloads,
  syncContentKey,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";

export const dynamic = "force-dynamic";

// HUNT_DATA_DIR lets tests point the route at a throwaway directory.
const DATA_DIR = process.env.HUNT_DATA_DIR || path.join(process.cwd(), "data");
const SYNC_FILE = path.join(DATA_DIR, "hunt-sync.json");
const BACKUP_FILE = path.join(DATA_DIR, "hunt-sync.backup.json");
const TMP_FILE = path.join(DATA_DIR, "hunt-sync.tmp.json");
const KEY_FILE = path.join(DATA_DIR, "hunt-sync.key");
const SNAPSHOT_DIR = path.join(DATA_DIR, "backups");
const SNAPSHOT_RE = /^hunt-sync-\d{4}-\d{2}-\d{2}\.json$/;
const SNAPSHOTS_TO_KEEP = 14;

// Byte cap for a request body and for the merged state the server stores and
// returns (clients post their full state). It fits the count caps (20,000 time
// logs are ~7 MB); the 5000-task count cap in syncTypes.ts is the next binding limit.
const MAX_PAYLOAD_BYTES = 16_000_000;
const PAYLOAD_TOO_LARGE = "Payload exceeds the server size limit";
const LAN_URL_CACHE_MS = 30_000;

// ---------------------------------------------------------------------------
// Diagnostics (stable event names; never log tokens or payload content)
// ---------------------------------------------------------------------------

type SyncLogEvent =
  | "key_unavailable"
  | "unreadable"
  | "write_failed"
  | "backup_failed"
  | "snapshot_failed"
  | "merged_over_limit"
  | "post_error";

function logEvent(
  event: SyncLogEvent,
  client: string,
  detail?: unknown,
  meta?: { correlationId?: string; durationMs?: number }
): void {
  const safeDetail =
    detail instanceof Error
      ? { name: detail.name, message: redactText(detail.message) }
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
  const args: unknown[] = [`[hunt-sync] ${event}`, { client }];
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

function errorResponse(
  status: number,
  error: string,
  correlationId?: string
): NextResponse {
  return NextResponse.json(
    { error },
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

function authorize(request: Request): SyncAuthResult {
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
        logEvent("key_unavailable", client, err);
      }
    },
  });
  return authorizeRequestWithSyncKey(request, secret);
}

/** The 401/503 response for a request that may not use the API, else null. */
function authFailureResponse(request: Request): NextResponse | null {
  const auth = authorize(request);
  if (auth === "ok") return null;
  if (auth === "no_key") {
    return errorResponse(503, "Sync key unavailable on the server");
  }
  return errorResponse(401, "Unauthorized: Invalid or missing X-Hunt-Token");
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

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

type ServerRead =
  | { payload: SyncPayload; source: "main" | "backup" | "snapshot" | "empty" }
  | { payload: null; source: "unreadable" };

function readPayloadFile(filePath: string): SyncPayload | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const check = validateSyncPayload(JSON.parse(raw) as unknown);
    return check.valid && check.payload ? check.payload : null;
  } catch {
    return null;
  }
}

function listSnapshotsNewestFirst(): string[] {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return [];
    return fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((name) => SNAPSHOT_RE.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Reads the server's merged state: the main file, else the backup, else (only
 * when those exist but are unreadable) the newest daily snapshot. When no file
 * exists at all the server is fresh (empty). When files exist but none can be
 * read, returns `unreadable` so callers never overwrite them with a merge
 * against an empty base (that would drop everything but the posting client's data).
 */
function readServerSyncFile(): ServerRead {
  let sawFile = false;
  for (const [source, filePath] of [
    ["main", SYNC_FILE],
    ["backup", BACKUP_FILE],
  ] as const) {
    if (!fs.existsSync(filePath)) continue;
    sawFile = true;
    const payload = readPayloadFile(filePath);
    if (payload) return { payload, source };
  }
  if (!sawFile) return { payload: createEmptySyncPayload(), source: "empty" };

  for (const name of listSnapshotsNewestFirst()) {
    const payload = readPayloadFile(path.join(SNAPSHOT_DIR, name));
    if (payload) return { payload, source: "snapshot" };
  }
  return { payload: null, source: "unreadable" };
}

function localDateKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Before the main file is replaced: keep it as `hunt-sync.backup.json` (the
 * previous DISTINCT version, since we only write on change) and, on the first
 * change of each day, as `backups/hunt-sync-YYYY-MM-DD.json` (newest 14 kept).
 */
function rotateBackups(client: string): void {
  if (!fs.existsSync(SYNC_FILE)) return;
  try {
    fs.copyFileSync(SYNC_FILE, BACKUP_FILE);
  } catch (err) {
    logEvent("backup_failed", client, err);
  }
  try {
    const snapshot = path.join(SNAPSHOT_DIR, `hunt-sync-${localDateKey()}.json`);
    if (!fs.existsSync(snapshot)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      fs.copyFileSync(SYNC_FILE, snapshot);
      for (const old of listSnapshotsNewestFirst().slice(SNAPSHOTS_TO_KEEP)) {
        try {
          fs.unlinkSync(path.join(SNAPSHOT_DIR, old));
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    logEvent("snapshot_failed", client, err);
  }
}

/** Writes the main file via a temp file + rename; false when it was not stored. */
function writeServerSyncFileAtomic(
  payload: SyncPayload,
  options: { rotate: boolean; client: string }
): boolean {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Only a VALID main file is rotated into the backups; a corrupt main file
    // must not overwrite the good backup we just recovered from.
    if (options.rotate) rotateBackups(options.client);
    const serialized = JSON.stringify(payload, null, 2);
    fs.writeFileSync(TMP_FILE, serialized, "utf8");
    fs.renameSync(TMP_FILE, SYNC_FILE);
    return true;
  } catch (err) {
    logEvent("write_failed", options.client, err);
    try {
      fs.rmSync(TMP_FILE, { force: true });
    } catch {
      // Best effort: the next successful write replaces it.
    }
    return false;
  }
}

function unreadableResponse(
  client: string,
  meta?: { correlationId?: string; durationMs?: number }
) {
  logEvent(
    "unreadable",
    client,
    "Sync file(s) exist but none could be read; refusing to merge or overwrite. Check data/hunt-sync.json.",
    meta
  );
  return errorResponse(
    507,
    "Server sync data is unreadable; refusing to overwrite it",
    meta?.correlationId
  );
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const correlationId = requestCorrelationId(request);
  const startedAt = Date.now();
  const denied = authFailureResponse(request);
  if (denied) {
    denied.headers.set("X-Hunt-Correlation-Id", correlationId);
    return denied;
  }

  const current = readServerSyncFile();
  if (!current.payload) {
    return unreadableResponse(clientLabel(request), {
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
  const denied = authFailureResponse(request);
  if (denied) {
    denied.headers.set("X-Hunt-Correlation-Id", correlationId);
    return denied;
  }

  if (mediaType(request.headers.get("content-type")) !== "application/json") {
    return errorResponse(415, "Content-Type must be application/json", correlationId);
  }

  const client = clientLabel(request);
  try {
    const rawBody = await readBodyWithinLimit(request);
    if (rawBody === null) return errorResponse(413, PAYLOAD_TOO_LARGE, correlationId);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch (err) {
      if (err instanceof SyntaxError) {
        return errorResponse(400, "Malformed JSON payload", correlationId);
      }
      throw err;
    }

    const validation = validateSyncPayload(parsed);
    if (!validation.valid || !validation.payload) {
      return errorResponse(
        400,
        validation.error ?? "Invalid sync payload schema",
        correlationId
      );
    }

    // Everything from here to the response is synchronous, so merges of
    // concurrent requests are serialized.
    const current = readServerSyncFile();
    if (!current.payload) {
      return unreadableResponse(client, {
        correlationId,
        durationMs: Date.now() - startedAt,
      });
    }

    const merged = mergeSyncPayloads(current.payload, validation.payload);

    // Never persist a merged state the server itself could not read back
    // (store exactly what a later read will return, e.g. newest 5000 tombstones).
    const mergedCheck = validateSyncPayload(merged);
    if (!mergedCheck.valid || !mergedCheck.payload) {
      logEvent("merged_over_limit", client, mergedCheck.error, {
        correlationId,
        durationMs: Date.now() - startedAt,
      });
      return errorResponse(
        507,
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
        "Merged data exceeds server limits: size limit reached",
        correlationId
      );
    }

    // Idle syncs (nothing new) must not touch the disk: compare content,
    // ignoring the lastSyncedAt stamp and key order.
    const recovered = current.source === "backup" || current.source === "snapshot";
    if (recovered || syncContentKey(toStore) !== syncContentKey(current.payload)) {
      const stored = writeServerSyncFileAtomic(toStore, {
        rotate: current.source === "main",
        client,
      });
      if (!stored) {
        return errorResponse(503, "Server could not save sync data", correlationId);
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
    return errorResponse(500, "Internal sync error", correlationId);
  }
}
