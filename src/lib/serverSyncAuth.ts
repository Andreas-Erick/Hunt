import crypto from "crypto";
import fs from "fs";
import path from "path";

export type SyncAuthResult = "ok" | "unauthorized" | "no_key";

export function resolveSyncDataPaths(explicitDataDir?: string): {
  dataDir: string;
  keyFile: string;
} {
  const dataDir =
    explicitDataDir ?? process.env.HUNT_DATA_DIR ?? path.join(process.cwd(), "data");
  return {
    dataDir,
    keyFile: path.join(dataDir, "hunt-sync.key"),
  };
}

/**
 * Reads the shared sync key from `<dataDir>/hunt-sync.key` (creating a 256-bit
 * random hex key on first use), or returns null when it cannot be read or
 * created so callers fail closed (HTTP 503).
 */
export function getOrCreateServerSyncKey(options?: {
  dataDir?: string;
  keyFile?: string;
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}): string | null {
  const resolved = resolveSyncDataPaths(options?.dataDir);
  const dataDir = options?.dataDir ?? resolved.dataDir;
  const keyFile = options?.keyFile ?? resolved.keyFile;

  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    let key: string | null = null;
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing.length >= 32) key = existing;
    }
    if (!key) {
      key = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(keyFile, key, "utf8");
    }
    options?.onSuccess?.();
    return key;
  } catch (err) {
    options?.onError?.(err);
    return null;
  }
}

/** Constant-time verification of the `X-Hunt-Token` request header against `secret`. */
export function authorizeRequestWithSyncKey(
  request: Request,
  secret: string | null
): SyncAuthResult {
  if (!secret) return "no_key";

  const candidate = (request.headers.get("x-hunt-token") ?? "").trim();
  if (!candidate || candidate.length !== secret.length) {
    return "unauthorized";
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(candidate, "utf8"),
      Buffer.from(secret, "utf8")
    )
      ? "ok"
      : "unauthorized";
  } catch {
    return "unauthorized";
  }
}

export function isLocalhostHostHeader(host: string): boolean {
  const lower = host.trim().toLowerCase();
  return (
    lower === "localhost" ||
    lower.startsWith("localhost:") ||
    lower === "127.0.0.1" ||
    lower.startsWith("127.0.0.1:")
  );
}

/**
 * Whether `Host` and `X-Forwarded-For` indicate this machine.
 * Never used to bypass `X-Hunt-Token` authentication.
 */
export function isLocalhostPeerRequest(request: Request): boolean {
  const host = request.headers.get("host") ?? "";
  if (!isLocalhostHostHeader(host)) return false;

  const forwarded = (request.headers.get("x-forwarded-for") ?? "").trim();
  if (forwarded && forwarded !== "127.0.0.1" && forwarded !== "::1") {
    return false;
  }
  return true;
}

/**
 * Stricter localhost check for desktop window control API: also verifies `Origin`
 * when present so cross-origin browser tabs cannot invoke native window actions.
 */
export function isLocalDesktopOriginRequest(request: Request): boolean {
  if (!isLocalhostPeerRequest(request)) return false;

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
