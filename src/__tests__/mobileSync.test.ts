// @vitest-environment node
// Phone page sync behaviour: retry policy (deterministic failures pause), advertised-route filtering,
// merge failures, pairing without a hardcoded key, R6 stamps on every local write, DST-safe days.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySyncPayload, mergeSyncPayloads, validateSyncPayload, type SyncPayload } from "@/lib/syncTypes";
import {
  SYNC_META_KEY,
  TOKEN_KEY,
  click,
  fakePairingKey,
  jsonResponse,
  loadMobile,
  pageConsole,
  pageErrors,
  readState,
  type AndroidBridgeStub,
  type FakeResponse,
  type FetchInit,
  type FocusShape,
  type MobileWindow,
  type PageRow,
} from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const MINUTE = 60_000;
const KEY = fakePairingKey(11);

let w: MobileWindow | null = null;
function page(): MobileWindow {
  if (!w) throw new Error("page not loaded");
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(respond: (call: Call) => FakeResponse | Promise<FakeResponse>) {
  const calls: Call[] = [];
  const impl = (url: string, init?: FetchInit) => {
    const call = { url, headers: { ...(init?.headers ?? {}) }, body: init?.body ?? "" };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, impl };
}

function emptyPayload() {
  const activeFocus: FocusShape = { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 };
  return {
    quests: [],
    tasks: [],
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus,
    lastSyncedAt: 0,
  };
}

function okBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ payload: emptyPayload(), ...extra });
}

const oneTask = {
  ...emptyPayload(),
  tasks: [{ id: "tsk-1", title: "Write", status: "queued", rank: 0, questId: null, updatedAt: NOW - MINUTE }],
};

function task(s: ReturnType<typeof readState>, id: string): PageRow {
  const t = s.tasks.find((x) => x.id === id);
  if (!t) throw new Error("missing task " + id);
  return t;
}

function stampOf(row: PageRow | { updatedAt: number }): number {
  return Number(row.updatedAt);
}

