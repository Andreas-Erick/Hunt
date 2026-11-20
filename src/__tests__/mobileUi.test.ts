// @vitest-environment node
// Phone page UX: Undo toasts that cannot be cut short (MUI-03), no silent loss of typed quest edits or
// New Task drafts (MUI-04), Enter-to-submit (MUI-08), 48 px touch targets (MUI-02), long-title overflow
// (MUI-05), WCAG AA contrast (MUI-06), the 320 px header (MUI-11), zoom + side safe areas (MUI-12), and
// the browser copy always syncing through its own origin (P01 request).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAPTOP_URL_KEY,
  click,
  jsonResponse,
  loadMobile,
  pageErrors,
  readState,
  seededRandom,
  type FakeResponse,
  type FetchInit,
  type MobileWindow,
} from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const MINUTE = 60_000;
const DRAFT_KEY = "hunt-composer-draft-v1";

interface ToastOptions {
  undo?: () => void;
  actionLabel?: string;
  holdSync?: boolean;
}
type UiWindow = MobileWindow & { showToast(message: string, opts?: ToastOptions): unknown };

let w: UiWindow | null = null;
function isUiWindow(x: MobileWindow): x is UiWindow {
  return "showToast" in x && typeof x.showToast === "function";
}
function load(options: Parameters<typeof loadMobile>[0] = {}): UiWindow {
  const loaded = loadMobile(options);
  if (!isUiWindow(loaded)) {
    loaded.close();
    throw new Error("the page has no showToast()");
  }
  w = loaded;
  return w;
}

/** The first element matching `selector` under `root` (default: the page); throws when there is none. */
function one(p: MobileWindow, selector: string, root: ParentNode = p.document): Element {
  const el = root.querySelector(selector);
  if (!el) throw new Error("missing " + selector);
  return el;
}
function must<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error("missing " + label);
  return value;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
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

function localKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function quest(id: string, title: string, accentColor = "cyan", extra: Record<string, unknown> = {}) {
  return { id, slotIndex: 0, title, description: "", accentColor, targetWeeklyHours: 5, updatedAt: 1, ...extra };
}

function task(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, status: "queued", rank: 0, questId: "quest-1", accumulatedSeconds: 0, updatedAt: 1, ...extra };
}

function log(n: number) {
  const startTime = NOW - (n + 1) * 20 * MINUTE;
  return {
    id: `log-${startTime}-tsk-1`,
    taskId: "tsk-1",
    taskTitleSnapshot: "Write " + n,
    questId: "quest-1",
    accentColorSnapshot: "cyan",
    startTime,
    endTime: startTime + 10 * MINUTE,
    durationSeconds: 600,
    dateKey: localKey(NOW),
  };
}

function baseState(extra: Record<string, unknown> = {}) {
  return {
    quests: [quest("quest-1", "Launch")],
    tasks: [task("tsk-1", "Write")],
    timeLogs: [log(1), log(2), log(3)],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...extra,
  };
}

interface Call {
  url: string;
  body: string;
}
function recorder(respond: (call: Call) => FakeResponse | Promise<FakeResponse>) {
  const calls: Call[] = [];
  const impl = (url: string, init?: FetchInit) => {
    const call = { url, body: init?.body ?? "" };
    calls.push(call);
    return Promise.resolve().then(() => respond(call));
  };
  return { calls, impl };
}
function okBody(): string {
  return JSON.stringify({ payload: { quests: [], tasks: [], timeLogs: [], deletedQuestIds: [], deletedTaskIds: [], deletedLogIds: [] } });
}
function sentTombstone(calls: Call[], logId: string): boolean {
  return calls.some((c) => {
    const body: unknown = JSON.parse(c.body);
    const ids = body && typeof body === "object" && "deletedLogIds" in body ? body.deletedLogIds : null;
    return Array.isArray(ids) && ids.includes(logId);
  });
}

