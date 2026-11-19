// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BREADCRUMBS,
  clearBreadcrumbs,
  getBreadcrumbs,
  getLastCrashReport,
  getLogLevel,
  installGlobalFaultTraps,
  logDiagnostic,
  newCorrelationId,
  recordBreadcrumb,
  redactLogContext,
  redactText,
  sanitizeCorrelationId,
  setLogLevel,
  summarizeError,
} from "@/lib/diagnostics";

describe("diagnostics & root-cause observability (Spec 2.16)", () => {
  const originalLevel = getLogLevel();

  beforeEach(() => {
    clearBreadcrumbs();
    setLogLevel("INFO");
  });

  afterEach(() => {
    clearBreadcrumbs();
    setLogLevel(originalLevel);
    vi.restoreAllMocks();
  });

  it("produces unique correlation IDs and sanitizes inbound headers", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a).not.toBe(b);

    expect(sanitizeCorrelationId("req-1234-abc")).toBe("req-1234-abc");
    expect(sanitizeCorrelationId("  bad/header\r\n<script>  ")).toBe("badheaderscript");
    expect(sanitizeCorrelationId("ab")).toBeNull();
    expect(sanitizeCorrelationId(null)).toBeNull();
  });

  it("redacts sensitive keys, bearer tokens, 64-hex keys, circular references, and deep nesting", () => {
    const hexKey = "a".repeat(64);
    expect(redactText(`Authorization: Bearer supersecret123456 key=${hexKey}`)).toBe(
      "Authorization: Bearer [REDACTED] key=[REDACTED]"
    );

    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;

    const redacted = redactLogContext({
      token: "my-secret",
      "X-Hunt-Token": hexKey,
      authorization: "Bearer xyz12345678",
      nested: { password: "hunter2", note: `leaked ${hexKey}` },
      cyclic,
      deep: { a: { b: { c: { d: { e: "too-deep" } } } } },
    });

    expect(redacted?.token).toBe("[REDACTED]");
    expect(redacted?.["X-Hunt-Token"]).toBe("[REDACTED]");
    expect(redacted?.authorization).toBe("[REDACTED]");
    expect((redacted?.nested as Record<string, unknown>).password).toBe("[REDACTED]");
    expect((redacted?.nested as Record<string, unknown>).note).toBe("leaked [REDACTED]");
    expect((redacted?.cyclic as Record<string, unknown>).self).toBe("[Circular]");
  });

  it("maintains a bounded circular breadcrumb ring buffer of MAX_BREADCRUMBS", () => {
    for (let i = 0; i < MAX_BREADCRUMBS + 45; i += 1) {
      recordBreadcrumb({
        level: "DEBUG",
        domain: "test",
        event: `evt_${i}`,
        correlationId: `cid-${i}`,
        durationMs: i,
      });
    }
    const trail = getBreadcrumbs();
    expect(trail).toHaveLength(MAX_BREADCRUMBS);
    expect(trail[0].event).toBe("evt_45");
    expect(trail[trail.length - 1].event).toBe(`evt_${MAX_BREADCRUMBS + 44}`);
    expect(trail[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("gates console emission by log level while always recording breadcrumbs", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setLogLevel("ERROR");
    logDiagnostic({ level: "INFO", domain: "sync", event: "sync_ok", durationMs: 12 });
    expect(infoSpy).not.toHaveBeenCalled();
    expect(getBreadcrumbs()).toHaveLength(1);

    logDiagnostic({
      level: "ERROR",
      domain: "sync",
      event: "sync_fail",
      context: { token: "never-log-me" },
    });
    expect(errSpy).toHaveBeenCalledTimes(1);
    const emitted = errSpy.mock.calls[0][1] as { context?: Record<string, unknown> };
    expect(emitted.context?.token).toBe("[REDACTED]");
  });

  it("captures global error & unhandledrejection faults with breadcrumbs and disposes cleanly", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listeners = new Map<string, Set<EventListener>>();
    const fakeTarget = {
      addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        if (typeof fn !== "function") return;
        const set = listeners.get(type) ?? new Set<EventListener>();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
        if (typeof fn !== "function") return;
        listeners.get(type)?.delete(fn);
      },
    };

    const dispose = installGlobalFaultTraps(fakeTarget as unknown as Window);
    recordBreadcrumb({ level: "INFO", domain: "ui", event: "clicked_start" });

    const errorListeners = Array.from(listeners.get("error") ?? []);
    expect(errorListeners).toHaveLength(1);
    errorListeners[0]({
      error: new Error("Boom with Bearer secretTokenValue99"),
    } as unknown as Event);

    const crash = getLastCrashReport();
    expect(crash?.kind).toBe("error");
    expect(crash?.message).toBe("Boom with Bearer [REDACTED]");
    expect(crash?.breadcrumbs.some((b) => b.event === "clicked_start")).toBe(true);

    dispose();
    expect(listeners.get("error")?.size).toBe(0);
    expect(listeners.get("unhandledrejection")?.size).toBe(0);
  });

  it("summarizes errors with cause chains safely", () => {
    const err = new Error("Outer failure");
    (err as Error & { cause?: unknown }).cause = new Error("Inner " + "f".repeat(64));
    const summary = summarizeError(err);
    expect(summary.name).toBe("Error");
    expect(summary.message).toBe("Outer failure");
    expect(summary.cause).toBe("Error: Inner [REDACTED]");
  });
});
