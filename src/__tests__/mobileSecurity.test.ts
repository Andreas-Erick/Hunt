// @vitest-environment node
// Adversarial suite for the phone page: hostile synced or saved data must never execute, break out of
// an attribute, or reach an inline handler as code; unsafe ids are dropped at the boundary; no secret
// is shipped in the asset.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_ASSET_PATH,
  click,
  loadMobile,
  pageErrors,
  readState,
  type MobileWindow,
} from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const PAYLOADS = [
  "'",
  '"',
  "\\",
  "</script>",
  '"><img src=x onerror=window.__pwned=1>',
  "');window.__pwned=1;//",
  "\u2028", // LINE SEPARATOR (ends a line in older JS parsers)
  "x".repeat(10000),
  "مرحبا بالعالم",
  "👨‍👩‍👧‍👦",
  "${window.__pwned=1}",
  "javascript:window.__pwned=1",
];
const ALLOWED_HANDLERS = new Set(["onclick", "oninput", "onchange", "onkeydown"]);
const CLICKABLE = "button, [role=button]";

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

function todayKey(): string {
  const d = new Date(NOW);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

/** Every payload in every text field, plus rows whose ids ARE payloads (those must be dropped). */
function hostileState() {
  const quests: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const timeLogs: Record<string, unknown>[] = [];
  PAYLOADS.forEach((p, i) => {
    quests.push({ id: p, title: "bad id " + i, slotIndex: 0, accentColor: "cyan" });
    quests.push({
      id: `quest-${i}`,
      slotIndex: i % 3,
      title: p,
      code: p,
      description: p,
      targetWeeklyHours: p,
      accentColor: ["constructor", "__proto__", p][i % 3],
      updatedAt: 1,
    });
    tasks.push({ id: p, title: "bad id " + i, status: "queued", rank: i });
    tasks.push({
      id: `tsk-${i}`,
      title: p,
      notes: p,
      status: i % 4 === 3 ? "completed" : "queued",
      completedAt: NOW - 1000,
      rank: i * 1000,
      questId: i % 2 ? `quest-${i}` : null,
      scheduledDate: p,
      accumulatedSeconds: 61,
      updatedAt: 1,
    });
    timeLogs.push({ id: p, taskId: `tsk-${i}`, durationSeconds: 60 });
    timeLogs.push({ id: `log-${i}-${p}`, taskId: p, durationSeconds: 60 });
    timeLogs.push({
      id: `log-${i + 1}-tsk-${i}`,
      taskId: `tsk-${i}`,
      taskTitleSnapshot: p,
      questId: i % 2 ? `quest-${i}` : null,
      questCodeSnapshot: p,
      accentColorSnapshot: p,
      startTime: NOW - (i + 1) * 600_000,
      endTime: NOW - (i + 1) * 600_000 + 300_000,
      durationSeconds: 300,
      dateKey: todayKey(),
    });
  });
  return {
    quests,
    tasks,
    timeLogs,
    deletedQuestIds: [...PAYLOADS],
    deletedTaskIds: [...PAYLOADS, "tsk-gone"],
    deletedLogIds: [...PAYLOADS],
    activeFocus: { activeTaskId: "tsk-1", isRunning: true, sessionStartedAt: NOW - 5000, updatedAt: NOW - 5000 },
    lastSyncedAt: 0,
  };
}

function assertDropped(win: MobileWindow) {
  const s = readState(win);
  const bad = new Set(PAYLOADS);
  for (const list of [s.quests, s.tasks, s.timeLogs]) {
    expect(list.some((row) => bad.has(row.id) || String(row.id).includes(PAYLOADS[4]))).toBe(false);
  }
  expect(s.timeLogs.every((l) => typeof l.taskId === "string" && /^[A-Za-z0-9_.:-]+$/.test(String(l.taskId)))).toBe(true);
  for (const list of [s.deletedQuestIds, s.deletedTaskIds, s.deletedLogIds]) {
    expect(list.some((id) => bad.has(id))).toBe(false);
  }
  expect(s.deletedTaskIds).toContain("tsk-gone");
  expect(s.quests).toHaveLength(PAYLOADS.length);
  expect(s.tasks).toHaveLength(PAYLOADS.length);
  expect(s.timeLogs).toHaveLength(PAYLOADS.length);
  expect(s.tasks.every((t) => t.scheduledDate === undefined)).toBe(true); // none was YYYY-MM-DD
}

function assertClean(win: MobileWindow, where: string) {
  const doc = win.document;
  expect(win.__pwned, where).toBeUndefined();
  expect(doc.querySelectorAll("img, iframe, object, embed").length, where).toBe(0);
  // Exactly the page's own three scripts: the look boot script in <head> (ADR-0005), the generated
  // shared core (HuntCore) and the page script.
  const scripts = doc.querySelectorAll("script");
  expect(scripts.length, where).toBe(3);
  expect(scripts[0].textContent, where).toContain('localStorage.getItem("hunt-look")');
  expect(scripts[1].textContent, where).toContain("var HuntCore = ");
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith("on")) continue;
      expect(ALLOWED_HANDLERS.has(attr.name), `${where}: unexpected ${attr.name} on <${el.tagName}>`).toBe(true);
      expect(attr.value.includes("__pwned"), `${where}: payload inside a handler`).toBe(false);
    }
  }
  expect(pageErrors(win), where).toEqual([]);
}