function sheetKind(p: MobileWindow): string | null {
  const sc = p.document.getElementById("sheetContainer");
  return sc && sc.style.display !== "none" ? sc.dataset.sheet ?? null : null;
}
function liveToasts(p: MobileWindow): Element[] {
  return Array.from(p.document.querySelectorAll("#toastHost .toast:not(.leaving)"));
}
function toastTexts(p: MobileWindow): string[] {
  return liveToasts(p).map((t) => t.querySelector(".toast-msg")?.textContent ?? "");
}
function field(p: MobileWindow, id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = p.document.getElementById(id);
  if (el instanceof p.HTMLInputElement || el instanceof p.HTMLTextAreaElement) return el;
  throw new Error("missing field " + id);
}
function sheetButton(p: MobileWindow, text: string): Element | null {
  return Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent?.trim() === text) ?? null;
}
function colourPill(p: MobileWindow, colour: string): Element {
  const pill = Array.from(p.document.querySelectorAll("#sheetContainer .sheet-pill[data-color]")).find(
    (b) => b.getAttribute("data-color") === colour
  );
  if (!pill) throw new Error("missing colour pill " + colour);
  return pill;
}
function pressKey(p: MobileWindow, el: Element, init: KeyboardEventInit): KeyboardEvent {
  const e = new p.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe("Undo toasts (MUI-03)", () => {
  it("a tap on an Undo toast's message keeps it, and the tombstone stays on the phone until the window ends", async () => {
    const net = recorder(() => jsonResponse(200, okBody()));
    const p = load({ seedState: baseState(), fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.calls).toHaveLength(1);
    const id = log(1).id;
    p.deleteLogItem(id);
    const [toast] = liveToasts(p);
    click(p, toast.querySelector(".toast-msg"));
    expect(liveToasts(p)).toEqual([toast]);
    await vi.advanceTimersByTimeAsync(4500);
    expect(sentTombstone(net.calls, id)).toBe(false);
    await vi.advanceTimersByTimeAsync(2000); // the window ended: the delete goes out
    expect(sentTombstone(net.calls, id)).toBe(true);
    expect(pageErrors(p)).toEqual([]);
  });

  it("Undo after a stray tap still restores, and the tombstone never leaves the phone", async () => {
    const net = recorder(() => jsonResponse(200, okBody()));
    const p = load({ seedState: baseState(), fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    const id = log(2).id;
    p.deleteLogItem(id);
    const [toast] = liveToasts(p);
    click(p, toast);
    await vi.advanceTimersByTimeAsync(3000);
    click(p, toast.querySelector(".toast-action"));
    expect(readState(p).timeLogs.map((l) => l.id)).toContain(id);
    expect(readState(p).deletedLogIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(net.calls.length).toBeGreaterThan(1);
    expect(sentTombstone(net.calls, id)).toBe(false);
  });

  it("three quick log deletes: every Undo stays up for its full window, and the first one still works", () => {
    const p = load({ seedState: baseState() });
    const ids = [log(1).id, log(2).id, log(3).id];
    ids.forEach((id) => p.deleteLogItem(id));
    const toasts = liveToasts(p);
    expect(toasts).toHaveLength(3);
    click(p, toasts[0].querySelector(".toast-action"));
    let s = readState(p);
    expect(s.timeLogs.map((l) => l.id)).toEqual([ids[0]]);
    expect(s.deletedLogIds).toEqual([ids[1], ids[2]]);
    click(p, toasts[2].querySelector(".toast-action"));
    click(p, toasts[1].querySelector(".toast-action"));
    s = readState(p);
    expect(s.timeLogs.map((l) => l.id).sort()).toEqual([...ids].sort());
    expect(s.deletedLogIds).toEqual([]);
    vi.advanceTimersByTime(6000);
    expect(liveToasts(p)).toHaveLength(0);
  });

  it("a new toast replaces the oldest plain toast, never a running Undo", () => {
    const p = load({ seedState: baseState() });
    p.deleteLogItem(log(1).id);
    p.showToast("Plain 1");
    p.showToast("Plain 2");
    expect(toastTexts(p)).toEqual([expect.stringContaining("Session deleted"), "Plain 2"]);
    p.deleteLogItem(log(2).id);
    expect(toastTexts(p)).toEqual([expect.stringContaining("Session deleted"), expect.stringContaining("Session deleted")]);
    p.showToast("Plain 3"); // only Undo toasts up: the stack grows instead of ending one
    expect(toastTexts(p)).toHaveLength(3);
    const plain = liveToasts(p)[2];
    click(p, plain); // a plain toast still dismisses on tap
    expect(toastTexts(p)).toHaveLength(2);
  });
});

const DISMISS: [string, (p: MobileWindow) => void][] = [
  ["Android Back", (p) => void p.__huntBack()],
  ["Escape", (p) => void p.document.dispatchEvent(new p.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
  ["a backdrop tap", (p) => click(p, p.document.getElementById("sheetContainer"))],
  ["the × button", (p) => click(p, p.document.querySelector("#sheetContainer .sheet-close"))],
];

describe("unsaved quest edits and New Task drafts (MUI-04)", () => {
  it.each(DISMISS)("Edit Quest changed, then %s: 'Quest edits discarded', and Restore refills the form", (_label, dismiss) => {
    const p = load({ seedState: baseState() });
    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Launch v2";
    field(p, "sheetQuestDesc").value = "Ship the beta";
    field(p, "sheetQuestTarget").value = "7";
    click(p, colourPill(p, "amber"));
    dismiss(p);
    expect(sheetKind(p)).toBeNull();
    expect(readState(p).quests[0]).toEqual(expect.objectContaining({ title: "Launch", accentColor: "cyan" }));
    const [toast] = liveToasts(p);
    expect(toast.querySelector(".toast-msg")?.textContent).toBe("Quest edits discarded");
    expect(toast.querySelector(".toast-action")?.textContent).toBe("Restore");

    click(p, toast.querySelector(".toast-action"));
    expect(sheetKind(p)).toBe("quest:quest-1");
    expect(field(p, "sheetQuestTitle").value).toBe("Launch v2");
    expect(field(p, "sheetQuestDesc").value).toBe("Ship the beta");
    expect(field(p, "sheetQuestTarget").value).toBe("7");
    expect(colourPill(p, "amber").getAttribute("aria-pressed")).toBe("true");
    expect(colourPill(p, "cyan").getAttribute("aria-pressed")).toBe("false");

    click(p, sheetButton(p, "Save Changes"));
    expect(readState(p).quests[0]).toEqual(
      expect.objectContaining({ title: "Launch v2", description: "Ship the beta", targetWeeklyHours: 7, accentColor: "amber" })
    );
    expect(toastTexts(p)).toEqual(["Quest saved"]);
    expect(pageErrors(p)).toEqual([]);
  });

  it.each(DISMISS)("a pristine Edit Quest or New Quest closed with %s shows no toast", (_label, dismiss) => {
    const p = load({ seedState: baseState() });
    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Changed";
    field(p, "sheetQuestTitle").value = "Launch"; // typed and taken back: nothing changed
    dismiss(p);
    p.openNewQuestSheet();
    dismiss(p);
    expect(sheetKind(p)).toBeNull();
    expect(liveToasts(p)).toEqual([]);
  });

  it("New Quest: typed values come back with Restore, stay 'changed', and Create clears them without a toast", () => {
    const p = load({ seedState: baseState() });
    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "Learn Rust";
    click(p, colourPill(p, "emerald"));
    p.__huntBack();
    click(p, liveToasts(p)[0].querySelector(".toast-action"));
    expect(sheetKind(p)).toBe("newQuest");
    expect(field(p, "newQuestTitleInput").value).toBe("Learn Rust");
    p.__huntBack(); // still different from the empty form: offered again
    expect(toastTexts(p)).toEqual(["Quest edits discarded"]);
    click(p, liveToasts(p)[0].querySelector(".toast-action"));
    click(p, sheetButton(p, "Create Quest"));
    const created = readState(p).quests.find((q) => q.title === "Learn Rust");
    expect(created?.accentColor).toBe("emerald");
    expect(toastTexts(p)).toEqual(["Quest created · Learn Rust"]);
  });

  it("Delete Quest closes a changed form without a 'discarded' toast (only its own Undo)", () => {
    const p = load({ seedState: baseState() });
    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Renamed";
    click(p, sheetButton(p, "Delete Quest"));
    expect(toastTexts(p)).toEqual([expect.stringContaining("Quest deleted")]);
    expect(sheetKind(p)).toBeNull();
  });

  it("Restore after the quest was deleted meanwhile opens nothing and throws nothing", () => {
    const p = load({ seedState: baseState() });
    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Renamed";
    p.closeSheet();
    p.deleteQuestItem("quest-1");
    const restore = liveToasts(p).find((t) => t.textContent?.includes("Quest edits discarded"));
    click(p, restore?.querySelector(".toast-action") ?? null);
    expect(sheetKind(p)).toBeNull();
    expect(pageErrors(p)).toEqual([]);
  });

  it("a Restore that has nothing to reopen does not dismiss the sheet the user is typing in", () => {
    const p = load({ seedState: baseState() });
    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Renamed";
    p.closeSheet();
    const restore = must(
      liveToasts(p).find((t) => t.textContent?.includes("Quest edits discarded")),
      "'Quest edits discarded' toast"
    );
    p.deleteQuestItem("quest-1"); // e.g. deleted on the laptop and synced in
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "Typing";
    click(p, restore.querySelector(".toast-action"));
    expect(sheetKind(p)).toBe("newTask");
    expect(field(p, "sheetTaskTitle").value).toBe("Typing");
    expect(pageErrors(p)).toEqual([]);
  });

  it("New Task × with text: 'Draft discarded'; Restore reopens the sheet with it; × on an empty form shows nothing", () => {
    const p = load({ seedState: baseState() });
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "Call the bank";
    field(p, "sheetTaskNotes").value = "before 4pm";
    click(p, p.document.querySelector("#sheetContainer .sheet-close"));
    expect(sheetKind(p)).toBeNull();
    expect(p.localStorage.getItem(DRAFT_KEY)).toBeNull();
    const [toast] = liveToasts(p);
    expect(toast.querySelector(".toast-msg")?.textContent).toBe("Draft discarded");
    click(p, toast.querySelector(".toast-action"));
    expect(sheetKind(p)).toBe("newTask");
    expect(field(p, "sheetTaskTitle").value).toBe("Call the bank");
    expect(field(p, "sheetTaskNotes").value).toBe("before 4pm");
    expect(p.localStorage.getItem(DRAFT_KEY)).toContain("Call the bank");
    click(p, sheetButton(p, "↑ Add to Top (#1)"));
    expect(readState(p).tasks.some((t) => t.title === "Call the bank" && t.notes === "before 4pm")).toBe(true);

    p.openNewTaskSheet();
    click(p, p.document.querySelector("#sheetContainer .sheet-close"));
    expect(toastTexts(p).filter((t) => t === "Draft discarded")).toEqual([]);
  });

  it("spam taps: ten Undo taps restore once, ten Restore taps open the form once", () => {
    const p = load({ seedState: baseState() });
    const id = log(1).id;
    p.deleteLogItem(id);
    const undo = one(p, "#toastHost .toast-action");
    for (let i = 0; i < 10; i++) click(p, undo);
    expect(readState(p).timeLogs.filter((l) => l.id === id)).toHaveLength(1);
    expect(readState(p).deletedLogIds).toEqual([]);

    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestTitle").value = "Twice";
    p.__huntBack();
    const restore = must(
      liveToasts(p).find((t) => t.textContent?.includes("Quest edits discarded")),
      "'Quest edits discarded' toast"
    ).querySelector(".toast-action");
    for (let i = 0; i < 10; i++) click(p, restore);
    expect(sheetKind(p)).toBe("quest:quest-1");
    expect(field(p, "sheetQuestTitle").value).toBe("Twice");
    expect(toastTexts(p).filter((t) => t === "Quest edits discarded")).toEqual([]);
    expect(pageErrors(p)).toEqual([]);
  });

  it("seeded monkey: random edits, dismissals, Restores, saves and time never change a quest except by Save", () => {
    const seed = 20261118;
    const rnd = seededRandom(seed);
    const pick = (n: number) => Math.floor(rnd() * n);
    const p = load({ seedState: baseState() });
    let saved = "Launch";
    const done = { dismissed: 0, restored: 0, saves: 0 };
    for (let step = 0; step < 250; step++) {
      const at = `seed ${seed}, step ${step}`;
      const editing = sheetKind(p) === "quest:quest-1";
      const action = pick(10);
      if (action === 0) p.openQuestEditorSheet("quest-1");
      else if (action <= 2 && editing) field(p, "sheetQuestTitle").value = pick(3) === 0 ? "   " : "Title " + step;
      else if (action <= 4 && sheetKind(p)) {
        DISMISS[pick(DISMISS.length)][1](p);
        done.dismissed++;
      } else if (action <= 6) {
        const actions = Array.from(p.document.querySelectorAll("#toastHost .toast:not(.leaving) .toast-action"));
        const target = actions.length ? actions[pick(actions.length)] : null;
        if (target) {
          for (let i = 0, n = 1 + pick(3); i < n; i++) click(p, target);
          done.restored++;
        }
      } else if (action === 7 && editing) {
        saved = field(p, "sheetQuestTitle").value.trim() || saved; // a blank title keeps the old one
        click(p, sheetButton(p, "Save Changes"));
        done.saves++;
      } else if (action === 8) vi.advanceTimersByTime(pick(1500));
      else if (action === 9) vi.advanceTimersByTime(pick(7000)); // toasts run out
      expect(readState(p).quests.map((q) => q.title), at).toEqual([saved]);
      if (sheetKind(p) !== null) expect(p.document.querySelectorAll("#sheetContainer .bottom-sheet"), at).toHaveLength(1);
      expect(pageErrors(p), at).toEqual([]);
    }
    for (const [what, n] of Object.entries(done)) expect(n, `seed ${seed}: ${what}`).toBeGreaterThan(5);
  });

  it("Back keeps a New Task draft (no toast); restoring an older draft over it offers that one back", () => {
    const p = load({ seedState: baseState() });
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "Draft A";
    click(p, p.document.querySelector("#sheetContainer .sheet-close"));
    const restoreA = liveToasts(p)[0].querySelector(".toast-action");
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "Draft B";
    p.__huntBack();
    expect(toastTexts(p)).toEqual(["Draft discarded"]); // Back kept B as the draft: no new toast
    click(p, restoreA);
    expect(field(p, "sheetTaskTitle").value).toBe("Draft A");
    const offerB = liveToasts(p).find((t) => t.textContent?.includes("Draft discarded"));
    click(p, offerB?.querySelector(".toast-action") ?? null);
    expect(sheetKind(p)).toBe("newTask");
    expect(field(p, "sheetTaskTitle").value).toBe("Draft B");
  });
});

describe("Enter submits the quest forms (MUI-08)", () => {
  it("Enter in the New Quest title creates the quest; a blank title creates none", () => {
    const p = load({ seedState: baseState() });
    p.openNewQuestSheet();
    const title = field(p, "newQuestTitleInput");
    expect(title.getAttribute("enterkeyhint")).toBe("done");
    title.value = "   ";
    pressKey(p, title, { key: "Enter" });
    expect(readState(p).quests).toHaveLength(1);
    expect(sheetKind(p)).toBe("newQuest");

    title.value = "Ship it";
    const e = pressKey(p, title, { key: "Enter" });
    expect(e.defaultPrevented).toBe(true);
    expect(readState(p).quests.map((q) => q.title)).toEqual(["Launch", "Ship it"]);
    expect(sheetKind(p)).toBeNull();
  });

  it("Enter in the target field submits; in the description it adds a line, Ctrl/Cmd+Enter submits", () => {
    const p = load({ seedState: baseState() });
    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "One";
    const desc = field(p, "newQuestDescInput");
    expect(pressKey(p, desc, { key: "Enter" }).defaultPrevented).toBe(false);
    expect(pressKey(p, desc, { key: "Enter", isComposing: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(sheetKind(p)).toBe("newQuest");
    pressKey(p, desc, { key: "Enter", ctrlKey: true });
    expect(readState(p).quests.map((q) => q.title)).toContain("One");

    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "Two";
    field(p, "newQuestTargetInput").value = "3";
    pressKey(p, field(p, "newQuestTargetInput"), { key: "Enter" });
    expect(readState(p).quests.find((q) => q.title === "Two")?.targetWeeklyHours).toBe(3);

    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "Three";
    pressKey(p, field(p, "newQuestDescInput"), { key: "Enter", metaKey: true });
    expect(readState(p).quests.map((q) => q.title)).toContain("Three");
  });

  it("Enter in Edit Quest saves exactly the quest on screen (id with '.' and ':' passed via jsArg)", () => {
    const p = load({ seedState: baseState({ quests: [quest("quest-1", "Launch"), quest("quest-1.a:b", "Target")] }) });
    p.openQuestEditorSheet("quest-1.a:b");
    const title = field(p, "sheetQuestTitle");
    expect(title.getAttribute("enterkeyhint")).toBe("done");
    title.value = "Target renamed";
    pressKey(p, title, { key: "Enter" });
    const titles = Object.fromEntries(readState(p).quests.map((q) => [q.id, q.title]));
    expect(titles).toEqual({ "quest-1": "Launch", "quest-1.a:b": "Target renamed" });
    expect(sheetKind(p)).toBeNull();

    p.openQuestEditorSheet("quest-1");
    field(p, "sheetQuestDesc").value = "multi\nline";
    pressKey(p, field(p, "sheetQuestDesc"), { key: "Enter", ctrlKey: true });
    expect(readState(p).quests.find((q) => q.id === "quest-1")?.description).toBe("multi\nline");
  });

  it("Ctrl+Enter in the New Task notes adds the task", () => {
    const p = load({ seedState: baseState() });
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "From notes";
    pressKey(p, field(p, "sheetTaskNotes"), { key: "Enter", ctrlKey: true });
    expect(readState(p).tasks.some((t) => t.title === "From notes")).toBe(true);
  });
});

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
function cssText(p: MobileWindow): string {
  return p.document.querySelector("style")?.textContent ?? "";
}
/** Body of the brace block that starts right after `head` (handles nested @media blocks). */
function block(css: string, head: string, from = 0): string {
  const at = css.indexOf(head + " {", from);
  if (at < 0) throw new Error("no CSS block " + head);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error("unclosed CSS block " + head);
}
/** px value of `prop` inside the rule `selector` (in `css`). */
function declPx(css: string, selector: string, prop: string): number {
  const m = new RegExp(`(?:^|[\\s;])${prop}\\s*:\\s*(-?[\\d.]+)px`).exec(block(css, selector));
  if (!m) throw new Error(`no ${prop} in ${selector}`);
  return Number(m[1]);
}

describe("touch targets (MUI-02)", () => {
  it("--touch-min is 48px and the shared invisible hit area uses it", () => {
    const p = load({ seedState: baseState() });
    expect(p.getComputedStyle(p.document.documentElement).getPropertyValue("--touch-min").trim()).toBe("48px");
    const hit = block(cssText(p), ".log-delete-btn::after");
    expect(hit).toContain("width: max(100%, var(--touch-min))");
    expect(hit).toContain("height: max(100%, var(--touch-min))");
  });

  it("segmented options, toast and empty-state actions, sheet and inspector buttons are at least 48px", () => {
    const p = load({ seedState: baseState() });
    const atLeast48 = (el: Element | null, label: string) => {
      if (!el) throw new Error("missing " + label);
      const cs = p.getComputedStyle(el);
      expect(Math.max(px(cs.minHeight), px(cs.height)), label).toBeGreaterThanOrEqual(48);
    };
    p.document.querySelectorAll(".seg-option").forEach((el, i) => atLeast48(el, ".seg-option " + i));
    atLeast48(p.document.querySelector(".btn-primary-focus"), ".btn-primary-focus");
    atLeast48(p.document.querySelector(".btn-complete-circle"), ".btn-complete-circle");
    atLeast48(p.document.querySelector(".brand-row"), ".brand-row");
    p.deleteLogItem(log(1).id);
    atLeast48(p.document.querySelector(".toast-action"), ".toast-action");

    p.openTaskInspectorSheet("tsk-1");
    for (const label of ["▶ Start Focus", "↑ Move to #1"]) atLeast48(sheetButton(p, label), label);
    atLeast48(p.document.querySelector("#sheetContainer .text-action"), "Mark Completed");
    atLeast48(p.document.querySelector("#sheetContainer .danger-outline-btn"), "Delete Task");
    p.openNewTaskSheet();
    for (const label of ["↑ Add to Top (#1)", "↓ Add to Bottom"]) atLeast48(sheetButton(p, label), label);
    p.openNewQuestSheet();
    atLeast48(sheetButton(p, "Create Quest"), "Create Quest");
    p.openQuestEditorSheet("quest-1");
    for (const label of ["Delete Quest", "Save Changes"]) atLeast48(sheetButton(p, label), label);
    p.openSyncSheet();
    atLeast48(p.document.getElementById("syncNowBtn"), "Sync Now");
    p.initializeFocus("tsk-1");
    const focusButtons = Array.from(p.document.querySelectorAll(".focus-actions button"));
    expect(focusButtons.map((b) => b.textContent?.trim())).toEqual(["Pause", "Complete"]);
    focusButtons.forEach((b, i) => atLeast48(b, "Focus action " + i));
    p.close();

    const empty = load({ seedState: baseState({ quests: [], tasks: [], timeLogs: [] }) });
    const actions = empty.document.querySelectorAll(".empty-action");
    expect(actions.length).toBeGreaterThan(0);
    actions.forEach((el, i) => {
      expect(px(empty.getComputedStyle(el).minHeight), "empty-action " + i).toBeGreaterThanOrEqual(48);
    });
  });

  it("small controls' expanders reach 48 x 48 without overlapping their neighbours", () => {
    const p = load({ seedState: baseState() });
    const css = cssText(p);
    // mini play (32 high; at least 34 wide: 1 px borders, 10 px padding, 12 px icon) and the options
    // dots (30 x 30), 8 px apart
    expect(declPx(css, ".mini-play-btn", "height") - 2 * declPx(css, ".mini-play-btn::after", "top")).toBeGreaterThanOrEqual(48);
    expect(34 - declPx(css, ".mini-play-btn::after", "left") - declPx(css, ".mini-play-btn::after", "right")).toBeGreaterThanOrEqual(48);
    expect(30 - 2 * declPx(css, ".more-dots-btn::after", "top")).toBeGreaterThanOrEqual(48);
    expect(30 - declPx(css, ".more-dots-btn::after", "left") - declPx(css, ".more-dots-btn::after", "right")).toBeGreaterThanOrEqual(48);
    expect(-declPx(css, ".mini-play-btn::after", "right") - declPx(css, ".more-dots-btn::after", "left")).toBeLessThanOrEqual(8);
    // sheet pills: 40 px + 4 px above and below, 8 px gap between rows
    expect(declPx(css, ".sheet-pill", "min-height") - 2 * declPx(css, ".sheet-pill::after", "top")).toBeGreaterThanOrEqual(48);
    expect(-2 * declPx(css, ".sheet-pill::after", "top")).toBeLessThanOrEqual(declPx(css, ".sheet-pill-group", "gap"));
    // the check ring (22 px) grows into the card's 18 px left padding, not past the gap to the title
    const ringLeft = -declPx(css, ".task-check-ring::after", "left");
    const ringExtra = Number(/width:\s*calc\(100% \+ (\d+)px\)/.exec(block(css, ".task-check-ring::after"))?.[1]);
    expect(22 + ringExtra).toBeGreaterThanOrEqual(48);
    expect(ringLeft).toBeLessThan(18);
    expect(ringExtra - ringLeft).toBeLessThanOrEqual(declPx(css, ".queue-item-card", "gap"));
    // the filter strip leaves room for the pills' 48 px targets (30 px pills)
    expect(30 + 2 * declPx(css, ".chip-strip", "padding")).toBeGreaterThanOrEqual(48);
    // the session-log rows are 49 px apart, so the 48 px delete targets of two rows never overlap
    p.switchView("telemetry");
    click(p, Array.from(p.document.querySelectorAll("#mainContainer .text-action")).pop() ?? null);
    const row = must(one(p, ".log-delete-btn").closest("div[style*='border-bottom']"), "session-log row");
    expect(px(p.getComputedStyle(row).paddingTop)).toBeGreaterThanOrEqual(14);
  });

  it("landscape keeps the compact look with 48 px targets: segmented control, nav and FAB", () => {
    const p = load();
    const landscape = block(cssText(p), "@media (max-height: 480px)");
    expect(declPx(landscape, ".seg-option", "min-height") - declPx(landscape, ".seg-option::after", "top") - declPx(landscape, ".seg-option::after", "bottom")).toBeGreaterThanOrEqual(48);
    const nav = block(landscape, ".bottom-nav-bar");
    expect(nav).toContain("height: calc(52px + var(--safe-bottom))");
    expect(nav).toContain("padding: 2px");
    expect(block(landscape, ".fab-add")).toContain("height: var(--touch-min)");
  });
});

describe("long unbroken titles (MUI-05)", () => {
  const LONG = "X".repeat(300);
  function longState() {
    return baseState({
      quests: [quest("quest-1", LONG, "cyan", { description: LONG })],
      tasks: [task("tsk-1", LONG), task("tsk-2", LONG, { rank: 1000 }), task("tsk-3", LONG, { status: "completed", completedAt: NOW })],
    });
  }

  it("titles, descriptions and pills wrap anywhere; the Edit and options buttons never shrink", () => {
    const p = load({ seedState: longState() });
    const wraps = (sel: string) => {
      const el = p.document.querySelector(sel);
      if (!el) throw new Error("missing " + sel);
      expect(p.getComputedStyle(el).overflowWrap, sel).toBe("anywhere");
    };
    wraps(".spotlight-title");
    wraps(".queue-item-title");
    wraps(".queue-item-card.completed .queue-item-title");
    wraps(".queue-item-sub");
    expect(p.getComputedStyle(one(p, ".more-dots-btn")).flexShrink).toBe("0");

    p.switchView("quests");
    const edit = one(p, ".mini-chip-btn");
    expect(edit.textContent).toBe("Edit");
    expect(p.getComputedStyle(edit).flexShrink).toBe("0");
    const heading = one(p, ".review-card h2");
    expect(p.getComputedStyle(heading).overflowWrap).toBe("anywhere");
    expect(px(p.getComputedStyle(must(heading.parentElement, "quest header")).minWidth)).toBe(0);
    expect(p.getComputedStyle(one(p, ".review-card p")).overflowWrap).toBe("anywhere");

    p.openTaskInspectorSheet("tsk-1");
    const pill = one(p, "#sheetContainer .sheet-pill");
    expect(p.getComputedStyle(pill).maxWidth).toBe("100%");
    expect(p.getComputedStyle(pill).overflowWrap).toBe("anywhere");
    expect(p.getComputedStyle(must(pill.firstElementChild, "pill dot")).flexShrink).toBe("0");
    p.closeSheet();

    p.initializeFocus("tsk-1");
    wraps(".focus-task-title");
    wraps(".focus-quest-pill");
    expect(p.getComputedStyle(one(p, ".focus-quest-pill")).maxWidth).toBe("100%");
    const header = one(p, ".focus-stage > div > div > span:last-child");
    expect(p.getComputedStyle(header).textOverflow).toBe("ellipsis");
    expect(p.getComputedStyle(one(p, ".focus-stage .icon-circle-btn")).flexShrink).toBe("0");
    expect(pageErrors(p)).toEqual([]);
  });
});

type Rgba = [number, number, number, number];
function parseColor(text: string): Rgba {
  const s = text.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const [r, g, b, a] = fn[1].split(",").map((v) => Number(v.trim()));
    return [r, g, b, a === undefined || Number.isNaN(a) ? 1 : a];
  }
  throw new Error("unparsed colour " + text);
}
/** `top` painted over an opaque `bottom` with `alpha` (default: top's own alpha). */
function over(top: Rgba, bottom: Rgba, alpha = top[3]): Rgba {
  const mix = (i: 0 | 1 | 2) => top[i] * alpha + bottom[i] * (1 - alpha);
  return [mix(0), mix(1), mix(2), 1];
}
function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("WCAG AA contrast (MUI-06)", () => {
  it("the contrast helper matches known WCAG values", () => {
    expect(contrast(parseColor("#000000"), parseColor("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(parseColor("#777777"), parseColor("#ffffff"))).toBeCloseTo(4.48, 2);
    expect(contrast(parseColor("#64748b"), parseColor("#08090c"))).toBeLessThan(4.5); // slate text: the finding
  });

  function rootColor(p: MobileWindow, name: string): Rgba {
    return parseColor(p.getComputedStyle(p.document.documentElement).getPropertyValue(name));
  }

  it("completed cards: dimmed to 0.75, their muted text keeps 4.5:1 (0.55 did not)", () => {
    const p = load({ seedState: baseState({ tasks: [task("tsk-1", "Done", { status: "completed", completedAt: NOW })] }) });
    const card = one(p, ".queue-item-card.completed");
    const cs = p.getComputedStyle(card);
    const opacity = Number(cs.opacity);
    expect(opacity).toBe(0.75);
    const pageBg = parseColor(p.getComputedStyle(p.document.body).backgroundColor);
    const cardBg = over(parseColor(cs.backgroundColor), pageBg);
    const text = parseColor(p.getComputedStyle(one(p, ".queue-item-title", card)).color);
    const shown = (op: number) => contrast(over(text, pageBg, op), over(cardBg, pageBg, op));
    expect(shown(opacity)).toBeGreaterThanOrEqual(4.5);
    expect(shown(0.55)).toBeLessThan(4.5);
  });

  it("the selected route's address uses --muted and keeps 4.5:1 on the selected pill", () => {
    const p = load();
    p.openSyncSheet();
    const addr = one(p, ".route-pill.selected .route-addr");
    expect(parseColor(p.getComputedStyle(addr).color)).toEqual(rootColor(p, "--muted"));
    const sheetBg = parseColor(p.getComputedStyle(one(p, ".bottom-sheet")).backgroundColor);
    const pillBg = over(parseColor(p.getComputedStyle(must(addr.parentElement, "route pill")).backgroundColor), sheetBg);
    expect(contrast(parseColor(p.getComputedStyle(addr).color), pillBg)).toBeGreaterThanOrEqual(4.5);
  });

  it("placeholders use --dim (a ::placeholder rule exists) and keep 4.5:1 on the field backgrounds", () => {
    const p = load({ seedState: baseState() });
    const rules = Array.from(p.document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules));
    const placeholder = rules.find(
      (r): r is CSSStyleRule => r instanceof p.CSSStyleRule && r.selectorText.includes("::placeholder")
    );
    expect(must(placeholder, "::placeholder rule").style.getPropertyValue("color")).toBe("var(--dim)");
    const dim = rootColor(p, "--dim");
    p.openNewTaskSheet();
    const fieldBg = parseColor(p.getComputedStyle(field(p, "sheetTaskTitle")).backgroundColor);
    expect(contrast(dim, fieldBg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dim, rootColor(p, "--surface"))).toBeGreaterThanOrEqual(4.5); // the Focus notes field
  });

  it("the running state of a task without a quest is --muted (slate was 4.19:1); quest colours stay", () => {
    const p = load({ seedState: baseState({ tasks: [task("tsk-1", "Other", { questId: null }), task("tsk-2", "Quest", { rank: 1000 })] }) });
    p.initializeFocus("tsk-1");
    const state = () => p.getComputedStyle(one(p, ".focus-state")).color;
    expect(parseColor(state())).toEqual(rootColor(p, "--muted"));
    expect(contrast(parseColor(state()), rootColor(p, "--bg"))).toBeGreaterThanOrEqual(4.5);
    p.initializeFocus("tsk-2");
    expect(parseColor(state())).toEqual(rootColor(p, "--cyan"));
  });
});

describe("narrow header (MUI-11)", () => {
  it("the mute button and the live timer never shrink; at <= 340 px the bar and the sync chip give way", () => {
    const p = load({ seedState: baseState() });
    expect(p.getComputedStyle(one(p, "#muteBtn")).flexShrink).toBe("0");
    expect(p.getComputedStyle(one(p, "#activeHeaderPill")).flexShrink).toBe("0");
    const narrow = block(cssText(p), "@media (max-width: 340px)");
    expect(block(narrow, ".app-bar")).toContain("padding-left: calc(12px + var(--safe-left))");
    expect(block(narrow, "#syncChipBtn")).toContain("min-width: 0");
  });
});

describe("zoom and side safe areas (MUI-12)", () => {
  it("pinch-zoom is allowed; the fixed chrome respects the left/right insets; sheet fields are 16 px", () => {
    const p = load({ seedState: baseState() });
    const viewport = p.document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toMatch(/user-scalable|maximum-scale/);
    const css = cssText(p);
    const root = block(css, ":root");
    expect(root).toContain("--safe-left: env(safe-area-inset-left, 0px)");
    expect(root).toContain("--safe-right: env(safe-area-inset-right, 0px)");
    for (const sel of [".app-bar", ".bottom-nav-bar", ".toast-host"]) {
      const body = block(css, sel);
      expect(body, sel).toContain("var(--safe-left)");
      expect(body, sel).toContain("var(--safe-right)");
    }
    expect(block(css, ".fab-add")).toContain("right: calc(18px + var(--safe-right))");
    expect(block(block(css, "@media (max-height: 480px)"), ".bottom-nav-bar")).toContain("var(--safe-left)");

    const sheets: [string, () => void][] = [
      ["New Task", () => p.openNewTaskSheet()],
      ["Task Options", () => p.openTaskInspectorSheet("tsk-1")],
      ["New Quest", () => p.openNewQuestSheet()],
      ["Edit Quest", () => p.openQuestEditorSheet("quest-1")],
      ["Sync", () => p.openSyncSheet()],
    ];
    for (const [label, open] of sheets) {
      open();
      const inputs = p.document.querySelectorAll("#sheetContainer .sheet-input");
      expect(inputs.length, label).toBeGreaterThan(0);
      inputs.forEach((el) => expect(p.getComputedStyle(el).fontSize, label).toBe("16px"));
      p.closeSheet();
    }
  });
});

describe("browser copy sync routes (P01 request)", () => {
  it("a saved cross-origin laptop address is tried first, then the laptop that served the page", async () => {
    const origin = "http://100.64.0.9:3000";
    const net = recorder((c) => {
      if (c.url.startsWith(origin + "/")) return jsonResponse(200, okBody());
      return Promise.reject(new TypeError("Failed to fetch")); // CORS: the laptop allows no other origin
    });
    const p = load({ url: origin + "/hunt-mobile.html", storage: { [LAPTOP_URL_KEY]: "http://192.168.1.5:3000" }, fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.calls.map((c) => c.url)).toEqual(["http://192.168.1.5:3000/api/sync", origin + "/api/sync"]);
    expect(p.getSyncStatus()).toEqual(expect.objectContaining({ phase: "ok", lastUrl: origin }));
  });

  it("the APK never adds the page's own origin to its routes", async () => {
    const routes: string[][] = [];
    load({
      bridge: {
        getLaptopUrl: () => "http://192.168.1.5:3000",
        syncWithLaptopAsync: (_id, candidatesJson) => {
          const parsed: unknown = JSON.parse(candidatesJson);
          routes.push(isStringArray(parsed) ? parsed : []);
          return true;
        },
      },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(routes).toHaveLength(1);
    expect(routes[0][0]).toBe("http://192.168.1.5:3000");
    expect(routes[0]).not.toContain("http://localhost");
  });
});

describe("mobile Home scheduled-day filter & non-auto-start Focus completion", () => {
  const twoTaskSeed = () => ({
    quests: [quest("quest-1", "Core")],
    tasks: [
      task("tsk-1", "Write spec", { rank: 1000, scheduledDate: localKey(NOW) }),
      task("tsk-2", "Ship build", { rank: 2000, scheduledDate: localKey(NOW) }),
    ],
  });

  it("hides tasks scheduled for a future day on Today while keeping them in Plan", () => {
    const p = load({ seedState: twoTaskSeed() });
    const tomorrowKey = p.dayKeyOffset(1);
    p.updateTaskField("tsk-1", "scheduledDate", tomorrowKey);
    p.switchView("command");

    const mainText = p.document.getElementById("mainContainer")?.textContent ?? "";
    expect(mainText).not.toContain("Write spec");
    expect(mainText).toContain("Ship build");

    // Moving to tomorrow in Plan still shows the task under tomorrow's day column
    p.switchView("plan");
    p.eval(`selectedPlanDateKey = ${JSON.stringify(tomorrowKey)}; renderApp();`);
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("Write spec");
  });

  it("completing a task in Focus stops the session and offers Start Focus Session for the next task instead of auto-starting", () => {
    const p = load({ seedState: twoTaskSeed() });
    p.initializeFocus("tsk-1");
    expect(p.document.body.getAttribute("data-view")).toBe("focus");

    p.completeActiveTaskAndNext();

    const s = readState(p);
    expect(s.activeFocus.activeTaskId).toBeNull();
    expect(s.activeFocus.isRunning).toBe(false);
    expect(s.tasks.find((t) => t.id === "tsk-1")?.status).toBe("completed");
    expect(s.tasks.find((t) => t.id === "tsk-2")?.status).toBe("queued");

    // Stays in Focus mode offering the next task with an explicit Start button and Back to Today
    expect(p.document.body.getAttribute("data-view")).toBe("focus");
    const mainText = p.document.getElementById("mainContainer")?.textContent ?? "";
    expect(mainText).toContain("Ship build");
    expect(mainText).toContain("Start Focus Session");
    expect(mainText).toContain("Back to Today");
  });
});

describe("smooth keyboard sheets and long-name aesthetics", () => {
  it("__huntSetIme updates --kb and keyboard-open cleanly and clamps invalid inputs", () => {
    const p = load({ seedState: baseState() });
    p.eval("window.__huntSetIme(318.4)");
    expect(p.document.documentElement.style.getPropertyValue("--kb")).toBe("318px");
    expect(p.document.body.classList.contains("keyboard-open")).toBe(true);

    p.eval("window.__huntSetIme(0)");
    expect(p.document.documentElement.style.getPropertyValue("--kb")).toBe("0px");
    expect(p.document.body.classList.contains("keyboard-open")).toBe(false);

    // Hostile / non-finite / negative values clamp safely
    p.eval("window.__huntSetIme(-42)");
    expect(p.document.documentElement.style.getPropertyValue("--kb")).toBe("0px");
    p.eval("window.__huntSetIme(Number.NaN)");
    expect(p.document.documentElement.style.getPropertyValue("--kb")).toBe("0px");
    p.eval("window.__huntSetIme(99999)");
    expect(p.document.documentElement.style.getPropertyValue("--kb")).toBe("1200px");
    expect(p.document.body.classList.contains("keyboard-open")).toBe(true);
    expect(pageErrors(p)).toEqual([]);
  });

  it("composer sheets toggle body.sheet-open and focus their title input synchronously inside the tap gesture", () => {
    const p = load({ seedState: baseState() });
    expect(p.document.body.classList.contains("sheet-open")).toBe(false);

    p.openNewTaskSheet();
    expect(p.document.body.classList.contains("sheet-open")).toBe(true);
    expect(p.document.activeElement?.id).toBe("sheetTaskTitle");
    p.closeSheet();
    expect(p.document.body.classList.contains("sheet-open")).toBe(false);

    p.openNewQuestSheet();
    expect(p.document.body.classList.contains("sheet-open")).toBe(true);
    expect(p.document.activeElement?.id).toBe("newQuestTitleInput");
    p.closeSheet();
    expect(p.document.body.classList.contains("sheet-open")).toBe(false);

    p.eval("openNewHabitSheet()");
    expect(p.document.body.classList.contains("sheet-open")).toBe(true);
    expect(p.document.activeElement?.id).toBe("newHabitTitleInput");
    p.closeSheet();
    expect(p.document.body.classList.contains("sheet-open")).toBe(false);
  });

  it("renders long quest, task, and habit names with balanced alignment, ellipsized metadata pills, and clean Review bars", () => {
    const longQuestTitle = "Study Machine Learning And Robotics Fundamentals Every Single Week";
    const longTaskTitle = "Read Chapter Four On Bayesian Optimization And Implement Acquisition Functions";
    const longHabitTitle = "Practice Thirty Minutes Of Deep Focused Technical Reading Without Distractions";
    const p = load({
      seedState: baseState({
        quests: [quest("quest-1", longQuestTitle, "cyan")],
        tasks: [
          task("tsk-1", longTaskTitle, { rank: 1000 }),
          task("tsk-2", longTaskTitle + " (Part 2)", { rank: 2000 }),
        ],
        habits: [
          { id: "hab-1", title: longHabitTitle, questId: "quest-1", rank: 1000, createdAt: NOW, updatedAt: NOW },
        ],
        timeLogs: [log(1)],
      }),
    });

    // Today filter pill caps width with ellipsis so a single quest pill doesn't swallow the strip
    const filterLabel = one(p, ".filter-pill > span:last-child");
    expect(p.getComputedStyle(filterLabel).textOverflow).toBe("ellipsis");
    expect(p.getComputedStyle(filterLabel).maxWidth).toBe("168px");

    // Task queue card aligns checkbox to the top line and ellipsizes the quest subtitle cleanly
    const card = one(p, ".queue-item-card");
    expect(p.getComputedStyle(card).alignItems).toBe("flex-start");
    const questSub = one(p, ".queue-item-card .quest-label-ellipsis");
    expect(p.getComputedStyle(questSub).textOverflow).toBe("ellipsis");
    expect(p.getComputedStyle(questSub).whiteSpace).toBe("nowrap");

    // Habits view renders long habit title + ellipsized quest pill without crushing the 7-day dots
    p.switchView("habits");
    const habitCard = one(p, ".queue-item-card");
    expect(habitCard.textContent).toContain(longHabitTitle);
    const habitQuestLabel = one(p, ".quest-label-ellipsis", habitCard);
    expect(p.getComputedStyle(habitQuestLabel).textOverflow).toBe("ellipsis");

    // Review view Hours by Quest stacks quest name + hours above a full-width progress bar
    p.switchView("review");
    const reviewText = p.document.getElementById("mainContainer")?.textContent ?? "";
    expect(reviewText).toContain(longQuestTitle);
    expect(pageErrors(p)).toEqual([]);
  });

  it("records bounded redacted diagnostics breadcrumbs and sends X-Hunt-Correlation-Id on mobile sync", async () => {
    const seenHeaders: Array<Record<string, string>> = [];
    const fetchImpl = (_url: string, init?: FetchInit) => {
      seenHeaders.push(init?.headers ?? {});
      return Promise.resolve(jsonResponse(200, okBody()));
    };
    const p = load({ url: "http://192.168.1.5:3000/hunt-mobile.html", fetchImpl });
    await vi.advanceTimersByTimeAsync(1000);

    expect(seenHeaders.length).toBeGreaterThanOrEqual(1);
    expect(seenHeaders[0]["x-hunt-correlation-id"] || seenHeaders[0]["X-Hunt-Correlation-Id"]).toBeTruthy();

    // Redaction + bounded circular buffer check
    const check = p.eval(`(() => {
      for (let i = 0; i < 150; i++) {
        window.__huntDiagnostics.record("DEBUG", "test", "evt_" + i, { token: "secret-" + i, msg: "Bearer mysecrettoken123" });
      }
      const trail = window.__huntDiagnostics.getBreadcrumbs();
      return { len: trail.length, last: trail[trail.length - 1] };
    })()`) as { len: number; last: { context?: { token?: string; msg?: string } } };

    expect(check.len).toBe(120);
    expect(check.last.context?.token).toBe("[REDACTED]");
    expect(check.last.context?.msg).toBe("Bearer [REDACTED]");
    expect(pageErrors(p)).toEqual([]);
  });

  it("applies .just-completed animation class once on task completion and sets inert on background during sheets", () => {
    const p = load({
      seedState: baseState({
        quests: [quest("quest-1", "Core")],
        tasks: [
          task("tsk-1", "Animate me", { rank: 1000, scheduledDate: localKey(NOW) }),
          task("tsk-2", "Keep queued", { rank: 2000, scheduledDate: localKey(NOW) }),
        ],
      }),
    });

    p.completeTaskDirect("tsk-1");
    const completedCard = one(p, ".queue-item-card.completed");
    expect(completedCard.classList.contains("just-completed")).toBe(true);

    // Subsequent re-renders do not replay the one-shot arrival animation
    p.renderApp();
    const afterRerender = one(p, ".queue-item-card.completed");
    expect(afterRerender.classList.contains("just-completed")).toBe(false);
    expect(afterRerender.getAttribute("data-flip-task-id")).toBe("tsk-1");
    expect(one(p, ".spotlight-card").getAttribute("data-flip-task-id")).toBe("tsk-2");

    // Silent taps: neither switchView nor task completion triggers native vibration
    let vibrateCount = 0;
    const pSilent = load({
      seedState: baseState(),
      bridge: { vibrateClick: () => { vibrateCount++; } },
    });
    pSilent.switchView("quests");
    pSilent.switchView("command");
    pSilent.completeTaskDirect("tsk-1");
    expect(vibrateCount).toBe(0);
    pSilent.close();

    // Opening a sheet marks background landmarks inert; closing restores them
    p.openNewTaskSheet();
    for (const id of ["topHeader", "mainContainer", "fabBtn", "bottomNav"]) {
      expect(p.document.getElementById(id)?.hasAttribute("inert")).toBe(true);
    }
    p.closeSheet();
    for (const id of ["topHeader", "mainContainer", "fabBtn", "bottomNav"]) {
      expect(p.document.getElementById(id)?.hasAttribute("inert")).toBe(false);
    }
    expect(pageErrors(p)).toEqual([]);
  });

  it("completes, undoes, and reopens quests on mobile while preserving logged hours and completed tasks", () => {
    const p = load({
      seedState: baseState({
        quests: [quest("quest-1", "Ship v1", "emerald"), quest("quest-2", "Write", "cyan")],
        tasks: [
          task("tsk-open", "Open task", { questId: "quest-1", status: "queued", rank: 1000 }),
          task("tsk-done", "Finished task", {
            questId: "quest-1",
            status: "completed",
            completedAt: NOW,
            rank: 2000,
          }),
        ],
        habits: [
          {
            id: "hab-1",
            title: "Daily ship check",
            notes: "",
            questId: "quest-1",
            rank: 1000,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        timeLogs: [
          {
            id: "log-1",
            taskId: "tsk-done",
            taskTitleSnapshot: "Finished task",
            questId: "quest-1",
            questCodeSnapshot: "SHIP V1",
            accentColorSnapshot: "emerald",
            startTime: NOW - 7200_000,
            endTime: NOW,
            durationSeconds: 7200,
            dateKey: localKey(NOW),
          },
        ],
      }),
    });

    p.switchView("quests");
    p.openQuestEditorSheet("quest-1");
    expect(p.document.getElementById("sheetContainer")?.textContent).toContain("Complete Quest");

    click(p, sheetButton(p, "✓ Complete Quest"));
    let s = readState(p);
    expect(s.quests.find((q) => q.id === "quest-1")?.archived).toBe(true);
    expect(s.tasks.find((t) => t.id === "tsk-open")?.questId).toBeNull();
    expect(s.tasks.find((t) => t.id === "tsk-done")?.questId).toBe("quest-1");
    expect(p.eval(`state.habits.find(h => h.id === "hab-1")?.questId`)).toBeNull();

    const questsText = p.document.getElementById("mainContainer")?.textContent ?? "";
    expect(questsText).toContain("Completed Quests (1)");
    expect(questsText).toContain("2.0h logged");

    // Undo toast restores active quest and re-links unassigned open tasks & habits
    click(p, liveToasts(p)[0].querySelector(".toast-action"));
    s = readState(p);
    expect(s.quests.find((q) => q.id === "quest-1")?.archived).toBe(false);
    expect(s.tasks.find((t) => t.id === "tsk-open")?.questId).toBe("quest-1");
    expect(p.eval(`state.habits.find(h => h.id === "hab-1")?.questId`)).toBe("quest-1");

    // Complete again and reopen via Completed Quests Reopen button
    p.openQuestEditorSheet("quest-1");
    click(p, sheetButton(p, "✓ Complete Quest"));
    expect(readState(p).quests.find((q) => q.id === "quest-1")?.archived).toBe(true);
    click(p, one(p, 'button[aria-label="Reopen quest Ship v1"]'));
    expect(readState(p).quests.find((q) => q.id === "quest-1")?.archived).toBe(false);
    expect(p.document.getElementById("mainContainer")?.textContent).not.toContain(
      "Completed Quests"
    );
    expect(pageErrors(p)).toEqual([]);
  });
});
