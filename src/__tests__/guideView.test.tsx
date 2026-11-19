import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { db, type Quest, type Task } from "@/lib/db";
import {
  auditWorkspace,
  evaluateQuestDraft,
  evaluateTaskDraft,
} from "@/lib/questScience";
import { useCommandStore } from "@/store/useCommandStore";
import HomePage from "@/app/page";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { GuideView } from "@/components/GuideView";

const T0 = 1_700_000_000_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeQuest(id: string, title: string, extra: Partial<Quest> = {}): Quest {
  return {
    id,
    slotIndex: 0,
    code: title.slice(0, 8).toUpperCase(),
    title,
    description: "Core work that moves this mission forward every week.",
    accentColor: "cyan",
    targetWeeklyHours: 8,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makeTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    notes: "",
    questId: "q-1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, autoSync: s.autoSync, requestSync: s.requestSync };
})();

beforeEach(async () => {
  await db.quests.clear();
  await db.tasks.clear();
  await db.timeLogs.clear();
  useCommandStore.setState({
    activeView: "guide",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    actionError: null,
    syncNow: vi.fn(async () => true),
    autoSync: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useCommandStore.setState({ ...realActions, activeView: "command", actionError: null });
});

// ---------------------------------------------------------------------------
// Pure Science Engine: evaluateTaskDraft, evaluateQuestDraft, auditWorkspace
// ---------------------------------------------------------------------------
describe("questScience pure evaluators", () => {
  it("scores a concrete, scoped, single-sitting task as strong", () => {
    const res = evaluateTaskDraft(
      "Draft 500 words for the intro section of essay #4",
      "Done when hook, thesis, and 1 example are written."
    );
    expect(res.verdict).toBe("strong");
    expect(res.score).toBe(8);
    expect(res.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("flags vague 1-word nouns and vague filler starters", () => {
    const noun = evaluateTaskDraft("Website");
    expect(noun.verdict).toBe("weak");
    expect(noun.checks.find((c) => c.id === "verb")?.status).toBe("fail");
    expect(noun.checks.find((c) => c.id === "specificity")?.status).toBe("fail");

    const filler = evaluateTaskDraft("Work on entire launch and marketing and docs");
    expect(filler.verdict).toBe("weak");
    expect(filler.checks.find((c) => c.id === "verb")?.status).toBe("fail");
    expect(filler.checks.find((c) => c.id === "size")?.status).toBe("fail");
  });

  it("evaluates Quest drafts against goal shielding, weekly hours, identity, and purpose", () => {
    const strong = evaluateQuestDraft({
      title: "Ship v1 of my audio plugin",
      description: "Build core DSP engine and test with 5 musicians to master real-time audio.",
      targetWeeklyHours: 10,
      existingQuestCount: 2,
      existingWeeklyHours: 10,
    });
    expect(strong.verdict).toBe("strong");
    expect(strong.score).toBe(8);

    const weak = evaluateQuestDraft({
      title: "Be successful",
      description: "",
      targetWeeklyHours: 45,
      existingQuestCount: 4,
      existingWeeklyHours: 20,
    });
    expect(weak.verdict).toBe("weak");
    expect(weak.checks.every((c) => c.status === "fail")).toBe(true);
  });

  it("handles boundary strings, non-Latin scripts, emoji, XSS, and extreme numbers safely", () => {
    for (const badText of [
      "",
      "   ",
      "A".repeat(20_000),
      "Draft " + "a ".repeat(5_000),
      "مرحبا بالعالم اليوم",
      "👨‍👩‍👧‍👦 launch plan",
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
    ]) {
      const t = evaluateTaskDraft(badText, badText);
      expect(Number.isFinite(t.score)).toBe(true);
      expect(t.score).toBeGreaterThanOrEqual(0);
      expect(t.score).toBeLessThanOrEqual(t.maxScore);
    }

    for (const hours of [0, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, 0.1 + 0.2]) {
      const q = evaluateQuestDraft({
        title: "Build focused tool",
        description: "Clear description of the craft and why it matters.",
        targetWeeklyHours: hours,
        existingQuestCount: Number.isFinite(hours) ? hours : NaN,
        existingWeeklyHours: hours,
      });
      expect(Number.isFinite(q.score)).toBe(true);
      expect(q.summary).not.toMatch(/NaN|Infinity/);
      for (const c of q.checks) {
        expect(c.detail).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it("auditWorkspace handles empty, corrupted, and 1,200+ item collections cleanly", () => {
    const empty = auditWorkspace([], []);
    expect(empty.questLoadStatus).toBe("empty");
    expect(empty.budgetStatus).toBe("none");
    expect(empty.openTaskCount).toBe(0);
    expect(empty.tasksToSharpen).toEqual([]);

    const manyTasks: Task[] = Array.from({ length: 1200 }, (_, i) =>
      makeTask(`t-${i}`, i % 2 === 0 ? "Stuff" : `Draft chapter ${i} outline with 3 bullets`, {
        questId: i % 3 === 0 ? null : "q-1",
      })
    );
    const quests: Quest[] = [
      makeQuest("q-1", "Launch my idea", { targetWeeklyHours: 12 }),
      makeQuest("q-2", "Bad hours", { targetWeeklyHours: NaN }),
      makeQuest("q-archived", "Old quest", { archived: true, targetWeeklyHours: 50 }),
    ];

    const audit = auditWorkspace(quests, manyTasks);
    expect(audit.activeQuestCount).toBe(2);
    expect(audit.questLoadStatus).toBe("optimal");
    expect(audit.weeklyBudgetHours).toBe(12);
    expect(audit.openTaskCount).toBe(1200);
    expect(audit.tasksToSharpen).toHaveLength(5);
    expect(Number.isFinite(audit.clarityPct)).toBe(true);
  });

  it("preserves invariants across 200 seeded random inputs", () => {
    const seed = 0x901de5;
    const rand = mulberry32(seed);
    const pool = [
      "",
      "   ",
      "Website",
      "Work on stuff",
      "Draft 3 sections for essay",
      "Build entire app and docs and billing",
      "Run 5 km easy pace",
      "Be better",
      "👨‍👩‍👧‍👦",
      "<script>x</script>",
    ];
    for (let i = 0; i < 200; i++) {
      const title = pool[Math.floor(rand() * pool.length)];
      const notes = pool[Math.floor(rand() * pool.length)];
      const t = evaluateTaskDraft(title, notes);
      expect(t.score, `seed=${seed} i=${i}`).toBeGreaterThanOrEqual(0);
      expect(t.score, `seed=${seed} i=${i}`).toBeLessThanOrEqual(t.maxScore);
      expect(["empty", "weak", "fair", "strong"]).toContain(t.verdict);

      const hours = (rand() - 0.2) * 80;
      const q = evaluateQuestDraft({
        title,
        description: notes,
        targetWeeklyHours: hours,
        existingQuestCount: Math.floor(rand() * 7),
        existingWeeklyHours: rand() * 50,
      });
      expect(Number.isFinite(q.score), `seed=${seed} i=${i}`).toBe(true);
      expect(q.score).toBeGreaterThanOrEqual(0);
      expect(q.score).toBeLessThanOrEqual(q.maxScore);
    }
  });
});

// ---------------------------------------------------------------------------
// Navigation & Shell Integration
// ---------------------------------------------------------------------------
describe("Guide navigation and shell integration", () => {
  it("TopTelemetryBar exposes Guide tab and marks it current", () => {
    useCommandStore.setState({ activeView: "command" });
    render(<TopTelemetryBar />);
    const nav = within(screen.getByRole("navigation"));
    const guideBtn = nav.getByRole("button", { name: "Guide" });
    expect(guideBtn).not.toHaveAttribute("aria-current");

    fireEvent.click(guideBtn);
    expect(useCommandStore.getState().activeView).toBe("guide");
    expect(guideBtn).toHaveAttribute("aria-current", "page");
  });

  it("QuestMatrixPanel links directly to the Guide", () => {
    useCommandStore.setState({ activeView: "quests" });
    render(<QuestMatrixPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Quest Guide" }));
    expect(useCommandStore.getState().activeView).toBe("guide");
  });

  it("HomePage renders GuideView when switching to Guide", async () => {
    useCommandStore.setState({ activeView: "guide" });
    render(<HomePage />);
    expect(await screen.findByRole("heading", { name: "Quest & Task Guide" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// GuideView & GuideLabSection UI, Accessibility, Mutations & Chaos Tests
// ---------------------------------------------------------------------------
describe("GuideView interactive workflow", () => {
  it("supports click and keyboard tab navigation (ArrowRight, ArrowLeft, Home, End)", () => {
    render(<GuideView />);
    const questsTab = screen.getByRole("tab", { name: /Quests/ });
    const tasksTab = screen.getByRole("tab", { name: /Tasks/ });
    const systemTab = screen.getByRole("tab", { name: /Weekly System/ });
    const workshopTab = screen.getByRole("tab", { name: /Workshop & Audit/ });

    expect(questsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("principle-goal-shielding")).toBeInTheDocument();

    questsTab.focus();
    fireEvent.keyDown(questsTab, { key: "ArrowRight" });
    expect(tasksTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tasksTab);
    expect(screen.getByTestId("principle-implementation-intentions")).toBeInTheDocument();

    fireEvent.keyDown(tasksTab, { key: "End" });
    expect(workshopTab).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(workshopTab);

    fireEvent.keyDown(workshopTab, { key: "Home" });
    expect(questsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(questsTab, { key: "ArrowLeft" });
    expect(workshopTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(systemTab);
    expect(systemTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("30-second pre-flight checklist")).toBeInTheDocument();
  });

  it("evaluates presets, escapes XSS text safely, and validates on blur/submit (not initial render)", async () => {
    await db.quests.add(makeQuest("q-1", "Launch my idea", { targetWeeklyHours: 12 }));
    await db.tasks.add(makeTask("t-vague", "Website"));

    const { container } = render(<GuideView />);
    fireEvent.click(screen.getByRole("tab", { name: /Workshop & Audit/ }));

    // Live workspace audit loads and spots the vague open task
    expect(await screen.findByTestId("audit-quest-count")).toHaveTextContent("1");
    expect(screen.getByTestId("audit-weekly-hours")).toHaveTextContent("12h");
    expect(screen.getByText("Website")).toBeInTheDocument();

    // No premature red error on first render
    expect(screen.queryByRole("alert")).toBeNull();

    // Clicking "Load in tester" loads the weak task and shows weak verdict
    fireEvent.click(screen.getByRole("button", { name: "Load in tester" }));
    expect(screen.getByLabelText("Task title")).toHaveValue("Website");
    expect(screen.getByTestId("lab-verdict")).toHaveTextContent(/Too vague/);

    // Strong preset updates verdict to Strong
    fireEvent.click(screen.getByRole("button", { name: "Strong: Writing" }));
    expect(screen.getByTestId("lab-verdict")).toHaveTextContent(/Strong/);

    // XSS payload renders as inert text only
    const xss = '<img src=x onerror="alert(1)"><script>alert(1)</script>';
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: xss } });
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();

    // Clearing and blurring triggers inline validation error
    const titleInput = screen.getByLabelText("Task title");
    fireEvent.change(titleInput, { target: { value: "   " } });
    fireEvent.blur(titleInput);
    expect(screen.getByRole("alert")).toHaveTextContent(/Enter a task title/);
  });

  it("adds a drafted task to IndexedDB once even on 10 rapid spam clicks, and cleans up feedback timer", async () => {
    await db.quests.add(makeQuest("q-1", "Launch my idea"));

    const { unmount } = render(<GuideView />);
    fireEvent.click(screen.getByRole("tab", { name: /Workshop & Audit/ }));
    await screen.findByTestId("audit-quest-count");

    fireEvent.click(screen.getByRole("button", { name: "Strong: Building" }));
    const submitBtn = screen.getByRole("button", { name: /Add to Today's Queue/ });

    for (let i = 0; i < 10; i++) {
      fireEvent.click(submitBtn);
    }

    await waitFor(async () => {
      const saved = await db.tasks.toArray();
      expect(saved).toHaveLength(1);
      expect(saved[0].title).toBe("Implement CSV export button and verify 3 edge cases");
      expect(saved[0].questId).toBe("q-1");
    });

    expect(await screen.findByRole("status")).toHaveTextContent("Added to Today's Queue");
    // Unmounting mid-timer leaves no error
    unmount();
  });

  it("creates a drafted Quest in IndexedDB from Quest mode", async () => {
    render(<GuideView />);
    fireEvent.click(screen.getByRole("tab", { name: /Workshop & Audit/ }));
    await screen.findByTestId("audit-quest-count");

    fireEvent.click(screen.getByRole("button", { name: "Test a Quest" }));
    fireEvent.click(screen.getByRole("button", { name: "Strong: Calibrated craft" }));
    expect(screen.getByTestId("lab-verdict")).toHaveTextContent(/Strong/);

    fireEvent.click(screen.getByRole("button", { name: "Create Quest" }));

    await waitFor(async () => {
      const quests = await db.quests.toArray();
      expect(quests).toHaveLength(1);
      expect(quests[0].title).toBe("Ship v1 of my audio plugin");
      expect(quests[0].targetWeeklyHours).toBe(10);
      expect(quests[0].accentColor).toBe("emerald");
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Quest created");
  });

  it("survives a seeded random sequence of tab switches, mode toggles, and edits", () => {
    const seed = 0xca05;
    const rand = mulberry32(seed);
    render(<GuideView />);

    const tabNames = [/Quests/, /Tasks/, /Weekly System/, /Workshop & Audit/];
    for (let step = 0; step < 60; step++) {
      const action = rand();
      if (action < 0.5) {
        const pick = tabNames[Math.floor(rand() * tabNames.length)];
        fireEvent.click(screen.getByRole("tab", { name: pick }));
      } else {
        const taskToggle = screen.queryByRole("button", { name: "Test a Task" });
        const questToggle = screen.queryByRole("button", { name: "Test a Quest" });
        if (taskToggle && questToggle) {
          fireEvent.click(rand() < 0.5 ? taskToggle : questToggle);
        }
      }
      const selectedTabs = screen
        .getAllByRole("tab")
        .filter((el) => el.getAttribute("aria-selected") === "true");
      expect(selectedTabs, `seed=${seed} step=${step}`).toHaveLength(1);
    }
  });
});
