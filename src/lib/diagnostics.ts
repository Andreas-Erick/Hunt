/**
 * Structured diagnostics, correlation IDs, secret redaction, bounded breadcrumb
 * flight recorder, and global unhandled-fault traps (Spec Section 2.16).
 *
 * Pure TypeScript with zero external dependencies. Never called in 60fps loops.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const LEVEL_RANK: Record<LogLevel, number> = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  FATAL: 50,
};

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  domain: string;
  event: string;
  correlationId?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}

export interface CrashReport {
  timestamp: string;
  kind: "error" | "unhandledrejection";
  message: string;
  name?: string;
  stack?: string;
  cause?: string;
  breadcrumbs: LogRecord[];
}

export const MAX_BREADCRUMBS = 150;
const MAX_REDACT_DEPTH = 4;
const MAX_STRING_LEN = 300;
const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /(token|secret|password|passwd|authorization|auth|cookie|apikey|api_key|synckey|sync_key|credential|private.?key)/i;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const HEX_SECRET_RE = /\b[0-9a-fA-F]{64}\b/g;

function parseLogLevel(raw: unknown): LogLevel | null {
  if (typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  if (upper in LEVEL_RANK) return upper as LogLevel;
  return null;
}

function defaultLogLevel(): LogLevel {
  const envLevel =
    typeof process !== "undefined" && process.env
      ? parseLogLevel(process.env.NEXT_PUBLIC_LOG_LEVEL ?? process.env.LOG_LEVEL)
      : null;
  if (envLevel) return envLevel;
  if (typeof process !== "undefined" && process.env?.NODE_ENV === "test") {
    return "WARN";
  }
  return "INFO";
}

let activeLogLevel: LogLevel = defaultLogLevel();
let breadcrumbs: LogRecord[] = [];
let lastCrashReport: CrashReport | null = null;

export function getLogLevel(): LogLevel {
  return activeLogLevel;
}

export function setLogLevel(level: LogLevel): void {
  activeLogLevel = level;
}

/** Generates a compact correlation ID (uses native crypto.randomUUID when available). */
export function newCorrelationId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fallback below.
  }
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sanitizes an inbound correlation header (safe ASCII, bounded length). */
export function sanitizeCorrelationId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const clean = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  return clean.length >= 4 ? clean : null;
}

/** Redacts bearer tokens and 64-hex keys from freeform strings. */
export function redactText(input: string): string {
  return input
    .replace(BEARER_RE, "Bearer " + REDACTED)
    .replace(HEX_SECRET_RE, REDACTED)
    .slice(0, MAX_STRING_LEN);
}

/** Extracts safe diagnostic fields from an unknown thrown value. */
export function summarizeError(err: unknown): {
  name?: string;
  message: string;
  stack?: string;
  cause?: string;
} {
  if (err instanceof Error) {
    const withCause = err as Error & { cause?: unknown };
    return {
      name: err.name || "Error",
      message: redactText(err.message || "Unknown error"),
      stack: typeof err.stack === "string" ? redactText(err.stack) : undefined,
      cause:
        withCause.cause !== undefined
          ? redactText(
              withCause.cause instanceof Error
                ? `${withCause.cause.name}: ${withCause.cause.message}`
                : String(withCause.cause)
            )
          : undefined,
    };
  }
  if (typeof err === "string") {
    return { message: redactText(err) };
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const msg = typeof rec.message === "string" ? rec.message : "Unknown error";
    return {
      name: typeof rec.name === "string" ? rec.name : undefined,
      message: redactText(msg),
    };
  }
  return { message: redactText(String(err)) };
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (value instanceof Error) return summarizeError(value);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_REDACT_DEPTH) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(v, depth + 1, seen);
    }
  }
  return out;
}

/** Recursively redacts sensitive keys and token-shaped strings from log context. */
export function redactLogContext(
  context?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const seen = new WeakSet<object>();
  return redactValue(context, 0, seen) as Record<string, unknown>;
}

/** Appends a structured event to the bounded circular breadcrumb flight recorder. */
export function recordBreadcrumb(entry: {
  level: LogLevel;
  domain: string;
  event: string;
  correlationId?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}): LogRecord {
  const record: LogRecord = {
    timestamp: new Date().toISOString(),
    level: entry.level,
    domain: entry.domain,
    event: entry.event,
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
      ? { durationMs: Math.max(0, Math.round(entry.durationMs)) }
      : {}),
    ...(entry.context ? { context: redactLogContext(entry.context) } : {}),
  };
  breadcrumbs.push(record);
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.splice(0, breadcrumbs.length - MAX_BREADCRUMBS);
  }
  return record;
}

/** Returns a shallow copy of the current breadcrumb trail (oldest -> newest). */
export function getBreadcrumbs(): LogRecord[] {
  return breadcrumbs.slice();
}

export function clearBreadcrumbs(): void {
  breadcrumbs = [];
  lastCrashReport = null;
}

export function getLastCrashReport(): CrashReport | null {
  return lastCrashReport;
}

/**
 * Records a structured diagnostic event into the breadcrumb ring buffer and
 * emits it to the console when its level meets the active threshold.
 * Set `emitConsole: false` when the caller already emits a legacy console tag
 * asserted by existing contracts.
 */
export function logDiagnostic(
  entry: {
    level: LogLevel;
    domain: string;
    event: string;
    correlationId?: string;
    durationMs?: number;
    context?: Record<string, unknown>;
  },
  options: { emitConsole?: boolean } = {}
): LogRecord {
  const record = recordBreadcrumb(entry);
  if (options.emitConsole === false) return record;
  if (LEVEL_RANK[record.level] < LEVEL_RANK[activeLogLevel]) return record;

  if (record.level === "ERROR" || record.level === "FATAL") {
    console.error(`[hunt:${record.domain}] ${record.event}`, record);
  } else if (record.level === "WARN") {
    console.warn(`[hunt:${record.domain}] ${record.event}`, record);
  } else {
    console.info(`[hunt:${record.domain}] ${record.event}`, record);
  }
  return record;
}

/**
 * Installs global unhandled error and promise-rejection listeners on `window`
 * and returns a deterministic cleanup callback. Captures a structured crash
 * report with the bounded breadcrumb trail attached.
 */
export function installGlobalFaultTraps(
  target: Pick<Window, "addEventListener" | "removeEventListener"> | null =
    typeof window !== "undefined" ? window : null
): () => void {
  if (!target) return () => {};

  const onError = (event: Event) => {
    const errEvent = event as ErrorEvent;
    const summary = summarizeError(errEvent.error ?? errEvent.message ?? "Unhandled error");
    const trail = getBreadcrumbs();
    lastCrashReport = {
      timestamp: new Date().toISOString(),
      kind: "error",
      ...summary,
      breadcrumbs: trail,
    };
    logDiagnostic({
      level: "FATAL",
      domain: "runtime",
      event: "unhandled_error",
      context: {
        name: summary.name,
        message: summary.message,
        breadcrumbCount: trail.length,
      },
    });
  };

  const onRejection = (event: Event) => {
    const rejEvent = event as PromiseRejectionEvent;
    const summary = summarizeError(rejEvent.reason);
    const trail = getBreadcrumbs();
    lastCrashReport = {
      timestamp: new Date().toISOString(),
      kind: "unhandledrejection",
      ...summary,
      breadcrumbs: trail,
    };
    logDiagnostic({
      level: "ERROR",
      domain: "runtime",
      event: "unhandled_rejection",
      context: {
        name: summary.name,
        message: summary.message,
        cause: summary.cause,
        breadcrumbCount: trail.length,
      },
    });
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