describe("retry policy", () => {
  const DETERMINISTIC: [string, () => FakeResponse][] = [
    ["auth (401)", () => jsonResponse(401, "")],
    ["too_large (413)", () => jsonResponse(413, "")],
    ["http_400", () => jsonResponse(400, "")],
    ["bad_response (not Hunt)", () => jsonResponse(200, "<html>router login</html>")],
    ["bad_response (payload is not an object)", () => jsonResponse(200, { payload: [] })],
  ];

  it.each(DETERMINISTIC)("%s pauses: one request, none for 10 minutes, each trigger exactly one more", async (_name, respond) => {
    const net = recorder(respond);
    w = loadMobile({ seedState: oneTask, fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(net.calls).toHaveLength(1);
    expect(page().getSyncStatus().phase).toBe("attention");

    page().openSyncSheet();
    expect(page().document.getElementById("syncNextTry")?.textContent).toBe("Paused, tap Sync Now");
    page().closeSheet();

    let edits = 0;
    const triggers: [string, () => void][] = [
      ["Sync Now", () => void page().syncNow()],
      ["app visible again", () => {
        page().__huntLifecycle("pause");
        page().__huntLifecycle("resume");
      }],
      ["network online", () => page().dispatchEvent(new (page().Event)("online"))],
      ["a local edit", () => page().updateTaskField("tsk-1", "title", "Write " + ++edits)],
    ];
    for (const [label, trigger] of triggers) {
      const before = net.calls.length;
      trigger();
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(net.calls.length, label).toBe(before + 1);
    }
    expect(pageErrors(page())).toEqual([]);
  });

  it("a new laptop address typed while paused is tried once", async () => {
    const net = recorder(() => jsonResponse(401, ""));
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.calls).toHaveLength(1);
    page().openSyncSheet();
    const input = page().document.getElementById("modalLaptopUrl") as HTMLInputElement;
    input.value = "http://192.168.1.9:3000";
    input.dispatchEvent(new (page().Event)("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(net.calls.map((c) => c.url)).toEqual([net.calls[0].url, "http://192.168.1.9:3000/api/sync"]);
  });

  const TRANSIENT: [string, () => Promise<FakeResponse>][] = [
    ["http_503", () => Promise.resolve(jsonResponse(503, ""))],
    ["unreachable", () => Promise.reject(new Error("ECONNREFUSED"))],
  ];

  it.each(TRANSIENT)("%s keeps the backoff running", async (_name, respond) => {
    const net = recorder(respond);
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    const status = page().getSyncStatus();
    expect(status.failures).toBeGreaterThanOrEqual(15); // 30 s cap: roughly 20+ attempts in 10 min
    page().openSyncSheet();
    expect(page().document.getElementById("syncNextTry")?.textContent).toMatch(/^Next automatic try in \d+ s$|^Trying now/);
  });

  it("http_429 and http_408 are transient (backoff, no pause)", async () => {
    for (const code of [429, 408]) {
      const net = recorder(() => jsonResponse(code, ""));
      w = loadMobile({ fetchImpl: net.impl });
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      expect(net.calls.length, `HTTP ${code}`).toBeGreaterThan(5);
      w.close();
      w = null;
    }
  });
});

describe("server-advertised routes", () => {
  it("keeps only LAN, Tailscale and loopback lanUrls", async () => {
    const lanUrls = [
      "http://evil.example",
      "http://192.168.1.5:3000",
      "http://10.example.com:3000",
      "http://192.168.1.5:3000@evil.example",
      "http://100.64.1.2:3000",
      "http://localhost:3000",
      "ftp://192.168.1.7",
      "javascript:alert(1)",
      "http://8.8.8.8:3000",
      "http://172.32.0.1:3000",
    ];
    const net = recorder(() => jsonResponse(200, okBody({ lanUrls })));
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(page().getSyncStatus().lanUrls).toEqual(["http://192.168.1.5:3000", "http://100.64.1.2:3000", "http://localhost:3000"]);
  });

  it("the spec pair: ['http://evil.example', 'http://192.168.1.5:3000'] keeps only the private URL", async () => {
    const net = recorder(() => jsonResponse(200, okBody({ lanUrls: ["http://evil.example", "http://192.168.1.5:3000"] })));
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(page().getSyncStatus().lanUrls).toEqual(["http://192.168.1.5:3000"]);
  });

  it("drops a public URL an older version saved in the sync meta", () => {
    w = loadMobile({ storage: { [SYNC_META_KEY]: JSON.stringify({ lanUrls: ["http://evil.example", "http://192.168.1.5:3000"] }) } });
    expect(page().getSyncStatus().lanUrls).toEqual(["http://192.168.1.5:3000"]);
  });
});

describe("round trip with the reference server merge", () => {
  it("converges with the laptop's copy, and idle syncs write nothing on the phone", async () => {
    let server: SyncPayload = createEmptySyncPayload();
    const net = recorder((c) => {
      const checked = validateSyncPayload(JSON.parse(c.body));
      if (!checked.valid || !checked.payload) return jsonResponse(400, "");
      server = mergeSyncPayloads(server, checked.payload);
      return jsonResponse(200, { payload: server, lanUrls: ["http://192.168.1.5:3000"] });
    });
    w = loadMobile({ seedState: oneTask, fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(2000);
    const p = page();
    p.initializeFocus("tsk-1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(server.tasks.map((t) => [t.id, t.status])).toEqual([["tsk-1", "active"]]);
    expect(server.activeFocus).toEqual(readState(p).activeFocus);

    const writes: string[] = [];
    const proto = p.Storage.prototype;
    const original = proto.setItem;
    proto.setItem = function (this: Storage, key: string, value: string) {
      writes.push(key);
      return original.call(this, key, value);
    };
    const before = net.calls.length;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(net.calls.length).toBeGreaterThan(before + 5); // healthy: a sync every ~5 s
    expect(writes.filter((k) => k !== SYNC_META_KEY)).toEqual([]);
    expect(page().getSyncStatus()).toEqual(expect.objectContaining({ phase: "ok", pending: 0 }));
  });
});

describe("merge failures", () => {
  it("a throwing merge is not 'Synced': phase not ok, lastOkAt unchanged, logged, paused", async () => {
    const lastOkAt = NOW - 60 * MINUTE;
    const net = recorder(() => jsonResponse(200, okBody()));
    w = loadMobile({ fetchImpl: net.impl, storage: { [SYNC_META_KEY]: JSON.stringify({ lastOkAt }) } });
    w.mergePayloads = () => {
      throw new Error("merge boom");
    };
    await vi.advanceTimersByTimeAsync(1000);
    const status = page().getSyncStatus();
    expect(status.phase).not.toBe("ok");
    expect(status.lastOkAt).toBe(lastOkAt);
    expect(status.lastError).toBe("bad_response");
    expect(pageConsole(page()).some((e) => e.level === "error" && e.args[0] === "[hunt] sync.merge_failed")).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(net.calls).toHaveLength(1);
  });

  it("a merge that works records the success", async () => {
    const net = recorder(() => jsonResponse(200, okBody()));
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(page().getSyncStatus()).toEqual(expect.objectContaining({ phase: "ok", lastError: null }));
    expect(page().getSyncStatus().lastOkAt).toBeGreaterThanOrEqual(NOW);
  });
});

describe("pairing", () => {
  function pasteIntoAddressField(win: MobileWindow, text: string): HTMLInputElement {
    win.openSyncSheet();
    const input = win.document.getElementById("modalLaptopUrl") as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new win.Event("change", { bubbles: true }));
    return input;
  }

  function apkBridge(saveResult: boolean | undefined, withSaveMethod = true) {
    const saved: string[] = [];
    const urls: string[] = [];
    const syncs: { id: string; candidates: string[] }[] = [];
    const bridge: AndroidBridgeStub = {
      loadState: () => "",
      saveState: () => undefined,
      getLaptopUrl: () => "",
      saveLaptopUrl: (u) => void urls.push(u),
      syncWithLaptopAsync: (id, candidatesJson) => {
        syncs.push({ id, candidates: JSON.parse(candidatesJson) as string[] });
        return true;
      },
    };
    if (withSaveMethod) {
      bridge.saveSyncToken = (t) => {
        saved.push(t);
        return saveResult;
      };
    }
    return { bridge, saved, urls, syncs };
  }

  function answerNative(win: MobileWindow, id: string, reason: string) {
    win.__huntSyncDone({ id, ok: reason === "ok", reason, url: null, code: 0, ms: 1, attempts: [], body: reason === "ok" ? okBody() : "" });
  }

  function storageValues(win: MobileWindow): string[] {
    const out: string[] = [];
    for (let i = 0; i < win.localStorage.length; i++) {
      const k = win.localStorage.key(i);
      if (k) out.push(k + "=" + (win.localStorage.getItem(k) ?? ""));
    }
    return out;
  }

  it.each([
    ["/?token=", `http://192.168.1.5:3000/?token=${KEY}`],
    ["/hunt-mobile.html?token=", `http://192.168.1.5:3000/hunt-mobile.html?token=${KEY}`],
  ])("APK: a pasted %s link saves the key natively, never in localStorage, and syncs to its origin", async (_form, link) => {
    const b = apkBridge(true);
    w = loadMobile({ bridge: b.bridge });
    await vi.advanceTimersByTimeAsync(200);
    expect(b.syncs).toHaveLength(1);
    answerNative(page(), b.syncs[0].id, "auth");
    await vi.advanceTimersByTimeAsync(50);
    page().openSyncSheet();
    expect(page().document.getElementById("syncStatusCard")?.textContent).toContain("Not paired, or the key was rejected");
    expect(page().document.getElementById("syncStatusCard")?.textContent).toContain("Paste the pairing link");

    const input = pasteIntoAddressField(page(), link);
    expect(b.saved).toEqual([KEY]);
    expect(b.urls).toContain("http://192.168.1.5:3000");
    expect(input.value).toBe("http://192.168.1.5:3000");
    expect(storageValues(page()).some((v) => v.includes(KEY))).toBe(false);
    expect(page().localStorage.getItem(TOKEN_KEY)).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(b.syncs).toHaveLength(2); // the new key is tried right away
    expect(b.syncs[1].candidates[0]).toBe("http://192.168.1.5:3000");
    expect(pageErrors(page())).toEqual([]);
  });

  it("APK: a key the shell rejects is reported and the address is not changed", () => {
    const b = apkBridge(false);
    w = loadMobile({ bridge: b.bridge });
    pasteIntoAddressField(page(), `http://192.168.1.5:3000/?token=${KEY}`);
    expect(page().document.getElementById("syncUrlHint")?.textContent).toContain("did not accept");
    expect(b.urls).toEqual([]);
  });

  it("APK: an older shell (no boolean result / no method) counts as accepted", () => {
    for (const withMethod of [true, false]) {
      const b = apkBridge(undefined, withMethod);
      w = loadMobile({ bridge: b.bridge });
      pasteIntoAddressField(page(), `http://192.168.1.5:3000/?token=${KEY}`);
      expect(b.urls).toContain("http://192.168.1.5:3000");
      expect(page().localStorage.getItem(TOKEN_KEY)).toBeNull();
      w.close();
      w = null;
    }
  });

  it("an incomplete key in a pairing link is refused with a hint", () => {
    const b = apkBridge(true);
    w = loadMobile({ bridge: b.bridge });
    pasteIntoAddressField(page(), "http://192.168.1.5:3000/?token=short");
    expect(page().document.getElementById("syncUrlHint")?.textContent).toContain("incomplete");
    expect(b.saved).toEqual([]);
    expect(b.urls).toEqual([]);
  });

  it("browser copy: no key -> no X-Hunt-Token header; a pasted link stores the key and fetch sends it", async () => {
    const net = recorder((c) => (c.headers["X-Hunt-Token"] === KEY ? jsonResponse(200, okBody()) : jsonResponse(401, "")));
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].headers).not.toHaveProperty("X-Hunt-Token");
    expect(page().getSyncStatus().lastError).toBe("auth");

    const input = pasteIntoAddressField(page(), `http://192.168.1.5:3000/hunt-mobile.html?token=${KEY}`);
    expect(input.value).toBe("http://192.168.1.5:3000");
    expect(page().localStorage.getItem(TOKEN_KEY)).toBe(KEY);
    await vi.advanceTimersByTimeAsync(200);
    const last = net.calls[net.calls.length - 1];
    expect(last.url).toBe("http://192.168.1.5:3000/api/sync");
    expect(last.headers["X-Hunt-Token"]).toBe(KEY);
    expect(page().getSyncStatus().phase).toBe("ok");
  });

  it("a link pasted while an automatic sync (sent without the key) is still out is tried with the new key", async () => {
    let release: (r: FakeResponse) => void = () => undefined;
    let sent = 0;
    const net = recorder((c) => {
      if (++sent === 1) return new Promise<FakeResponse>((resolve) => { release = resolve; });
      return c.headers["X-Hunt-Token"] === KEY ? jsonResponse(200, okBody()) : jsonResponse(401, "");
    });
    w = loadMobile({ fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].headers).not.toHaveProperty("X-Hunt-Token");
    // same laptop address as now (the page's own origin): only the key is new
    pasteIntoAddressField(page(), `http://localhost/hunt-mobile.html?token=${KEY}`);
    release(jsonResponse(401, ""));
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1].headers["X-Hunt-Token"]).toBe(KEY);
    expect(page().getSyncStatus()).toEqual(expect.objectContaining({ phase: "ok", lastError: null }));
  });

  it("APK: a link pasted during a Sync Now, sheet closed before it fails, still gets its own sync", async () => {
    const b = apkBridge(true);
    w = loadMobile({ bridge: b.bridge });
    await vi.advanceTimersByTimeAsync(200);
    answerNative(page(), b.syncs[0].id, "auth"); // unpaired: paused
    await vi.advanceTimersByTimeAsync(50);
    page().openSyncSheet();
    click(page(), page().document.getElementById("syncNowBtn"));
    await vi.advanceTimersByTimeAsync(50);
    expect(b.syncs).toHaveLength(2); // Sync Now, still out (sent without the key)
    pasteIntoAddressField(page(), `http://192.168.1.5:3000/?token=${KEY}`);
    expect(b.saved).toEqual([KEY]);
    page().closeSheet();
    answerNative(page(), b.syncs[1].id, "auth"); // that Sync Now fails and pauses syncing again
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.syncs).toHaveLength(3); // the new key is tried anyway
    expect(b.syncs[2].candidates[0]).toBe("http://192.168.1.5:3000");
    answerNative(page(), b.syncs[2].id, "ok");
    await vi.advanceTimersByTimeAsync(50);
    expect(page().getSyncStatus()).toEqual(expect.objectContaining({ phase: "ok", lastError: null }));
    expect(pageErrors(page())).toEqual([]);
  });

  it("browser copy opened from a pairing link keeps the key and strips it from the address bar", async () => {
    const net = recorder(() => jsonResponse(200, okBody()));
    w = loadMobile({ url: `http://localhost/hunt-mobile.html?token=${KEY}&view=today`, fetchImpl: net.impl });
    expect(page().location.href).not.toContain(KEY);
    expect(page().location.search).toBe("?view=today");
    expect(page().localStorage.getItem(TOKEN_KEY)).toBe(KEY);
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls[0].headers["X-Hunt-Token"]).toBe(KEY);
  });

  it("browser copy ignores an invalid stored key (no header)", async () => {
    const net = recorder(() => jsonResponse(401, ""));
    w = loadMobile({ fetchImpl: net.impl, storage: { [TOKEN_KEY]: "short" } });
    await vi.advanceTimersByTimeAsync(200);
    expect(net.calls[0].headers).not.toHaveProperty("X-Hunt-Token");
  });
});