/** Puts the page back into a known state between clicks (each click may complete or delete rows). */
function resetState(win: MobileWindow, snapshot: string) {
  win.eval(`state = normalizeLoadedState(JSON.parse(${JSON.stringify(snapshot)})).state; closeSheet(); renderApp();`);
}

/** Opens a screen, then clicks each of its controls once (from a fresh copy of that screen). */
function sweep(win: MobileWindow, snapshot: string, label: string, open: () => void) {
  resetState(win, snapshot);
  open();
  const total = win.document.querySelectorAll(CLICKABLE).length;
  expect(total, label).toBeGreaterThan(0);
  for (let i = 0; i < total; i++) {
    resetState(win, snapshot);
    open();
    const target = win.document.querySelectorAll(CLICKABLE)[i];
    if (!target) continue;
    const name = `${label} #${i} (${target.getAttribute("aria-label") ?? target.textContent?.trim().slice(0, 30)})`;
    click(win, target);
    win.tick();
    assertClean(win, name);
  }
}

const VIEWS = ["command", "plan", "focus", "quests", "telemetry"] as const;

function sweepEverything(win: MobileWindow) {
  const snapshot = JSON.stringify(readState(win));
  const s = readState(win);
  for (const view of VIEWS) sweep(win, snapshot, "view " + view, () => win.switchView(view));
  sweep(win, snapshot, "Today timeline", () => {
    win.switchView("command");
    click(win, Array.from(win.document.querySelectorAll(".seg-option"))[1]);
  });
  sweep(win, snapshot, "Review session log", () => {
    win.switchView("telemetry");
    click(win, Array.from(win.document.querySelectorAll("#mainContainer .text-action")).pop() ?? null);
  });
  sweep(win, snapshot, "New Task sheet", () => win.openNewTaskSheet());
  sweep(win, snapshot, "New Quest sheet", () => win.openNewQuestSheet());
  sweep(win, snapshot, "Sync sheet", () => win.openSyncSheet());
  // every row's sheet is opened; the controls are clicked for the rows carrying the break-out payloads
  for (const t of s.tasks) {
    win.openTaskInspectorSheet(t.id);
    assertClean(win, "Task Options " + t.id);
  }
  for (const q of s.quests) {
    win.openQuestEditorSheet(q.id);
    assertClean(win, "Edit Quest " + q.id);
  }
  for (const i of [4, 5, 10]) {
    sweep(win, snapshot, "Task Options tsk-" + i, () => win.openTaskInspectorSheet(`tsk-${i}`));
    sweep(win, snapshot, "Edit Quest quest-" + i, () => win.openQuestEditorSheet(`quest-${i}`));
  }
}

describe("hostile data", () => {
  it("seeded state: unsafe ids dropped; every view, sheet and control renders and runs no injected code", () => {
    w = loadMobile({ seedState: hostileState() });
    assertDropped(page());
    assertClean(page(), "boot");
    sweepEverything(page());
  }, 30_000);

  it("the same payloads via applyRemotePayload (a sync answer)", () => {
    w = loadMobile();
    page().applyRemotePayload(hostileState());
    assertDropped(page());
    for (const view of VIEWS) {
      page().switchView(view);
      assertClean(page(), "remote " + view);
    }
    const snapshot = JSON.stringify(readState(page()));
    sweep(page(), snapshot, "remote Today", () => page().switchView("command"));
  });

  it("targetWeeklyHours that is not a number renders as 0h, not as markup", () => {
    w = loadMobile({ seedState: hostileState() });
    page().switchView("quests");
    const text = page().document.getElementById("mainContainer")?.textContent ?? "";
    expect(text).toContain("/ 0h (");
    assertClean(page(), "quests");
  });

  it("__proto__ in a sync answer pollutes nothing", () => {
    w = loadMobile();
    const text =
      '{"__proto__":{"pwnedFlag":1},"tasks":[{"id":"tsk-1","title":"t","status":"queued","rank":0,"__proto__":{"pwnedFlag":1}}],' +
      '"quests":[{"id":"quest-1","title":"q","slotIndex":0,"constructor":{"prototype":{"pwnedFlag":1}}}]}';
    page().applyRemotePayload(page().JSON.parse(text));
    expect(page().eval("({}).pwnedFlag")).toBeUndefined();
    expect(({} as Record<string, unknown>).pwnedFlag).toBeUndefined();
    expect(readState(page()).tasks.map((t) => t.id)).toEqual(["tsk-1"]);
    page().switchView("quests");
    assertClean(page(), "proto quests");
  });
});

