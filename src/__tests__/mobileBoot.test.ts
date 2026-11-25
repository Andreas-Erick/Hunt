// @vitest-environment node
// Boot of the phone page over corrupt / hostile saved state: it must always paint, install its hooks,
// schedule sync after the first frame, and keep a quarantine copy of anything it had to drop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATE_KEY,
  jsonResponse,
  loadMobile,
  pageConsole,
  pageErrors,
  readState,
  type FetchStub,
  type MobileWindow,
} from "./helpers/loadMobile";

let w: MobileWindow | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function countingFetch() {
  const calls: string[] = [];
  const impl: FetchStub = (url) => {
    calls.push(url);
    return Promise.resolve(jsonResponse(401, ""));
  };
  return { calls, impl };
}

function quarantineKeys(win: MobileWindow): string[] {
  const keys: string[] = [];
  for (let i = 0; i < win.localStorage.length; i++) {
    const k = win.localStorage.key(i);
    if (k && k.startsWith("hunt-mobile-corrupt-")) keys.push(k);
  }
  return keys;
}

const longTitle = "L".repeat(10000);

interface BootCase {
  name: string;
  raw: string;
  dropsSomething: boolean;
}

const CASES: BootCase[] = [
  { name: "empty string", raw: "", dropsSomething: false },
  { name: "truncated JSON", raw: "{", dropsSomething: true },
  { name: "null", raw: "null", dropsSomething: true },
  { name: "array", raw: "[]", dropsSomething: true },
  { name: "number", raw: "5", dropsSomething: true },
  { name: "tasks: null", raw: JSON.stringify({ tasks: null }), dropsSomething: true },
  { name: "tasks: [null]", raw: JSON.stringify({ tasks: [null] }), dropsSomething: true },
  { name: "quests: [null]", raw: JSON.stringify({ quests: [null] }), dropsSomething: true },
  { name: "timeLogs: [null]", raw: JSON.stringify({ timeLogs: [null] }), dropsSomething: true },
  { name: "id-less task", raw: JSON.stringify({ tasks: [{}] }), dropsSomething: true },
  { name: "numeric task id", raw: JSON.stringify({ tasks: [{ id: 5, title: "x" }] }), dropsSomething: true },
  { name: "activeFocus: 'x'", raw: JSON.stringify({ activeFocus: "x" }), dropsSomething: true },
  {
    name: "__proto__ keys",
    raw: '{"__proto__":{"polluted":true},"tasks":[{"id":"tsk-1","title":"ok","status":"queued","rank":0,"__proto__":{"polluted":true}}]}',
    dropsSomething: false,
  },
  {
    name: "10k-character title",
    raw: JSON.stringify({ tasks: [{ id: "tsk-1", title: longTitle, status: "queued", rank: 0, questId: null }] }),
    dropsSomething: false,
  },
  {
    name: "log without a finite duration and a task with a bad scheduledDate",
    raw: JSON.stringify({
      tasks: [{ id: "tsk-1", title: "a", status: "queued", rank: 0, scheduledDate: "');alert(1);//" }],
      timeLogs: [{ id: "log-1-tsk-1", taskId: "tsk-1", durationSeconds: Infinity }],
    }),
    dropsSomething: true,
  },
];