describe("R6: a local write never carries an older stamp than the row it replaces", () => {
  const FUTURE = NOW + 120_000; // the laptop's clock is two minutes ahead
  function skewedState() {
    const t = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      status: "queued",
      rank: Number(id.slice(-1)) * 1000,
      questId: "quest-1",
      accumulatedSeconds: 0,
      createdAt: FUTURE,
      updatedAt: FUTURE,
      ...extra,
    });
    const focus: FocusShape = { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: FUTURE };
    return {
      ...emptyPayload(),
      quests: [{ id: "quest-1", slotIndex: 0, title: "Quest", accentColor: "cyan", targetWeeklyHours: 5, createdAt: FUTURE, updatedAt: FUTURE }],
      tasks: [t("tsk-1"), t("tsk-2"), t("tsk-3"), t("tsk-4"), t("tsk-5")],
      activeFocus: focus,
    };
  }

  it("task edits, complete, reopen and quest save", () => {
    w = loadMobile({ seedState: skewedState() });
    const p = page();
    p.updateTaskField("tsk-1", "title", "Renamed");
    const s1 = stampOf(task(readState(p), "tsk-1"));
    expect(s1).toBeGreaterThan(FUTURE);
    p.saveTaskText("tsk-1", "notes", "typed");
    expect(stampOf(task(readState(p), "tsk-1"))).toBeGreaterThan(s1);

    p.completeTaskDirect("tsk-2");
    const s2 = stampOf(task(readState(p), "tsk-2"));
    expect(task(readState(p), "tsk-2").status).toBe("completed");
    expect(s2).toBeGreaterThan(FUTURE);
    p.reopenTaskDirect("tsk-2");
    expect(stampOf(task(readState(p), "tsk-2"))).toBeGreaterThan(s2);

    p.openQuestEditorSheet("quest-1");
    (p.document.getElementById("sheetQuestTitle") as HTMLInputElement).value = "Quest renamed";
    p.saveQuestFromSheet("quest-1");
    const quest = readState(p).quests[0];
    expect(quest.title).toBe("Quest renamed");
    expect(stampOf(quest)).toBeGreaterThan(FUTURE);
  });

  it("every focus write: start, pause, resume, back to queue, complete-and-next, complete-last, delete", () => {
    w = loadMobile({ seedState: skewedState() });
    const p = page();
    const focusStamp = () => readState(p).activeFocus.updatedAt;
    let last = FUTURE;
    const step = (label: string, action: () => void) => {
      action();
      const now = focusStamp();
      expect(now, label).toBeGreaterThan(last);
      last = now;
    };
    step("start", () => p.initializeFocus("tsk-3"));
    expect(readState(p).activeFocus).toEqual(expect.objectContaining({ activeTaskId: "tsk-3", isRunning: true, sessionStartedAt: NOW }));
    step("pause", () => p.toggleTimerPause());
    step("resume", () => p.toggleTimerPause());
    step("back to queue", () => p.returnToQueueFromFocus());
    step("start again", () => p.initializeFocus("tsk-3"));
    step("complete focused task (stops without auto-starting next)", () => p.completeActiveTaskAndNext());
    expect(readState(p).activeFocus.activeTaskId).toBeNull();
    expect(readState(p).activeFocus.isRunning).toBe(false);
    // Remaining tasks stay queued until explicitly started.
    for (const nextId of ["tsk-1", "tsk-2"]) {
      step("start " + nextId, () => p.initializeFocus(nextId));
      step("complete " + nextId, () => p.completeActiveTaskAndNext());
      expect(readState(p).activeFocus.activeTaskId).toBeNull();
    }
    step("start the reopened task", () => {
      p.reopenTaskDirect("tsk-1");
      p.initializeFocus("tsk-1");
    });
    step("delete the focused task", () => p.deleteTaskItem("tsk-1"));
    expect(readState(p).activeFocus.activeTaskId).toBeNull();
  });

  it("switching away from a finished focus with nothing queued clears it with a newer stamp", () => {
    const s = skewedState();
    s.tasks = s.tasks.map((t) => ({ ...t, status: "completed", completedAt: FUTURE }));
    s.activeFocus = { activeTaskId: "tsk-1", isRunning: false, sessionStartedAt: null, updatedAt: FUTURE };
    w = loadMobile({ seedState: s });
    page().initializeFocus();
    expect(readState(page()).activeFocus).toEqual(expect.objectContaining({ activeTaskId: null }));
    expect(readState(page()).activeFocus.updatedAt).toBeGreaterThan(FUTURE);
  });

  it("a quest delete unlinks with newer stamps, and Undo re-links its tasks with newer stamps still", () => {
    w = loadMobile({ seedState: skewedState() });
    const p = page();
    p.deleteQuestItem("quest-1");
    const unlinked = readState(p);
    expect(unlinked.quests).toEqual([]);
    expect(unlinked.tasks.every((t) => t.questId === null && stampOf(t) > FUTURE)).toBe(true);
    const undo = p.document.querySelectorAll("#toastHost .toast-action");
    click(p, undo[undo.length - 1]);
    const restored = readState(p);
    expect(restored.quests.map((q) => q.id)).toEqual(["quest-1"]);
    for (const t of restored.tasks) {
      expect(t.questId).toBe("quest-1");
      expect(stampOf(t)).toBeGreaterThan(stampOf(task(unlinked, t.id)));
    }
    expect(restored.deletedQuestIds).toEqual([]);
  });

  it("Undo of deleting the focused task brings its running session back with a newer stamp", () => {
    w = loadMobile({ seedState: skewedState() });
    const p = page();
    p.initializeFocus("tsk-3");
    const running = readState(p).activeFocus;
    p.deleteTaskItem("tsk-3");
    const cleared = readState(p).activeFocus;
    expect(cleared.activeTaskId).toBeNull();
    expect(cleared.updatedAt).toBeGreaterThan(running.updatedAt);
    const undo = p.document.querySelectorAll("#toastHost .toast-action");
    click(p, undo[undo.length - 1]);
    const restored = readState(p).activeFocus;
    expect(restored).toEqual({ ...running, updatedAt: restored.updatedAt });
    expect(restored.updatedAt).toBeGreaterThan(cleared.updatedAt);
  });

  it("a task edited after the quest delete is not re-linked by Undo", () => {
    w = loadMobile({ seedState: skewedState() });
    const p = page();
    p.deleteQuestItem("quest-1");
    p.updateTaskField("tsk-2", "title", "edited meanwhile");
    const undo = p.document.querySelectorAll("#toastHost .toast-action");
    click(p, undo[undo.length - 1]);
    const s = readState(p);
    expect(task(s, "tsk-2").questId).toBeNull();
    expect(task(s, "tsk-1").questId).toBe("quest-1");
  });
});

