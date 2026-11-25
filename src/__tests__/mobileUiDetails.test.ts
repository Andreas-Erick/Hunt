// @vitest-environment node
// Phone page details: weekly-target validation, sheet focus in/out, the Focus notes field, the Guide
// segmented control, plain sync error copy, complete-ring contrast, reduced-motion transitions, the
// native-IME field reveal, heatmap scrubbing, single-pass Quests grouping, English sync timestamps,
// and no dead audio code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, mobileHtml, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const DAY = 86_400_000;

let w: MobileWindow | null = null;
function load(options: Parameters<typeof loadMobile>[0] = {}): MobileWindow {
  w = loadMobile(options);
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

function localKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function quest(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, slotIndex: 0, title, description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1, ...extra };
}
function task(id: string, title: string, extra: Record<string, unknown> = {}) {
  return { id, title, status: "queued", rank: 0, questId: "quest-1", accumulatedSeconds: 0, updatedAt: 1, ...extra };
}
function baseState(extra: Record<string, unknown> = {}) {
  return {
    quests: [quest("quest-1", "Launch")],
    tasks: [task("tsk-1", "Write")],
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...extra,
  };
}

function one(p: MobileWindow, selector: string, root: ParentNode = p.document): HTMLElement {
  const el = root.querySelector(selector);
  if (!(el instanceof p.HTMLElement)) throw new Error("missing " + selector);
  return el;
}
function field(p: MobileWindow, id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = p.document.getElementById(id);
  if (el instanceof p.HTMLInputElement || el instanceof p.HTMLTextAreaElement) return el;
  throw new Error("missing field " + id);
}
function sheetKind(p: MobileWindow): string | null {
  const sc = p.document.getElementById("sheetContainer");
  return sc && sc.style.display !== "none" ? sc.dataset.sheet ?? null : null;
}
function sheetButton(p: MobileWindow, text: string): Element | null {
  return Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent?.trim() === text) ?? null;
}
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) };
}
function cssText(p: MobileWindow): string {
  return p.document.querySelector("style")?.textContent ?? "";
}
/** Body of the brace block that starts right after `head` (handles nested @media blocks). */
function block(css: string, head: string): string {
  const at = css.indexOf(head + " {");
  if (at < 0) throw new Error("no CSS block " + head);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error("unclosed CSS block " + head);
}

