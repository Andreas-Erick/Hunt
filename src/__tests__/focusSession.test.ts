import { describe, expect, it } from "vitest";
import type { FocusSession, TimeLog } from "@/lib/domainTypes";
import { nextFocusStamp, transitionFocus } from "@/lib/focusSession";

const idle: FocusSession = { status: "idle", updatedAt: 100 };
const running: FocusSession = { status: "running", taskId: "a", sessionStartedAt: 1_000, updatedAt: 100 };
const paused: FocusSession = { status: "paused", taskId: "a", updatedAt: 100 };
const NOW = 61_000;

describe("transitionFocus", () => {
  it("start from idle marks the task active and runs from now", () => {
    expect(transitionFocus(idle, { type: "start", taskId: "b" }, NOW)).toEqual({
      session: { status: "running", taskId: "b", sessionStartedAt: NOW, updatedAt: NOW },
      effects: [{ kind: "markActive", taskId: "b" }],
    });
  });

  it("start on another task flushes the running burst and requeues the old task first", () => {
    const t = transitionFocus(running, { type: "start", taskId: "b" }, NOW);
    expect(t.effects).toEqual([
      { kind: "flush", taskId: "a", sessionStartedAt: 1_000 },
      { kind: "requeueIfActive", taskId: "a" },
      { kind: "markActive", taskId: "b" },
    ]);
  });

  it("start on the task already running keeps the very same session", () => {
    const t = transitionFocus(running, { type: "start", taskId: "a" }, NOW);
    expect(t.session).toBe(running);
    expect(t.effects).toEqual([]);
  });

  it("start on the paused task resumes it without a requeue", () => {
    const t = transitionFocus(paused, { type: "start", taskId: "a" }, NOW);
    expect(t.effects).toEqual([{ kind: "markActive", taskId: "a" }]);
    expect(t.session).toMatchObject({ status: "running", sessionStartedAt: NOW });
  });

  it("pause flushes; resume starts a fresh burst; both ignore the wrong state", () => {
    const p = transitionFocus(running, { type: "pause" }, NOW);
    expect(p.session).toEqual({ status: "paused", taskId: "a", updatedAt: NOW });
    expect(p.effects).toEqual([{ kind: "flush", taskId: "a", sessionStartedAt: 1_000 }]);
    expect(transitionFocus(idle, { type: "pause" }, NOW).session).toBe(idle);
    expect(transitionFocus(running, { type: "resume" }, NOW).session).toBe(running);
    expect(transitionFocus(paused, { type: "resume" }, NOW)).toEqual({
      session: { status: "running", taskId: "a", sessionStartedAt: NOW, updatedAt: NOW },
      effects: [],
    });
  });

  it("stop returns the task to the queue; clear goes idle with no writes", () => {
    expect(transitionFocus(running, { type: "stop" }, NOW).effects).toEqual([
      { kind: "flush", taskId: "a", sessionStartedAt: 1_000 },
      { kind: "markQueued", taskId: "a" },
    ]);
    expect(transitionFocus(paused, { type: "clear" }, NOW)).toEqual({
      session: { status: "idle", updatedAt: NOW },
      effects: [],
    });
  });

  it("leave flushes and requeues, and does nothing when idle", () => {
    expect(transitionFocus(running, { type: "leave" }, NOW).effects).toEqual([
      { kind: "flush", taskId: "a", sessionStartedAt: 1_000 },
      { kind: "requeueIfActive", taskId: "a" },
    ]);
    expect(transitionFocus(idle, { type: "leave" }, NOW).session).toBe(idle);
  });

  it("stamps are never older than the focus they replace (R6)", () => {
    const ahead: FocusSession = { ...running, updatedAt: NOW + 5_000 };
    expect(transitionFocus(ahead, { type: "pause" }, NOW).session.updatedAt).toBe(NOW + 5_001);
    expect(nextFocusStamp({ updatedAt: 0 }, NOW)).toBe(NOW);
  });

  describe("remote (a newer focus won the merge)", () => {
    const remoteOther = { activeTaskId: "b", isRunning: true, sessionStartedAt: 31_000, updatedAt: 200 };

    it("logs the losing local burst with its R4 end and requeues the task", () => {
      const t = transitionFocus(running, { type: "remote", remote: remoteOther, timeLogs: [] }, NOW);
      expect(t.effects).toEqual([
        { kind: "flush", taskId: "a", sessionStartedAt: 1_000, endAt: 31_000 },
        { kind: "requeueIfActive", taskId: "a" },
      ]);
      expect(t.session).toEqual({ status: "running", taskId: "b", sessionStartedAt: 31_000, updatedAt: 200 });
    });

    it("ends the burst at a later log start when that comes first", () => {
      const log = { id: "l", taskId: "c", startTime: 11_000 } as TimeLog;
      const t = transitionFocus(running, { type: "remote", remote: remoteOther, timeLogs: [log] }, NOW);
      expect(t.effects[0]).toMatchObject({ endAt: 11_000 });
    });

    it("adopts a newer copy of the same session without writes", () => {
      const same = { activeTaskId: "a", isRunning: true, sessionStartedAt: 1_000, updatedAt: 300 };
      const t = transitionFocus(running, { type: "remote", remote: same, timeLogs: [] }, NOW);
      expect(t.effects).toEqual([]);
      expect(t.session.updatedAt).toBe(300);
    });

    it("keeps the task active when the other device focuses the same task", () => {
      const sameTask = { activeTaskId: "a", isRunning: true, sessionStartedAt: 41_000, updatedAt: 300 };
      const t = transitionFocus(running, { type: "remote", remote: sameTask, timeLogs: [] }, NOW);
      expect(t.effects.map((e) => e.kind)).toEqual(["flush"]);
    });

    it("ignores an older or equal remote focus", () => {
      const stale = { ...remoteOther, updatedAt: 100 };
      expect(transitionFocus(running, { type: "remote", remote: stale, timeLogs: [] }, NOW).session).toBe(running);
    });
  });
});