describe("DST-safe day steps (TZ Europe/Berlin)", () => {
  const prevTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Europe/Berlin";
  });
  afterAll(() => {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  });

  /** Calendar arithmetic on YYYY-MM-DD keys, independent of the page (UTC, no DST). */
  function keyAt(iso: string, offset: number): string {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
  }
  const longLabel = (k: string) =>
    new Date(k + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const shortLabel = (k: string) => new Date(k + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

  it.each([
    ["2026-03-30T00:30:00", "2026-03-30", "2026-03-31"],
    ["2026-10-25T00:30:00", "2026-10-25", "2026-10-26"],
  ])("at %s local: tomorrow differs from today; 7-day, Plan and Review windows are consecutive", (local, today, tomorrow) => {
    vi.setSystemTime(new Date(local));
    expect(new Date(local).getTimezoneOffset()).toBe(-120); // CEST: the zone really is in effect
    const last7 = [-6, -5, -4, -3, -2, -1, 0].map((o) => keyAt(today, o));
    const seed = {
      ...emptyPayload(),
      quests: [{ id: "quest-1", slotIndex: 0, title: "Quest", accentColor: "cyan", targetWeeklyHours: 10, updatedAt: 1 }],
      timeLogs: last7.map((dk, i) => ({
        id: `log-${i + 1}-tsk-1`,
        taskId: "tsk-1",
        questId: "quest-1",
        taskTitleSnapshot: "x",
        startTime: i + 1,
        endTime: i + 2,
        durationSeconds: 3600,
        dateKey: dk,
      })),
    };
    w = loadMobile({ seedState: seed });
    const p = page();
    expect(p.toLocalDateKey()).toBe(today);
    expect(p.dayKeyOffset(1)).toBe(tomorrow);

    // Today: the weekly hours count all 7 days (a skipped day would show 6.0h)
    expect(p.document.querySelector(".hero-stats-pill")?.textContent).toContain("7.0h / 10h wk");

    // New Task "Tomorrow" schedules for the next calendar day
    p.openNewTaskSheet();
    const pills = Array.from(p.document.querySelectorAll("#sheetContainer .sheet-pill"));
    click(p, pills.find((b) => b.textContent?.trim() === "Tomorrow") ?? null);
    (p.document.getElementById("sheetTaskTitle") as HTMLInputElement).value = "Plan tomorrow";
    click(p, Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent?.includes("Add to Top")) ?? null);
    expect(readState(p).tasks.find((t) => t.title === "Plan tomorrow")?.scheduledDate).toBe(tomorrow);
    expect(p.document.getElementById("toastHost")?.textContent).toContain("Added for tomorrow");

    // Plan: five consecutive days around today; "next day" moves to tomorrow
    p.switchView("plan");
    const cards = Array.from(p.document.querySelectorAll(".plan-day-card"));
    expect(cards.map((c) => c.getAttribute("aria-label")?.split(",").slice(0, 2).join(","))).toEqual(
      [-2, -1, 0, 1, 2].map((o) => longLabel(keyAt(today, o)))
    );
    click(p, p.document.querySelector('[aria-label="Next day"]'));
    expect(p.document.querySelector(".plan-day-card.active")?.getAttribute("aria-label")).toContain(longLabel(tomorrow));

    // Review: 7 distinct consecutive days ending today, all logged hours counted
    p.switchView("telemetry");
    const eyebrow = p.document.querySelector(".hero-eyebrow")?.textContent ?? "";
    expect(eyebrow).toBe(shortLabel(last7[0]) + " – " + shortLabel(last7[6]));
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("7.0h");
    expect(pageErrors(p)).toEqual([]);
  });
});