describe("phone boot over corrupt saved state", () => {
  it.each(CASES)("$name: paints, schedules sync after the first frame, quarantines dropped data", async (c) => {
    const net = countingFetch();
    w = loadMobile({ rawState: c.raw, fetchImpl: net.impl });
    const main = w.document.getElementById("mainContainer");
    expect(pageErrors(w)).toEqual([]);
    expect(main?.innerHTML.trim().length).toBeGreaterThan(0);
    expect(main?.textContent).not.toContain("couldn't show");
    expect(net.calls).toHaveLength(0); // nothing before the first frame
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls.length).toBeGreaterThanOrEqual(1);
    expect(quarantineKeys(w).length > 0).toBe(c.dropsSomething);
    if (c.dropsSomething && c.raw) {
      expect(w.localStorage.getItem(quarantineKeys(w)[0])).toBe(c.raw);
      expect(pageConsole(w).some((e) => e.level === "warn" && String(e.args[0]) === "[hunt] state.load.quarantine")).toBe(true);
    }
    const s = readState(w);
    expect(s.tasks.every((t) => typeof t.id === "string" && typeof t.title === "string")).toBe(true);
    expect(s.activeFocus).toEqual(expect.objectContaining({ updatedAt: expect.any(Number) }));
    expect(w.eval("({}).polluted")).toBeUndefined();
    expect(pageErrors(w)).toEqual([]);
  });

  it("an unparseable copy with no fallback logs the empty-state fallback", () => {
    w = loadMobile({ rawState: "{" });
    const warnings = pageConsole(w).filter((e) => e.level === "warn").map((e) => String(e.args[0]));
    expect(warnings).toContain("[hunt] state.load.empty_fallback");
    expect(readState(w).tasks).toEqual([]);
  });

  it("a valid native copy wins over a corrupt local copy, and a corrupt native copy falls back to local", () => {
    const good = { tasks: [{ id: "tsk-native", title: "from native", status: "queued", rank: 0 }] };
    w = loadMobile({ rawState: "{", bridge: { loadState: () => JSON.stringify(good), saveState: () => undefined } });
    expect(readState(w).tasks.map((t) => t.id)).toEqual(["tsk-native"]);
    w.close();
    const local = { tasks: [{ id: "tsk-local", title: "from local", status: "queued", rank: 0 }] };
    w = loadMobile({ seedState: local, bridge: { loadState: () => "{", saveState: () => undefined } });
    expect(readState(w).tasks.map((t) => t.id)).toEqual(["tsk-local"]);
    expect(quarantineKeys(w)).toHaveLength(1);
  });

  it("the cleaned state replaces the corrupt copy on the next save", () => {
    w = loadMobile({ rawState: JSON.stringify({ tasks: [null, { id: "tsk-1", title: "kept", status: "queued", rank: 0 }] }) });
    w.persistState();
    const saved = JSON.parse(w.localStorage.getItem(STATE_KEY) ?? "null") as { tasks: { id: string }[] };
    expect(saved.tasks.map((t) => t.id)).toEqual(["tsk-1"]);
  });

  it("an unusable copy goes to a native file when the shell offers one, and the user is told", () => {
    const kept: string[] = [];
    w = loadMobile({
      rawState: "{",
      bridge: { loadState: () => "", saveState: () => undefined, saveCorruptState: (raw) => (kept.push(raw), true) },
    });
    expect(kept).toEqual(["{"]);
    expect(quarantineKeys(w)).toEqual([]); // localStorage is not used when the file write succeeded
    const sheet = w.document.getElementById("sheetContainer");
    expect(sheet?.dataset.sheet).toBe("loadRecovery");
    expect(sheet?.textContent).toContain("Saved data couldn't be loaded");
    expect(sheet?.textContent).not.toContain("Save over it"); // a copy exists, so saving is not blocked
    expect(w.persistState(JSON.stringify({ tasks: [] }))).toBe(true);
  });

  it("when no copy of an unusable state can be kept, nothing overwrites it until the user chooses", () => {
    w = loadMobile({
      rawState: "{",
      beforeBoot(win) {
        const proto = Object.getPrototypeOf(win.localStorage) as Storage;
        const realSet = proto.setItem;
        proto.setItem = function (this: Storage, key: string, value: string) {
          if (key.startsWith("hunt-mobile-corrupt-")) throw new win.DOMException("full", "QuotaExceededError");
          return realSet.call(this, key, value);
        };
      },
    });
    expect(pageErrors(w)).toEqual([]);
    expect(pageConsole(w).some((e) => e.level === "error" && String(e.args[0]) === "[hunt] state.quarantine_failed")).toBe(true);
    // boot (habit materialization) and later saves leave the original bytes alone
    expect(w.localStorage.getItem(STATE_KEY)).toBe("{");
    expect(w.persistState(JSON.stringify({ tasks: [] }))).toBe(false);
    expect(w.localStorage.getItem(STATE_KEY)).toBe("{");

    const sheet = w.document.getElementById("sheetContainer");
    expect(sheet?.dataset.sheet).toBe("loadRecovery");
    expect(sheet?.textContent).toContain("Nothing will be written over it");
    expect(sheet?.textContent).toContain("Save over it");

    w.allowSavingAfterLoadFailure();
    expect(JSON.parse(w.localStorage.getItem(STATE_KEY) ?? "null")).toEqual(expect.objectContaining({ tasks: [] }));
  });

  it("a readable state never shows the recovery sheet", () => {
    w = loadMobile({ seedState: { tasks: [{ id: "tsk-1", title: "ok", status: "queued", rank: 0 }] } });
    expect(w.document.getElementById("sheetContainer")?.dataset.sheet).not.toBe("loadRecovery");
  });

  it("a screen that throws while drawing still lets boot finish: message, hooks and sync", async () => {
    const net = countingFetch();
    w = loadMobile({
      fetchImpl: net.impl,
      beforeBoot(win) {
        win.Date.prototype.toLocaleDateString = () => {
          throw new Error("render boom");
        };
      },
    });
    const main = w.document.getElementById("mainContainer");
    expect(main?.textContent).toContain("Hunt couldn't show this screen");
    expect(pageConsole(w).some((e) => e.level === "error" && String(e.args[0]) === "[hunt] boot.render_failed")).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls.length).toBeGreaterThanOrEqual(1); // afterFirstPaint(scheduleSync) still ran
    const before = net.calls.length;
    w.dispatchEvent(new w.Event("online")); // lifecycle hooks were installed
    await vi.advanceTimersByTimeAsync(50);
    expect(net.calls.length).toBeGreaterThan(before);
    expect(pageErrors(w)).toEqual([]);
  });
});