type Rgb = [number, number, number];
/** A look token written as "R G B" channels (ADR-0005). */
function channels(text: string): Rgb {
  const [r, g, b] = text.trim().split(/\s+/).map(Number);
  return [r, g, b];
}
function luminance(c: Rgb): number {
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("weekly target validation", () => {
  it("Edit Quest: a cleared or invalid target keeps the saved value; an out-of-range one is clamped to 1-100", () => {
    const p = load({ seedState: baseState({ quests: [quest("quest-1", "Launch", { targetWeeklyHours: 25 })] }) });
    const saveWith = (value: string) => {
      p.openQuestEditorSheet("quest-1");
      field(p, "sheetQuestTarget").value = value;
      click(p, sheetButton(p, "Save Changes"));
      return readState(p).quests[0].targetWeeklyHours;
    };
    expect(saveWith("")).toBe(25); // was silently reset to 10
    expect(saveWith("0")).toBe(25);
    expect(saveWith("-3")).toBe(25);
    expect(saveWith("500")).toBe(100); // was saved as-is
    expect(saveWith("12")).toBe(12);
    expect(pageErrors(p)).toEqual([]);
  });

  it("New Quest: a blank target focuses the field instead of creating; an out-of-range one is clamped", () => {
    const p = load({ seedState: baseState() });
    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "Write the book";
    field(p, "newQuestTargetInput").value = "";
    click(p, sheetButton(p, "Create Quest"));
    expect(readState(p).quests.map((q) => q.title)).toEqual(["Launch"]);
    expect(sheetKind(p)).toBe("newQuest");
    expect(p.document.activeElement?.id).toBe("newQuestTargetInput");

    field(p, "newQuestTargetInput").value = "250";
    click(p, sheetButton(p, "Create Quest"));
    expect(readState(p).quests.find((q) => q.title === "Write the book")?.targetWeeklyHours).toBe(100);
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("sheet focus", () => {
  it("a sheet without a form focuses its close button; closing returns focus to the opener", () => {
    const p = load({ seedState: baseState() });
    p.switchView("quests");
    const edit = one(p, '#mainContainer [onclick^="openQuestEditorSheet"]');
    const opener = edit.getAttribute("onclick");
    edit.focus();
    click(p, edit);
    expect(sheetKind(p)).toBe("quest:quest-1");
    expect(p.document.activeElement?.classList.contains("sheet-close")).toBe(true);

    click(p, one(p, "#sheetContainer .sheet-close"));
    expect(sheetKind(p)).toBeNull();
    expect(p.document.activeElement).toBe(edit);

    // Save re-renders the view (the opener node is replaced): focus lands on the new Edit button.
    edit.focus();
    click(p, edit);
    field(p, "sheetQuestTitle").value = "Launch v2";
    click(p, sheetButton(p, "Save Changes"));
    expect(readState(p).quests[0].title).toBe("Launch v2");
    const now = p.document.activeElement;
    expect(now?.getAttribute("onclick")).toBe(opener);
    expect(now?.isConnected).toBe(true);
    expect(now).not.toBe(edit);
    expect(pageErrors(p)).toEqual([]);
  });

  it("Escape and the Task Options sheet follow the same rule; a form sheet still focuses its first field", () => {
    const p = load({ seedState: baseState() });
    const row = one(p, '#mainContainer [onclick^="openTaskInspectorSheet"]');
    row.focus();
    click(p, row);
    expect(sheetKind(p)).toBe("task:tsk-1");
    expect(p.document.activeElement?.classList.contains("sheet-close")).toBe(true);
    p.document.dispatchEvent(new p.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(sheetKind(p)).toBeNull();
    expect(p.document.activeElement?.getAttribute("onclick")).toBe(row.getAttribute("onclick"));

    const fab = one(p, "#fabBtn");
    fab.focus();
    click(p, fab);
    expect(p.document.activeElement?.id).toBe("sheetTaskTitle");
    p.closeSheet();
    expect(p.document.activeElement).toBe(fab);
  });
});

describe("Focus-view session notes", () => {
  it("uses a class with a 16 px font and a cyan focus border instead of an inline outline:none", () => {
    const p = load({ seedState: baseState() });
    p.initializeFocus("tsk-1");
    const notes = one(p, '.focus-notes textarea[aria-label="Session notes"]');
    expect(notes.classList.contains("focus-notes-input")).toBe(true);
    expect(notes.getAttribute("style")).toBeNull();
    const css = cssText(p);
    expect(block(css, ".focus-notes-input")).toContain("font-size: 16px");
    expect(block(css, ".focus-notes-input:focus")).toContain("border-color: var(--cyan)");
    expect(p.getComputedStyle(notes).fontSize).toBe("16px");
  });
});

describe("Guide sections keep focus after re-render", () => {
  it("the chosen section's button is focused again after renderApp rebuilds the view", () => {
    const p = load({ seedState: baseState() });
    p.eval("openGuideView('quests')");
    const tasksBtn = () =>
      Array.from(p.document.querySelectorAll('[aria-label="Guide sections"] .seg-option')).find(
        (b) => b.textContent?.trim() === "Tasks"
      );
    const before = tasksBtn();
    if (!(before instanceof p.HTMLElement)) throw new Error("missing Tasks section button");
    before.focus();
    click(p, before);
    const after = tasksBtn();
    expect(after).not.toBe(before);
    expect(after?.getAttribute("aria-pressed")).toBe("true");
    expect(p.document.activeElement).toBe(after);
  });
});

describe("sync error copy", () => {
  it("an unusual laptop HTTP status gives a recovery step, with the code only as a trailing detail", () => {
    const p = load();
    const info: unknown = JSON.parse(String(p.eval('JSON.stringify(syncReasonInfo("http_418"))')));
    const detail = info && typeof info === "object" && "detail" in info ? String(info.detail) : "";
    expect(detail).not.toContain("answered with HTTP");
    expect(detail).toContain("Restart Hunt on the laptop");
    expect(detail).toContain("hunt-server.log");
    expect(detail).toMatch(/\(HTTP 418\)\.$/);
  });
});

describe("complete-ring contrast", () => {
  it("the resting ring keeps >= 3:1 against the card surface", () => {
    const p = load({ seedState: baseState() });
    const css = cssText(p);
    // The ring is the ink token at partial opacity (ADR-0005); Neon's ink is white.
    const m = /border:\s*[\d.]+px solid rgb\(var\(--c-ink\) \/ ([\d.]+)\)/.exec(block(css, ".task-check-ring"));
    const alpha = Number(m?.[1]);
    // --surface is rgb(var(--p-1)); read the Neon channels behind it.
    const surface = channels(p.getComputedStyle(p.document.documentElement).getPropertyValue("--p-1"));
    const mix = (i: 0 | 1 | 2) => 255 * alpha + surface[i] * (1 - alpha);
    const ring: Rgb = [mix(0), mix(1), mix(2)];
    expect(alpha).toBeGreaterThan(0);
    expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3);
    // the old 0.28 was below 3:1
    const old = (i: 0 | 1 | 2) => 255 * 0.28 + surface[i] * 0.72;
    expect(contrast([old(0), old(1), old(2)], surface)).toBeLessThan(3);
  });
});

describe("reduced motion", () => {
  it("the reduced-motion block also cuts CSS transitions (the FAB's 48 px slide), like desktop", () => {
    const p = load();
    const reduced = block(cssText(p), "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{\s*transition-duration:\s*0\.01ms !important;/);
    expect(reduced).toContain("animation: none !important");
  });
});

describe("native IME: the focused page field is scrolled above the keyboard", () => {
  function setup() {
    const p = load({ seedState: baseState() });
    const scrolls: unknown[] = [];
    Object.defineProperty(p, "scrollBy", { value: (opts: unknown) => scrolls.push(opts), configurable: true });
    return { p, scrolls };
  }

  it("the Focus-view notes field under a settled 300 dp keyboard scrolls up to 16 px above it", () => {
    const { p, scrolls } = setup();
    p.initializeFocus("tsk-1");
    const notes = one(p, ".focus-notes-input");
    const h = p.innerHeight;
    notes.getBoundingClientRect = () => rect(20, h - 60, 300, 40);
    notes.focus();
    p.eval("window.__huntSetIme(120)"); // keyboard still animating: nothing yet
    p.eval("window.__huntSetIme(300)");
    expect(scrolls).toEqual([]);
    vi.advanceTimersByTime(150);
    expect(scrolls).toHaveLength(1);
    const top = scrolls[0] && typeof scrolls[0] === "object" && "top" in scrolls[0] ? scrolls[0].top : null;
    expect(top).toBe(h - 20 - (h - 300 - 16));
  });

  it("a field already above the keyboard, a sheet field, or no text field focused: no scroll", () => {
    const { p, scrolls } = setup();
    p.initializeFocus("tsk-1");
    const notes = one(p, ".focus-notes-input");
    notes.getBoundingClientRect = () => rect(20, 100, 300, 40);
    notes.focus();
    p.eval("window.__huntSetIme(300)");
    vi.advanceTimersByTime(150);
    notes.blur();
    p.eval("window.__huntSetIme(310)");
    vi.advanceTimersByTime(150);

    p.openNewTaskSheet();
    const title = field(p, "sheetTaskTitle");
    title.getBoundingClientRect = () => rect(20, p.innerHeight - 30, 300, 40);
    p.eval("window.__huntSetIme(320)");
    vi.advanceTimersByTime(150);
    expect(scrolls).toEqual([]);
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("heatmap scrub-to-select", () => {
  const COLS_BOX = rect(40, 400, 320, 140); // 16 columns x 7 rows -> 20 x 20 px per day slot

  /** A pointer event on the grid at day slot (col, row), dispatched on whatever is under it. */
  function scrub(p: MobileWindow, type: string, col: number, row: number, buttons = 1, target?: Element): void {
    const event = new p.MouseEvent(type, {
      bubbles: true,
      clientX: COLS_BOX.left + (col + 0.5) * 20,
      clientY: COLS_BOX.top + (row + 0.5) * 20,
      buttons,
    });
    (target ?? one(p, "[data-review-heatmap] .heatmap-cols")).dispatchEvent(event);
  }
  function keyAt(p: MobileWindow, col: number, row: number): string | null {
    const cols = one(p, "[data-review-heatmap] .heatmap-cols");
    return cols.children[col]?.children[row]?.getAttribute("data-hm-key") ?? null;
  }
  function selectedKey(p: MobileWindow): string | null {
    return p.document.querySelector("[data-review-heatmap] .heatmap-cell.selected")?.getAttribute("data-hm-key") ?? null;
  }

  it("a press anywhere on the grid picks the nearest day and dragging scrubs; hover without a press does nothing", () => {
    const p = load({
      seedState: baseState(),
      beforeBoot(win) {
        const base = win.Element.prototype.getBoundingClientRect;
        win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
          return this.classList.contains("heatmap-cols") ? COLS_BOX : base.call(this);
        };
      },
    });
    p.switchView("telemetry");
    expect(block(cssText(p), ".heatmap-cols")).toContain("touch-action: pan-y");

    // a press on the grid itself (not on a cell) picks the day slot under the finger
    const first = keyAt(p, 0, 0);
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(selectedKey(p)).not.toBe(first);
    scrub(p, "pointerdown", 0, 0);
    expect(selectedKey(p)).toBe(first);

    // the finger slides on, over a cell of the re-rendered grid
    const later = keyAt(p, 3, 2);
    const under = one(p, "[data-review-heatmap] .heatmap-cols").children[3]?.children[2];
    scrub(p, "pointermove", 3, 2, 1, under);
    expect(selectedKey(p)).toBe(later);

    scrub(p, "pointermove", 5, 5, 0); // no button down: not a scrub
    expect(selectedKey(p)).toBe(later);

    // the cells keep their click (TalkBack, mouse) and their accessible names
    const cell = one(p, "[data-review-heatmap] .heatmap-cell");
    expect(cell.getAttribute("role")).toBe("button");
    expect(cell.getAttribute("onclick")).toContain("selectedReviewHeatmapKey=");
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("Quests view groups tasks in one pass", () => {
  it("each quest card lists its open steps by rank and at most 3 tasks finished today, newest first", () => {
    const yesterday = NOW - DAY;
    const p = load({
      seedState: baseState({
        quests: [quest("quest-1", "Launch"), quest("quest-2", "Write", { slotIndex: 1 })],
        tasks: [
          task("a-late", "Alpha late", { rank: 2000 }),
          task("a-first", "Alpha first", { rank: 1000 }),
          task("b-only", "Beta only", { questId: "quest-2", status: "active", rank: 500 }),
          task("done-1", "Done one", { status: "completed", completedAt: NOW - 4000 }),
          task("done-2", "Done two", { status: "completed", completedAt: NOW - 3000 }),
          task("done-3", "Done three", { status: "completed", completedAt: NOW - 2000 }),
          task("done-4", "Done four", { status: "completed", completedAt: NOW - 1000 }),
          task("done-old", "Done yesterday", { status: "completed", completedAt: yesterday }),
          task("loose", "No quest", { questId: null }),
        ],
      }),
    });
    p.switchView("quests");
    const cards = Array.from(p.document.querySelectorAll("#mainContainer .quests-grid > .review-card"));
    expect(cards).toHaveLength(2);
    const text = (i: number) => cards[i].textContent ?? "";
    const order = (i: number, titles: string[]) => titles.map((t) => text(i).indexOf(t));

    expect(text(0)).toContain("Next steps (2)");
    const pending = order(0, ["Alpha first", "Alpha late"]);
    expect(pending.every((x) => x >= 0)).toBe(true);
    expect(pending[0]).toBeLessThan(pending[1]);
    expect(text(0)).toContain("Completed today (3)");
    const done = order(0, ["Done four", "Done three", "Done two"]);
    expect(done.every((x) => x >= 0)).toBe(true);
    expect(done[0]).toBeLessThan(done[1]);
    expect(done[1]).toBeLessThan(done[2]);
    expect(text(0)).not.toContain("Done one");
    expect(text(0)).not.toContain("Done yesterday");
    expect(text(0)).not.toContain("No quest");

    expect(text(1)).toContain("Next steps (1)");
    expect(text(1)).toContain("Beta only");
    expect(text(1)).not.toContain("Completed today");
    expect(localKey(yesterday)).not.toBe(localKey(NOW));
    expect(pageErrors(p)).toEqual([]);
  });
});

describe("sync timestamps in English, 24 h", () => {
  it("absoluteTime never uses the device locale", () => {
    const p = load({
      beforeBoot(win) {
        const date = win.Date.prototype.toLocaleDateString;
        win.Date.prototype.toLocaleDateString = function (this: Date, locales?: unknown, opts?: Intl.DateTimeFormatOptions) {
          return locales === "en-US" ? date.call(this, "en-US", opts) : "tir. 18. nov.";
        };
        win.Date.prototype.toLocaleTimeString = () => "2.32 p.m.";
      },
    });
    const hhmm = (ts: number) => {
      const d = new Date(ts);
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    };
    expect(p.eval(`absoluteTime(${NOW})`)).toBe("today " + hhmm(NOW));
    const earlier = NOW - 2 * DAY;
    const day = new Date(earlier).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    expect(p.eval(`absoluteTime(${earlier})`)).toBe(day + " " + hhmm(earlier));
  });
});

describe("dead audio code removed", () => {
  it("no mute state, mute icon or deferred prewarm timer remain; the silent tap stubs stay", () => {
    const html = mobileHtml();
    for (const gone of ["audioMuted", "audioCtx", "playTone", "updateMuteIcon", "toggleAudioMute", "prewarmAudio", "muteBtn", "SVG_VOL_"]) {
      expect(html, gone).not.toContain(gone);
    }
    const p = load({ seedState: baseState() });
    expect(p.eval("typeof playClickSound + typeof playLockSound + typeof playCompleteSound")).toBe("functionfunctionfunction");
    expect(pageErrors(p)).toEqual([]);
  });
});
