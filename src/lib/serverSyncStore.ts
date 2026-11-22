import fs from "fs";
import path from "path";
import { toLocalDateKey } from "./dateUtils";
import { createEmptySyncPayload, validateSyncPayload, type SyncPayload } from "./syncTypes";

/**
 * The sync server's files: hunt-sync.json (main), its backup, 14 daily
 * snapshots, and kept copies of unreadable files. Reads fall back main ->
 * backup -> snapshots; writes are atomic (temp file + fsync + rename). The HTTP
 * route (src/app/api/sync/route.ts) owns auth, merging and logging.
 */

// HUNT_DATA_DIR lets tests point the server at a throwaway directory.
export const DATA_DIR = process.env.HUNT_DATA_DIR || path.join(process.cwd(), "data");
const SYNC_FILE = path.join(DATA_DIR, "hunt-sync.json");
const BACKUP_FILE = path.join(DATA_DIR, "hunt-sync.backup.json");
const TMP_FILE = path.join(DATA_DIR, "hunt-sync.tmp.json");
const SNAPSHOT_DIR = path.join(DATA_DIR, "backups");
const SNAPSHOT_RE = /^hunt-sync-\d{4}-\d{2}-\d{2}\.json$/;
const SNAPSHOTS_TO_KEEP = 14;

/** A storage step that failed without failing the request; the route logs it. */
export type StoreFailure = "backup_failed" | "snapshot_failed" | "write_failed";
export type ReportStoreFailure = (event: StoreFailure, error: unknown) => void;

/** True when hunt-sync.json exists (readable or not). */
export function mainFileExists(): boolean {
  return fs.existsSync(SYNC_FILE);
}

/** A sync file that exists but could not be used, and why (never its content). */
export interface UnreadableFile {
  file: string;
  reason: string;
}

export type ServerRead =
  | {
      payload: SyncPayload;
      source: "main" | "backup" | "snapshot" | "empty";
      /** Files skipped before `source` was reached (empty when main was read). */
      skipped: UnreadableFile[];
    }
  | { payload: null; source: "unreadable"; skipped: UnreadableFile[] };

type PayloadFileRead = { payload: SyncPayload } | { payload: null; reason: string };

function readPayloadFile(filePath: string): PayloadFileRead {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { payload: null, reason: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { payload: null, reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const check = validateSyncPayload(parsed);
  return check.valid ? { payload: check.payload } : { payload: null, reason: `invalid payload: ${check.error}` };
}

export function describeSkipped(skipped: UnreadableFile[]): string {
  return skipped.map((s) => `${s.file} (${s.reason})`).join("; ");
}

/**
 * Copies an unreadable main file to `hunt-sync.corrupt-<ms>.json` before a recovery
 * write replaces it, so the bytes stay available for manual repair. Returns the
 * copy's file name, or null when it could not be kept.
 */
export function preserveCorruptMainFile(): string | null {
  try {
    const name = `hunt-sync.corrupt-${Date.now()}.json`;
    fs.copyFileSync(SYNC_FILE, path.join(DATA_DIR, name));
    return name;
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
export function readServerSyncFile(): ServerRead {
  const skipped: UnreadableFile[] = [];
  let sawFile = false;
  for (const [source, filePath] of [
    ["main", SYNC_FILE],
    ["backup", BACKUP_FILE],
  ] as const) {
    if (!fs.existsSync(filePath)) continue;
    sawFile = true;
    const read = readPayloadFile(filePath);
    if (read.payload) return { payload: read.payload, source, skipped };
    skipped.push({ file: path.basename(filePath), reason: read.reason });
  }
  if (!sawFile) return { payload: createEmptySyncPayload(), source: "empty", skipped };

  for (const name of listSnapshotsNewestFirst()) {
    const read = readPayloadFile(path.join(SNAPSHOT_DIR, name));
    if (read.payload) return { payload: read.payload, source: "snapshot", skipped };
    skipped.push({ file: `backups/${name}`, reason: read.reason });
  }
  return { payload: null, source: "unreadable", skipped };
}

/**
 * Before the main file is replaced: keep it as `hunt-sync.backup.json` (the
 * previous DISTINCT version, since we only write on change) and, on the first
 * change of each day, as `backups/hunt-sync-YYYY-MM-DD.json` (newest 14 kept).
 */
function rotateBackups(report: ReportStoreFailure): void {
  if (!fs.existsSync(SYNC_FILE)) return;
  try {
    fs.copyFileSync(SYNC_FILE, BACKUP_FILE);
  } catch (err) {
    report("backup_failed", err);
  }
  try {
    const snapshot = path.join(SNAPSHOT_DIR, `hunt-sync-${toLocalDateKey()}.json`);
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
    report("snapshot_failed", err);
  }
}

/**
 * Writes the main file via a temp file that is flushed to disk (fsync) before
 * the rename, so a power cut cannot leave a truncated hunt-sync.json behind;
 * false when it was not stored.
 */
export function writeServerSyncFileAtomic(
  payload: SyncPayload,
  options: { rotate: boolean; report: ReportStoreFailure }
): boolean {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    // Only a VALID main file is rotated into the backups; a corrupt main file
    // must not overwrite the good backup we just recovered from.
    if (options.rotate) rotateBackups(options.report);
    const serialized = JSON.stringify(payload, null, 2);
    const fd = fs.openSync(TMP_FILE, "w");
    try {
      fs.writeFileSync(fd, serialized, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(TMP_FILE, SYNC_FILE);
    return true;
  } catch (err) {
    options.report("write_failed", err);
    try {
      fs.rmSync(TMP_FILE, { force: true });
    } catch {
      // Best effort: the next successful write replaces it.
    }
    return false;
  }
}