describe("a save the browser's storage refuses (quota full)", () => {
  function bootWithStorage(bridge?: MobileWindow["AndroidBridge"]) {
    const ctl = { full: false, stateWrites: 0 };
    w = loadMobile({
      seedState: { tasks: [] },
      ...(bridge ? { bridge } : {}),
      beforeBoot(win) {
        const proto = Object.getPrototypeOf(win.localStorage) as Storage;
        const realSet = proto.setItem;
        proto.setItem = function (this: Storage, key: string, value: string) {
          if (key === STATE_KEY) {
            ctl.stateWrites++;
            if (ctl.full) throw new win.DOMException("full", "QuotaExceededError");
          }
          return realSet.call(this, key, value);
        };
      },
    });
    return ctl;
  }
  const toastText = () => w!.document.getElementById("toastHost")?.textContent ?? "";

  it("in a browser, warns once, and retries the same state until it is saved", () => {
    const ctl = bootWithStorage();
    ctl.full = true;
    const next = JSON.stringify({ tasks: [{ id: "tsk-1", title: "kept", status: "queued", rank: 0 }] });

    expect(w!.persistState(next)).toBe(false);
    expect(toastText()).toContain("Storage is full");
    const writes = ctl.stateWrites;
    expect(w!.persistState(next)).toBe(false); // unchanged text is retried, not skipped as already saved
    expect(ctl.stateWrites).toBe(writes + 1);
    expect(toastText().match(/Storage is full/g)).toHaveLength(1);

    ctl.full = false;
    expect(w!.persistState(next)).toBe(true);
    expect(w!.localStorage.getItem(STATE_KEY)).toBe(next);
  });

  it("in the APK, the shell's file is the store, so a full localStorage is not reported", () => {
    const saved: string[] = [];
    const ctl = bootWithStorage({ saveState: (json: string) => void saved.push(json) } as MobileWindow["AndroidBridge"]);
    ctl.full = true;
    const next = JSON.stringify({ tasks: [] , quests: [] });
    expect(w!.persistState(next)).toBe(true);
    expect(saved.at(-1)).toBe(next);
    expect(toastText()).not.toContain("Storage is full");
  });
});
