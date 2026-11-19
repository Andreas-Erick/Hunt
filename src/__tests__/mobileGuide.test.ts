// @vitest-environment node
// Mobile / Android Quest & Task Guide: all 4 tabs, live workspace audit, interactive draft tester,
// creating tasks & quests into state, 48 px touch targets, 16 px inputs, overflow-wrap, and XSS safety.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  click,
  loadMobile,
  pageErrors,
  readState,
  type MobileWindow,
} from "./helpers/loadMobile";

const NOW = new Date("2026-11-19T01:00:00Z").getTime();

let w: MobileWindow | null = null;
function load(options: Parameters<typeof loadMobile>[0] = {}): MobileWindow {
  w = loadMobile(options);
  return w;
}

function baseState(extra: Record<string, unknown> = {}) {
  return {
    quests: [
      {
        id: "quest-1",
        slotIndex: 0,
        title: "Launch my idea",
        description: "Primary product architecture and v1 shipping.",
        accentColor: "cyan",
        targetWeeklyHours: 12,
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: "tsk-vague",
        title: "Website",
        notes: "",
        status: "queued",
        rank: 0,
        questId: "quest-1",
        accumulatedSeconds: 0,
        updatedAt: 1,
      },
    ],
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
    ...extra,
  };
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

describe("mobile Quest & Task Guide", () => {
  it("opens from Quests and Review, navigates all 4 tabs, and supports Android Back", () => {
    const p = load({ seedState: baseState() });

    p.switchView("quests");
    const guideBtn = Array.from(p.document.querySelectorAll("#mainContainer button")).find(
      (b) => b.textContent?.trim() === "Guide"
    );
    expect(guideBtn).toBeTruthy();
    click(p, guideBtn ?? null);

    expect(p.document.querySelector("#mainContainer h1")?.textContent).toContain("Quest & Task Guide");
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("Cap active Quests at 1 to 3");

    const tabs = () => Array.from(p.document.querySelectorAll('[role="tab"]'));
    expect(tabs().map((t) => t.textContent?.trim())).toEqual(["Quests", "Tasks", "System", "Workshop"]);

    click(p, tabs()[1]);
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("Start with a concrete physical verb");

    click(p, tabs()[2]);
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("30-Second Pre-Flight Checklist");

    click(p, tabs()[3]);
    expect(p.document.querySelector('[data-guide-audit="quests"]')?.textContent).toBe("1");
    expect(p.document.querySelector('[data-guide-audit="hours"]')?.textContent).toBe("12h");

    // Android Back returns to Today cleanly
    expect(p.__huntBack()).toBe(true);
    expect(p.document.body.getAttribute("data-view")).toBe("command");

    // Also accessible from Review
    p.switchView("telemetry");
    const reviewBanner = p.document.querySelector("#mainContainer .guide-entry-btn");
    expect(reviewBanner).not.toBeNull();
    click(p, reviewBanner);
    expect(p.document.body.getAttribute("data-view")).toBe("guide");
    expect(pageErrors(p)).toEqual([]);
  });

  it("evaluates tasks live, escapes XSS safely, and saves drafted Tasks and Quests into state", () => {
    const p = load({ seedState: baseState() });
    p.eval("openGuideView('workshop')");

    // Load the vague open task via the audit "Test" button
    const testBtn = Array.from(p.document.querySelectorAll(".guide-sharpen-row button")).find(
      (b) => b.textContent?.trim() === "Test"
    );
    expect(testBtn).toBeTruthy();
    click(p, testBtn ?? null);
    expect(p.document.querySelector("[data-guide-verdict]")?.getAttribute("data-guide-verdict")).toBe("weak");

    // Load strong task preset -> verdict flips to strong
    const strongPreset = Array.from(p.document.querySelectorAll(".sheet-pill")).find(
      (b) => b.textContent?.trim() === "Strong: Building"
    );
    click(p, strongPreset ?? null);
    expect(p.document.querySelector("[data-guide-verdict]")?.getAttribute("data-guide-verdict")).toBe("strong");

    // Save drafted Task to state
    const addTaskBtn = p.document.querySelector(".guide-action-btn");
    click(p, addTaskBtn);
    const afterTask = readState(p);
    expect(afterTask.tasks.map((t) => t.title)).toContain(
      "Implement CSV export button and verify 3 edge cases"
    );

    // XSS payload in task title executes nothing and injects no markup
    const titleInput = p.document.getElementById("guideTaskTitleInput") as HTMLInputElement;
    titleInput.value = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
    titleInput.dispatchEvent(new p.Event("input", { bubbles: true }));
    expect(p.document.querySelector("#guideEvalBox img")).toBeNull();
    expect(p.document.querySelector("#guideEvalBox script")).toBeNull();
    expect(p.__pwned).toBeUndefined();

    // Switch to Quest mode, load strong preset, and create a Quest
    const questModeBtn = Array.from(p.document.querySelectorAll(".seg-option")).find(
      (b) => b.textContent?.trim() === "Test a Quest"
    );
    click(p, questModeBtn ?? null);
    const strongQuest = Array.from(p.document.querySelectorAll(".sheet-pill")).find(
      (b) => b.textContent?.trim() === "Strong: Craft"
    );
    click(p, strongQuest ?? null);
    expect(p.document.querySelector("[data-guide-verdict]")?.getAttribute("data-guide-verdict")).toBe("strong");

    click(p, p.document.querySelector(".guide-action-btn"));
    const afterQuest = readState(p);
    expect(afterQuest.quests.map((q) => q.title)).toContain("Ship v1 of my audio plugin");
    expect(pageErrors(p)).toEqual([]);
  });

  it("enforces 16 px inputs, 48 px action buttons, and overflow-wrap on long titles", () => {
    const long = "L".repeat(250);
    const p = load({
      seedState: baseState({
        tasks: [
          { id: "tsk-long", title: long, notes: "", status: "queued", rank: 0, questId: "quest-1", accumulatedSeconds: 0, updatedAt: 1 },
        ],
      }),
    });
    p.eval("openGuideView('workshop')");

    const inputs = p.document.querySelectorAll("#mainContainer .sheet-input");
    expect(inputs.length).toBeGreaterThan(0);
    inputs.forEach((el) => expect(p.getComputedStyle(el).fontSize).toBe("16px"));

    const actionBtn = p.document.querySelector(".guide-action-btn");
    expect(actionBtn).not.toBeNull();
    expect(p.getComputedStyle(actionBtn!).minHeight).toBe("48px");

    const longRowTitle = p.document.querySelector(".guide-sharpen-row > div > div");
    expect(longRowTitle).not.toBeNull();
    expect(p.getComputedStyle(longRowTitle!).overflowWrap).toBe("anywhere");
    expect(pageErrors(p)).toEqual([]);
  });
});