describe("inline handler arguments", () => {
  it("jsArg round-trips every payload as one string literal", () => {
    w = loadMobile();
    const p = page();
    const host = p.document.createElement("div");
    p.document.body.appendChild(host);
    for (const payload of PAYLOADS) {
      host.innerHTML = `<button onclick="window.__got=${p.jsArg(payload)}">x</button>`;
      click(p, host.querySelector("button"));
      const got: unknown = p.eval("window.__got");
      expect(got).toBe(payload);
      expect(p.__pwned).toBeUndefined();
    }
  });

  it("escapeHtml keeps 0, drops null/undefined and escapes the single quote", () => {
    w = loadMobile();
    expect(page().escapeHtml(0)).toBe("0");
    expect(page().escapeHtml(null)).toBe("");
    expect(page().escapeHtml(undefined)).toBe("");
    expect(page().escapeHtml(`<a href='x'>"&`)).toBe("&lt;a href=&#39;x&#39;&gt;&quot;&amp;");
  });

  it("a safe id with '.' and ':' reaches its handler unchanged: exactly that task completes", () => {
    const tasks = [
      { id: "tsk-1", title: "Plain", status: "queued", rank: 0, questId: null },
      { id: "tsk-1.a", title: "Prefix", status: "queued", rank: 1000, questId: null },
      { id: "tsk-1.a:b", title: "Target", status: "queued", rank: 2000, questId: null, accumulatedSeconds: 30 },
    ];
    w = loadMobile({
      seedState: {
        tasks,
        quests: [],
        timeLogs: [],
        activeFocus: { activeTaskId: "tsk-1.a:b", isRunning: true, sessionStartedAt: NOW - 2000, updatedAt: NOW - 2000 },
      },
    });
    const p = page();
    const timer = () =>
      Array.from(p.document.querySelectorAll("[data-task-timer]")).find((el) => el.getAttribute("data-task-timer") === "tsk-1.a:b");
    expect(timer()).toBeDefined();
    const before = timer()?.textContent;
    vi.advanceTimersByTime(5000); // the 500 ms ticker updates the live chrono of exactly that card
    expect(timer()?.textContent).not.toBe(before);
    expect(() => p.tick()).not.toThrow();

    p.returnToQueueFromFocus(); // completing the focus task would also start the next one
    click(p, p.document.querySelector('[aria-label="Complete Target"]'));
    const status = Object.fromEntries(readState(p).tasks.map((t) => [t.id, t.status]));
    expect(status).toEqual({ "tsk-1": "queued", "tsk-1.a": "queued", "tsk-1.a:b": "completed" });

    vi.advanceTimersByTime(500); // past the double-tap guard: a deliberate second completion
    p.openTaskInspectorSheet("tsk-1.a");
    click(p, Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent?.includes("Mark Completed")) ?? null);
    expect(readState(p).tasks.find((t) => t.id === "tsk-1.a")?.status).toBe("completed");
    expect(readState(p).tasks.find((t) => t.id === "tsk-1")?.status).toBe("queued");
    assertClean(p, "safe ids");
  });

  it("tick() never throws on hostile data, running or paused", () => {
    w = loadMobile({ seedState: hostileState() });
    for (const view of VIEWS) {
      page().switchView(view);
      expect(() => page().tick()).not.toThrow();
    }
    page().toggleTimerPause();
    expect(() => page().tick()).not.toThrow();
    vi.advanceTimersByTime(3000);
    expect(pageErrors(page())).toEqual([]);
  });
});

describe("shipped asset", () => {
  const html = readFileSync(MOBILE_ASSET_PATH, "utf8");

  it("contains no 64-hex secret literal", () => {
    expect(html).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("never calls the removed bridge methods", () => {
    expect(html).not.toMatch(/getSyncToken|isNetworkAvailable/);
  });

  it("has no inline handler that interpolates a quoted value", () => {
    expect(html).not.toMatch(/\bon[a-z]+="[^"]*'\$\{/);
  });

  it("passes every value inside an inline handler through jsArg, and escapes data-* values", () => {
    // constants of this file: closeSheet(${closeArg}) is "true"/"", chooseLaptopUrlAt(${i}) a loop
    // index, and emptyCardHtml's ${a.onclick} is handler code written here (data inside it uses jsArg)
    const constants = new Set(["${closeArg}", "${i}", "${a.onclick}"]);
    const handlers = html.match(/\bon[a-z]+="[^"]*"/g) ?? [];
    expect(handlers.length).toBeGreaterThan(40);
    let viaJsArg = 0;
    for (const handler of handlers) {
      for (const value of handler.match(/\$\{[^}]*\}/g) ?? []) {
        if (value.startsWith("${jsArg(")) viaJsArg++;
        else expect(constants.has(value), `raw ${value} in ${handler}`).toBe(true);
      }
    }
    expect(viaJsArg).toBeGreaterThan(40);
    for (const attr of html.match(/\bdata-[a-z-]+="[^"]*\$\{[^"]*"/g) ?? []) {
      expect(/="\$\{escapeHtml\(/.test(attr) || attr === 'data-phase="${m.phase}"', attr).toBe(true);
    }
  });
});
