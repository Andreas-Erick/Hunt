import os from "os";
import fs from "fs";
import path from "path";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { APP_VERSION } from "@/lib/version";
import {
  QUEST_ACCENT_KEYS,
  type Quest,
  type QuestAccent,
  type Task,
  type TimeLog,
} from "@/lib/domainTypes";
import { QUEST_ACCENT_STYLES } from "@/lib/questAccents";
import { db } from "@/lib/db";
import { toLocalDateKey } from "@/lib/dateUtils";
import {
  BOOT_SAFETY_TIMEOUT_MS,
  bootOnce,
  resetBootOnceForTests,
} from "@/lib/bootSequence";
import {
  buildHorizonWindow,
  computeActivityHeatmap,
  computePeriodReport,
  formatTelemetryDuration,
  layoutTimelineBlocks,
} from "@/lib/reviewAnalytics";
import { validateSyncPayload } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import manifest from "@/app/manifest";
import HomePage from "@/app/page";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { FocusHudView } from "@/components/FocusHudView";
import { POST as windowRoutePost } from "@/app/api/window/route";
import {
  ensureCompiledWinCtlHelper,
  setWin32ActionExecutorForTests,
  type DesktopWindowAction,
} from "@/lib/win32WindowCtl";
import { MobileSyncModal } from "@/components/MobileSyncModal";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { ReviewHeatmapCard } from "@/components/ReviewHeatmapCard";
import {
  click as mobileClick,
  loadMobile,
  pageErrors,
  readState,
} from "./helpers/loadMobile";

const ROOT = path.resolve(__dirname, "..", "..");

const realStoreActions = (() => {
  const s = useCommandStore.getState();
  return {
    createTask: s.createTask,
    createHabit: s.createHabit,
    createQuest: s.createQuest,
    syncNow: s.syncNow,
    autoSync: s.autoSync,
    requestSync: s.requestSync,
    materializeDailyHabits: s.materializeDailyHabits,
  };
})();

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

function makeQuest(
  id: string,
  slotIndex: 0 | 1 | 2,
  title: string,
  accentColor: QuestAccent,
  description = "",
  targetWeeklyHours = 8
): Quest {
  return {
    id,
    slotIndex,
    code: `Q${slotIndex + 1}`,
    title,
    description,
    accentColor,
    targetWeeklyHours,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeTimeLog(params: {
  id: string;
  taskId: string;
  taskTitleSnapshot: string;
  questId: string | null;
  accentColorSnapshot?: QuestAccent | "slate";
  startTime: number;
  durationSeconds: number;
  dateKey: string;
}): TimeLog {
  return {
    id: params.id,
    taskId: params.taskId,
    taskTitleSnapshot: params.taskTitleSnapshot,
    questId: params.questId,
    questCodeSnapshot: params.questId ? "Q1" : "OTHER",
    accentColorSnapshot: params.accentColorSnapshot ?? (params.questId ? "cyan" : "slate"),
    startTime: params.startTime,
    endTime: params.startTime + params.durationSeconds * 1000,
    durationSeconds: params.durationSeconds,
    dateKey: params.dateKey,
  };
}

async function resetDbAndStore() {
  resetBootOnceForTests();
  await db.open();
  await db.transaction("rw", db.quests, db.tasks, db.habits, db.timeLogs, async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.habits.clear();
    await db.timeLogs.clear();
  });
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: 0,
    isSyncOnline: false,
    lastSyncedAt: null,
    syncError: null,
    actionError: null,
    ...realStoreActions,
    syncNow: vi.fn(async () => true),
    autoSync: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
}

beforeEach(async () => {
  localStorage.clear();
  await resetDbAndStore();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useCommandStore.setState(realStoreActions);
});

// ---------------------------------------------------------------------------
// 1. Desktop Missing-Views Bug Fixes & Fullscreen Taskbar Hiding
// ---------------------------------------------------------------------------
describe("Desktop launch reliability & fullscreen taskbar hiding", () => {
  it("keeps Dexie auto-open active when closing on versionchange so views never go blank", async () => {
    await db.quests.add(
      makeQuest("q-reopen", 0, "Persistent Quest", "cyan", "Survives versionchange")
    );

    // Simulate the exact close options registered in CommandCenterDB's versionchange listener.
    db.close({ disableAutoOpen: false });
    expect(db.isOpen()).toBe(false);

    // Subsequent queries (such as useLiveQuery on Quests/Habits) must auto-reopen seamlessly.
    const quests = await db.quests.toArray();
    expect(quests).toHaveLength(1);
    expect(quests[0].title).toBe("Persistent Quest");
    expect(db.isOpen()).toBe(true);

    const dbSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "db.ts"), "utf8");
    expect(dbSrc).toContain("this.close({ disableAutoOpen: false })");
  });

  it("renders every desktop view without inline opacity:0 traps even under rapid tab switching", async () => {
    await db.quests.add(
      makeQuest("q-nav", 0, "Core Engineering", "purple", "Ship cleanly", 10)
    );
    await db.habits.add({
      id: "hab-nav",
      title: "Morning Review",
      questId: "q-nav",
      notes: "15 minutes",
      rank: 1000,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const { container } = render(<HomePage />);

    // Wait for initial boot ("Loading Hunt...") to complete and render the top navigation bar.
    await screen.findByRole("button", { name: "Quests" });
    expect(screen.queryByText("Loading Hunt...")).toBeNull();

    const tabs = ["Quests", "Habits", "Plan", "Review", "Guide", "Home"] as const;
    for (let round = 0; round < 2; round++) {
      for (const label of tabs) {
        fireEvent.click(screen.getByRole("button", { name: label }));
      }
    }

    // Also verify Focus view wrapper has no inline opacity:0 trap, then return to top-bar views
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    const focusWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(focusWrapper).not.toBeNull();
    expect(focusWrapper?.style.opacity).not.toBe("0");
    act(() => {
      useCommandStore.getState().setActiveView("command");
    });

    fireEvent.click(screen.getByRole("button", { name: "Quests" }));
    await waitFor(() => {
      expect(screen.getByText("Core Engineering")).toBeTruthy();
    });
    const questWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(questWrapper).not.toBeNull();
    expect(questWrapper?.style.opacity).not.toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Habits" }));
    await waitFor(() => {
      expect(screen.getByText("Morning Review")).toBeTruthy();
    });
    const habitsWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(habitsWrapper).not.toBeNull();
    expect(habitsWrapper?.style.opacity).not.toBe("0");
  });

  it("bounds bootOnce() with BOOT_SAFETY_TIMEOUT_MS if a boot step stalls and cleans up its timer", async () => {
    vi.useFakeTimers();
    resetBootOnceForTests();
    useCommandStore.setState({
      materializeDailyHabits: () => new Promise<number>(() => undefined),
    });

    let settled = false;
    const p = bootOnce().then(() => {
      settled = true;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_SAFETY_TIMEOUT_MS - 50);
    });
    expect(settled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await p;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("configures fullscreen PWA manifest and Launch-Hunt.vbs taskbar hiding + stale-build restart", () => {
    const appManifest = manifest();
    expect(appManifest.display).toBe("fullscreen");

    const vbs = fs.readFileSync(path.join(ROOT, "Launch-Hunt.vbs"), "utf8");
    expect(vbs).toContain("StopStaleServerIfRebuilt");
    expect(vbs).toContain(".next\\BUILD_ID");
    expect(vbs).toContain("--start-fullscreen");
    expect(vbs).toContain("EnsureHuntWindowFullscreen");
    expect(vbs).toContain('probeUrl & "/"');
    expect(vbs).toContain('probeUrl & "/api/sync"');
  });

  it("toggles browser fullscreen from TopTelemetryBar and cleans up fullscreenchange listener on unmount", async () => {
    let fsElement: Element | null = null;
    const reqSpy = vi.fn(async function (this: Element) {
      fsElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitSpy = vi.fn(async () => {
      fsElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fsElement,
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: reqSpy,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitSpy,
    });

    // Window controls render only inside the desktop launcher (pairing key present);
    // the native window host declines here, so the DOM Fullscreen API fallback runs.
    window.localStorage.setItem("hunt-sync-token-v1", "a".repeat(64));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response)
    );

    const removeListenerSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<TopTelemetryBar />);

    const enterBtn = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enterBtn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(enterBtn);
    });
    expect(reqSpy).toHaveBeenCalledTimes(1);

    const exitBtn = screen.getByRole("button", { name: "Exit fullscreen" });
    expect(exitBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(exitBtn);
    });
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enter fullscreen" }).getAttribute("aria-pressed")).toBe(
      "false"
    );

    unmount();
    expect(removeListenerSpy).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// 2. App Version Display & Cross-File Sync
// ---------------------------------------------------------------------------
describe("App version v1.11.0 display & cross-artifact parity", () => {
  it("keeps APP_VERSION synchronized across package.json, installer, AndroidManifest, and hunt-mobile.html", () => {
    expect(APP_VERSION).toBe("1.11.0");

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe(APP_VERSION);

    const iss = fs.readFileSync(path.join(ROOT, "installer", "hunt-desktop.iss"), "utf8");
    expect(iss).toContain(`#define AppVersion "${APP_VERSION}"`);

    const androidManifest = fs.readFileSync(
      path.join(ROOT, "android-app", "app", "src", "main", "AndroidManifest.xml"),
      "utf8"
    );
    expect(androidManifest).toContain(`android:versionName="${APP_VERSION}"`);

    const mobileHtml = fs.readFileSync(path.join(ROOT, "public", "hunt-mobile.html"), "utf8");
    expect(mobileHtml).toMatch(new RegExp(`const\\s+APP_VERSION\\s*=\\s*['"]${APP_VERSION}['"]`));
  });

  it("displays v1.11.0 in Desktop TopTelemetryBar, MobileSyncModal, and Mobile/Tablet header + Sync sheet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            primaryUrl: "http://192.168.1.50:3000",
            urls: ["http://192.168.1.50:3000"],
          }),
        }) as unknown as Response
      )
    );

    const bar = render(<TopTelemetryBar />);
    expect(screen.getByTestId("app-version").textContent).toBe(`v${APP_VERSION}`);
    const logoSvg = screen.getByTestId("hunt-logo");
    expect(logoSvg.querySelector("circle")?.getAttribute("fill")).toBe("#e5aa50");
    expect(logoSvg.innerHTML).not.toContain("23.62,16.89");
    bar.unmount();

    const iconSvg = fs.readFileSync(path.join(ROOT, "src", "app", "icon.svg"), "utf8");
    expect(iconSvg).toContain('fill="url(#gold)"');
    expect(iconSvg).not.toContain("290.8,172.9");

    await act(async () => {
      render(<MobileSyncModal isOpen={true} onClose={() => undefined} />);
    });
    expect(screen.getByTestId("sync-modal-app-version").textContent).toBe(`v${APP_VERSION}`);
    expect(screen.getAllByText(/phone or tablet/i).length).toBeGreaterThanOrEqual(2);

    const w = loadMobile();
    try {
      const badge = w.document.getElementById("headerVersionBadge");
      expect(badge?.textContent).toBe(`v${APP_VERSION}`);
      w.openSyncSheet();
      expect(w.document.getElementById("sheetContainer")?.textContent).toContain(`v${APP_VERSION}`);
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Optional Description When Creating Task / Habit / Quest (Desktop & Mobile)
// ---------------------------------------------------------------------------
describe("Optional description on creation for Task, Habit, and Quest", () => {
  const EDGE_DESC = "Verify <img src=x onerror=alert(1)> & edge notes 👨‍👩‍👧‍👦";

  it("creates a Task with optional description on Home, omits blank descriptions, and rolls back on write failure", async () => {
    render(<CommandCenterView />);

    await waitFor(() => {
      expect(screen.queryByTestId("home-loading-skeleton")).toBeNull();
    });

    const titleInput = screen.getByPlaceholderText("Add quest work...") as HTMLInputElement;
    const descInput = screen.getByLabelText("Task description (optional)") as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: "Write architecture spec" } });
    fireEvent.change(descInput, { target: { value: EDGE_DESC } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(async () => {
      const tasks = await db.tasks.toArray();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe("Write architecture spec");
      expect(tasks[0].notes).toBe(EDGE_DESC);
    });

    expect(titleInput.value).toBe("");
    expect(descInput.value).toBe("");
    await waitFor(() => {
      expect(screen.getByText(EDGE_DESC)).toBeTruthy();
    });

    // Blank description saves empty string notes cleanly without whitespace
    fireEvent.change(titleInput, { target: { value: "Task without notes" } });
    fireEvent.change(descInput, { target: { value: "   " } });
    fireEvent.keyDown(descInput, { key: "Enter" });

    await waitFor(async () => {
      const second = (await db.tasks.toArray()).find((t) => t.title === "Task without notes");
      expect(second).toBeDefined();
      expect(second?.notes).toBe("");
    });

    // Write failure rolls back both title and description inputs
    useCommandStore.setState({
      createTask: vi.fn(async () => false),
    });
    fireEvent.change(titleInput, { target: { value: "Unsaved task" } });
    fireEvent.change(descInput, { target: { value: "Keep my draft on error" } });
    fireEvent.keyDown(titleInput, { key: "Enter" });

    await waitFor(() => {
      expect(titleInput.value).toBe("Unsaved task");
      expect(descInput.value).toBe("Keep my draft on error");
    });
  });

  it("creates Tasks with optional descriptions from PlanWeekView and QuestMatrixPanel", async () => {
    await db.quests.add(makeQuest("q-desc", 0, "Deep Research", "sky", "Initial quest goal"));

    const { unmount } = render(<PlanWeekView />);
    const planDescInputs = await screen.findAllByPlaceholderText("Description (optional)...");
    expect(planDescInputs.length).toBeGreaterThanOrEqual(1);

    const firstDayDesc = planDescInputs[0] as HTMLInputElement;
    const dayBox = firstDayDesc.parentElement!.parentElement!;
    const firstDayTitle = dayBox.querySelector('input[placeholder="Add a task..."]') as HTMLInputElement;

    fireEvent.change(firstDayTitle, { target: { value: "Planned milestone" } });
    fireEvent.change(firstDayDesc, { target: { value: "Bring benchmark numbers" } });
    fireEvent.keyDown(firstDayDesc, { key: "Enter" });

    await waitFor(async () => {
      const planned = (await db.tasks.toArray()).find((t) => t.title === "Planned milestone");
      expect(planned?.notes).toBe("Bring benchmark numbers");
    });
    unmount();

    // QuestMatrixPanel: create a Quest with optional description + create a Task under a Quest with optional description
    render(<QuestMatrixPanel />);
    const newQuestBtn = await screen.findByRole("button", { name: /New Quest/i });
    fireEvent.click(newQuestBtn);

    fireEvent.change(screen.getByLabelText("Quest Title"), { target: { value: "Fitness Block" } });
    fireEvent.change(screen.getByLabelText(/Description/i), { target: { value: "Zone 2 + strength" } });
    fireEvent.click(screen.getByRole("button", { name: "Rose" }));
    fireEvent.click(screen.getByRole("button", { name: /Create Quest/i }));

    await waitFor(async () => {
      const createdQuest = (await db.quests.toArray()).find((q) => q.title === "Fitness Block");
      expect(createdQuest).toBeDefined();
      expect(createdQuest?.description).toBe("Zone 2 + strength");
      expect(createdQuest?.accentColor).toBe("rose");
    });

    const questTaskTitle = screen.getByPlaceholderText("Add task to Deep Research...");
    const questTaskDesc = screen.getByLabelText("Task description for Deep Research (optional)");
    fireEvent.change(questTaskTitle, { target: { value: "Read paper section 4" } });
    fireEvent.change(questTaskDesc, { target: { value: "Focus on ablation table" } });
    fireEvent.keyDown(questTaskDesc, { key: "Enter" });

    await waitFor(async () => {
      const qTask = (await db.tasks.toArray()).find((t) => t.title === "Read paper section 4");
      expect(qTask?.notes).toBe("Focus on ablation table");
      expect(qTask?.questId).toBe("q-desc");
    });
  });

  it("creates a Habit with optional description on Desktop and materializes today's task with those notes", async () => {
    render(<HabitsView />);
    await waitFor(() => {
      expect(screen.queryByTestId("habits-loading-skeleton")).toBeNull();
    });

    const habitTitle = screen.getByLabelText("Add a daily habit");
    const habitDesc = screen.getByLabelText("Habit description (optional)");

    fireEvent.change(habitTitle, { target: { value: "Evening Mobility" } });
    fireEvent.change(habitDesc, { target: { value: "Hips, ankles, thoracic spine" } });
    fireEvent.submit(habitTitle.closest("form")!);

    await waitFor(async () => {
      const habits = await db.habits.toArray();
      expect(habits).toHaveLength(1);
      expect(habits[0].title).toBe("Evening Mobility");
      expect(habits[0].notes).toBe("Hips, ankles, thoracic spine");

      const tasks = await db.tasks.toArray();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].habitId).toBe(habits[0].id);
      expect(tasks[0].notes).toBe("Hips, ankles, thoracic spine");
    });
  });

  it("creates Tasks, Habits (including Ctrl+Enter), and Quests with optional descriptions on Mobile/Tablet", () => {
    const w = loadMobile();
    try {
      // 1. Mobile Task with optional description
      w.openNewTaskSheet(null);
      const tTitle = w.document.getElementById("sheetTaskTitle") as HTMLInputElement;
      const tNotes = w.document.getElementById("sheetTaskNotes") as HTMLTextAreaElement;
      expect(tNotes).not.toBeNull();
      tTitle.value = "Tablet Sketch";
      tNotes.value = EDGE_DESC;
      w.eval("submitNewTaskFromSheet(true)");

      let st = readState(w);
      const createdTask = st.tasks.find((t) => t.title === "Tablet Sketch");
      expect(createdTask?.notes).toBe(EDGE_DESC);
      expect(w.document.getElementById("mainContainer")?.textContent).toContain("Verify <img");
      expect(w.__pwned).toBeUndefined();

      // 2. Mobile Quest with optional description and new color ("lime")
      w.switchView("quests");
      w.openNewQuestSheet();
      const qTitle = w.document.getElementById("newQuestTitleInput") as HTMLInputElement;
      const qDesc = w.document.getElementById("newQuestDescInput") as HTMLTextAreaElement;
      qTitle.value = "Lime Sprint";
      qDesc.value = "Optional quest goal on tablet";
      w.eval("selectedQuestColor='lime'; createNewQuestFromSheet();");

      st = readState(w);
      const createdQuest = st.quests.find((q) => q.title === "Lime Sprint");
      expect(createdQuest?.description).toBe("Optional quest goal on tablet");
      expect(createdQuest?.accentColor).toBe("lime");

      // 3. Mobile Habit with optional description via Ctrl+Enter
      w.switchView("habits");
      w.eval("openNewHabitSheet()");
      const hTitle = w.document.getElementById("newHabitTitleInput") as HTMLInputElement;
      const hNotes = w.document.getElementById("newHabitNotesInput") as HTMLTextAreaElement;
      expect(hNotes.getAttribute("aria-label")).toBe("Habit description");
      hTitle.value = "Hydrate 500ml";
      hNotes.value = "Right after waking up";
      hNotes.dispatchEvent(
        new w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })
      );

      st = readState(w);
      const habits = (st.habits as Array<{ id: string; title: string; notes?: string }>) ?? [];
      const createdHabit = habits.find((h) => h.title === "Hydrate 500ml");
      expect(createdHabit?.notes).toBe("Right after waking up");
      const habitTask = st.tasks.find((t) => t.habitId === createdHabit?.id);
      expect(habitTask?.notes).toBe("Right after waking up");
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Statistics Accuracy & Appeal (Zero, Small <6m, Scope Isolation, Large Data, Fuzz)
// ---------------------------------------------------------------------------
describe("Statistics accuracy & visual rendering across small and large datasets", () => {
  it("formats boundary durations cleanly without NaN/Infinity or hiding sub-6m sessions", () => {
    expect(formatTelemetryDuration(0)).toBe("0.0h");
    expect(formatTelemetryDuration(0, { zeroAs: "0h" })).toBe("0h");
    expect(formatTelemetryDuration(-25)).toBe("0.0h");
    expect(formatTelemetryDuration(Number.NaN)).toBe("0.0h");
    expect(formatTelemetryDuration(Number.POSITIVE_INFINITY)).toBe("0.0h");
    expect(formatTelemetryDuration(45)).toBe("45s");
    expect(formatTelemetryDuration(125)).toBe("2m");
    expect(formatTelemetryDuration(299)).toBe("5m");
    expect(formatTelemetryDuration(359)).toBe("6m");
    expect(formatTelemetryDuration(360)).toBe("0.1h");
    expect(formatTelemetryDuration(3600 * 105, { compactLarge: true })).toBe("105h");
    expect(formatTelemetryDuration(3600 * 1500, { compactLarge: true })).toBe("1.5kh");
  });

  it("handles tiny (<6m) sessions accurately in computePeriodReport, computeActivityHeatmap, Desktop UI, and Mobile UI", async () => {
    const todayKey = "2026-06-17";
    const yesterdayKey = "2026-06-16";
    const anchor = new Date(2026, 5, 17, 14, 0, 0).getTime();

    const quests: Quest[] = [makeQuest("q-small", 0, "Micro Practice", "purple", "", 5)];
    const tasks: Task[] = [];
    // 45s on quest today, plus an unassigned ("OTHER") log yesterday to verify activeDays scope isolation!
    const logs: TimeLog[] = [
      makeTimeLog({
        id: "log-45s",
        taskId: "t-1",
        taskTitleSnapshot: "Quick Drill",
        questId: "q-small",
        accentColorSnapshot: "purple",
        startTime: anchor - 60_000,
        durationSeconds: 45,
        dateKey: todayKey,
      }),
      makeTimeLog({
        id: "log-other",
        taskId: "t-2",
        taskTitleSnapshot: "Ad-hoc Admin",
        questId: null,
        startTime: anchor - 86_400_000,
        durationSeconds: 1800,
        dateKey: yesterdayKey,
      }),
    ];

    const weekWin = buildHorizonWindow("week", 0, todayKey);
    const weekAll = computePeriodReport({
      window: weekWin,
      logs,
      tasks,
      quests,
      scope: "ALL",
      todayKey,
    });
    expect(weekAll.questSeconds).toBe(45);
    expect(weekAll.otherSeconds).toBe(1800);
    expect(weekAll.grandTotalSeconds).toBe(1845);
    // Quest activeDaysCount must ONLY count days with quest activity (1 day), NOT yesterday's OTHER log!
    expect(weekAll.activeDaysCount).toBe(1);
    expect(weekAll.dailyAverageSeconds).toBe(45);
    expect(weekAll.avgSessionMinutes).toBe(1);
    expect(weekAll.longestSessionMinutes).toBe(1);
    expect(weekAll.peakBucket?.seconds).toBe(45);

    const hm = computeActivityHeatmap({
      logs,
      tasks,
      scope: "q-small",
      todayKey,
    });
    const todayCell = hm.columns.flatMap((col) => col.cells).find((c) => c.dateKey === todayKey);
    expect(todayCell?.seconds).toBe(45);
    expect(todayCell?.level).toBe(1);

    // Render Desktop Review with the 45s session
    const liveNow = Date.now();
    const liveKey = toLocalDateKey(liveNow);
    await db.quests.bulkAdd(quests);
    await db.timeLogs.bulkAdd([
      makeTimeLog({
        id: "live-45s",
        taskId: "t-1",
        taskTitleSnapshot: "Quick Drill",
        questId: "q-small",
        accentColorSnapshot: "purple",
        startTime: liveNow - 50_000,
        durationSeconds: 45,
        dateKey: liveKey,
      }),
    ]);

    render(<TelemetryDashboardView />);
    await waitFor(() => {
      expect(screen.getAllByText("45s").length).toBeGreaterThan(0);
    });

    // Mobile Review ("telemetry") with 45s session
    const w = loadMobile({
      seedState: {
        quests,
        tasks: [],
        habits: [],
        timeLogs: [
          {
            id: "m-log-45s",
            taskId: "t-1",
            taskTitleSnapshot: "Quick Drill",
            questId: "q-small",
            startTime: liveNow - 50_000,
            endTime: liveNow - 5_000,
            durationSeconds: 45,
            dateKey: liveKey,
          },
        ],
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });
    try {
      w.switchView("telemetry");
      const text = w.document.getElementById("mainContainer")?.textContent ?? "";
      expect(text).toContain("45s");
      expect(text).not.toContain("NaN");
    } finally {
      w.close();
    }
  });

  it("paginates large session logs (135 rows) cleanly at 50 per page on Desktop and Mobile", async () => {
    const now = Date.now();
    const todayKey = toLocalDateKey(now);
    const quest = makeQuest("q-large", 0, "Scale Engine", "orange", "", 40);
    const logs: TimeLog[] = Array.from({ length: 135 }, (_, i) =>
      makeTimeLog({
        id: `log-bulk-${i}`,
        taskId: `t-bulk-${i}`,
        taskTitleSnapshot: `Deep Session #${i + 1}`,
        questId: "q-large",
        accentColorSnapshot: "orange",
        startTime: now - (i + 1) * 1000,
        durationSeconds: 36_000, // 10h each -> 1,350h total!
        dateKey: todayKey,
      })
    );

    await db.quests.add(quest);
    await db.timeLogs.bulkAdd(logs);

    render(<TelemetryDashboardView />);

    const openLogsBtn = await screen.findByRole("button", { name: /View Session Log \(135 sessions/i });
    fireEvent.click(openLogsBtn);

    const showMoreBtn = await screen.findByTestId("review-logs-show-more");
    expect(showMoreBtn.textContent).toContain("85 remaining");
    expect(screen.getByText("Deep Session #1")).toBeTruthy();
    expect(screen.queryByText("Deep Session #51")).toBeNull();

    fireEvent.click(showMoreBtn);
    await waitFor(() => {
      expect(screen.getByText("Deep Session #51")).toBeTruthy();
      expect(screen.getByTestId("review-logs-show-more").textContent).toContain("35 remaining");
    });

    fireEvent.click(screen.getByTestId("review-logs-show-more"));
    await waitFor(() => {
      expect(screen.getByText("Deep Session #135")).toBeTruthy();
      expect(screen.queryByTestId("review-logs-show-more")).toBeNull();
    });

    // Verify Mobile Review ("telemetry") also paginates 135 sessions at 50 per page
    const w = loadMobile({
      seedState: {
        quests: [quest],
        tasks: [],
        habits: [],
        timeLogs: logs,
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });
    try {
      w.switchView("telemetry");
      w.eval("showReviewSessionLog=true;renderApp();");
      const mBtn = w.document.querySelector('[data-testid="mobile-logs-show-more"]');
      expect(mBtn).not.toBeNull();
      expect(mBtn?.textContent).toContain("85 remaining");
      mobileClick(w, mBtn);
      expect(w.document.querySelector('[data-testid="mobile-logs-show-more"]')?.textContent).toContain(
        "35 remaining"
      );
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });

  it("expands early/late timeline hours and lays out concurrent overlapping sessions without collision", () => {
    const dayStart = new Date(2026, 5, 17, 0, 0, 0).getTime();
    const hm = (h: number, m: number) => dayStart + (h * 60 + m) * 60_000;

    const layout = layoutTimelineBlocks(
      [
        { id: "early", startTime: hm(5, 30), durationSeconds: 45 * 60 },
        { id: "overlap-1", startTime: hm(10, 0), durationSeconds: 90 * 60 },
        { id: "overlap-2", startTime: hm(10, 15), durationSeconds: 45 * 60 },
        { id: "overlap-3", startTime: hm(10, 20), durationSeconds: 100 * 60 },
        { id: "overlap-4", startTime: hm(10, 25), durationSeconds: 25 * 60 },
        { id: "overlap-5", startTime: hm(10, 30), durationSeconds: 25 * 60 },
        { id: "late", startTime: hm(23, 15), durationSeconds: 35 * 60 },
      ],
      8,
      22
    );

    expect(layout.windowStartHour).toBe(5);
    expect(layout.windowEndHour).toBe(24);
    expect(layout.placements.size).toBe(7);

    for (const p of Array.from(layout.placements.values())) {
      expect(p.colIndex).toBeGreaterThanOrEqual(0);
      expect(p.colIndex).toBeLessThan(4);
      expect(p.totalCols).toBeGreaterThanOrEqual(1);
      expect(p.totalCols).toBeLessThanOrEqual(4);
      expect(p.endHour).toBeGreaterThan(p.startHour);
    }

    const overlapCols = ["overlap-1", "overlap-2", "overlap-3", "overlap-4"].map(
      (id) => layout.placements.get(id)?.colIndex
    );
    expect(new Set(overlapCols).size).toBe(4);
  });

  it("conserves exact seconds and stays NaN-free across 100 seeded fuzz datasets over all 8 quest colors", () => {
    const anchor = new Date(2026, 7, 20, 15, 0, 0).getTime();
    const todayKey = toLocalDateKey(anchor);
    const weekWin = buildHorizonWindow("week", 0, todayKey);
    const rand = mulberry32(0x180077);

    for (let iter = 0; iter < 100; iter++) {
      const count = 1 + Math.floor(rand() * 3);
      const quests: Quest[] = Array.from({ length: count }, (_, idx) => {
        const accent = QUEST_ACCENT_KEYS[Math.floor(rand() * QUEST_ACCENT_KEYS.length)];
        return makeQuest(
          `q-${idx}`,
          idx as 0 | 1 | 2,
          `Quest ${accent}`,
          accent,
          "",
          Math.floor(rand() * 30)
        );
      });

      const logCount = Math.floor(rand() * 25);
      const logs: TimeLog[] = Array.from({ length: logCount }, (_, i) => {
        const dayOffset = -Math.floor(rand() * 14);
        const ts = anchor + dayOffset * 86_400_000;
        const dur = rand() < 0.3 ? Math.floor(rand() * 120) + 1 : Math.floor(rand() * 7200);
        const qPick = rand() < 0.25 ? null : quests[Math.floor(rand() * quests.length)].id;
        return makeTimeLog({
          id: `flog-${iter}-${i}`,
          taskId: `ft-${i}`,
          taskTitleSnapshot: `Task ${i}`,
          questId: qPick,
          startTime: ts,
          durationSeconds: dur,
          dateKey: toLocalDateKey(ts),
        });
      });

      const report = computePeriodReport({
        window: weekWin,
        logs,
        tasks: [],
        quests,
        scope: "ALL",
        todayKey,
      });
      const msg = `iter=${iter}`;
      expect(Number.isFinite(report.focusHours), msg).toBe(true);
      expect(Number.isFinite(report.dailyAverageHours), msg).toBe(true);
      expect(report.grandTotalSeconds, msg).toBe(report.questSeconds + report.otherSeconds);

      const bucketSum = report.buckets.reduce((s, b) => s + b.seconds, 0);
      expect(bucketSum, msg).toBe(report.questSeconds);

      const hm = computeActivityHeatmap({
        logs,
        tasks: [],
        scope: "ALL",
        todayKey,
      });
      expect(Number.isFinite(hm.totalHours), msg).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. All 8 Quest Colors & Tablet Responsive Layout
// ---------------------------------------------------------------------------
describe("8 Quest colors end-to-end & Tablet layout in Hunt Mobile", () => {
  it("accepts all 8 quest colors in validateSyncPayload and ReviewHeatmapCard while keeping unknown colors safe", () => {
    const quests = QUEST_ACCENT_KEYS.map((color, idx) =>
      makeQuest(`q-col-${idx}`, (idx % 3) as 0 | 1 | 2, `Color ${color}`, color, "", 5)
    );

    const validated = validateSyncPayload({
      quests,
      tasks: [],
      habits: [],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedHabitIds: [],
      deletedLogIds: [],
    });
    expect(validated.valid).toBe(true);
    expect(validated.payload?.quests.map((q) => q.accentColor)).toEqual([...QUEST_ACCENT_KEYS]);

    // Render ReviewHeatmapCard with each of the 8 colors active
    const now = Date.now();
    const todayKey = toLocalDateKey(now);
    const logs: TimeLog[] = quests.map((q, idx) =>
      makeTimeLog({
        id: `hm-log-${idx}`,
        taskId: `hm-t-${idx}`,
        taskTitleSnapshot: q.title,
        questId: q.id,
        accentColorSnapshot: q.accentColor,
        startTime: now - 60_000,
        durationSeconds: 1200,
        dateKey: todayKey,
      })
    );

    const baseHm = computeActivityHeatmap({
      logs,
      tasks: [],
      scope: "ALL",
      todayKey,
    });

    const { rerender, container } = render(
      <ReviewHeatmapCard heatmap={baseHm} scopeTitle="All quests" paletteAccent="amber" />
    );
    for (const q of quests) {
      const qHm = computeActivityHeatmap({
        logs,
        tasks: [],
        scope: q.id,
        todayKey,
      });
      rerender(<ReviewHeatmapCard heatmap={qHm} scopeTitle={q.title} paletteAccent={q.accentColor} />);
      expect(container.querySelector('[data-testid="activity-heatmap"]')).not.toBeNull();
      expect(QUEST_ACCENT_STYLES[q.accentColor].hex).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("renders all 8 quest color swatches and multi-column Tablet responsive grids in hunt-mobile.html", () => {
    const html = fs.readFileSync(path.join(ROOT, "public", "hunt-mobile.html"), "utf8");
    expect(html).toContain("@media (min-width: 768px)");
    expect(html).toContain("@media (min-width: 1120px)");
    expect(html).toContain(".today-tablet-split");
    expect(html).toContain(".quests-grid");
    expect(html).toContain(".habits-grid");
    expect(html).toContain(".review-tablet-split");
    expect(html).toContain(".guide-workshop-split");

    const now = Date.now();
    const w = loadMobile({
      seedState: {
        quests: QUEST_ACCENT_KEYS.map((c, idx) => ({
          id: `mq-${c}`,
          slotIndex: idx % 3,
          title: `Quest ${c}`,
          description: `Desc ${c}`,
          accentColor: c,
          targetWeeklyHours: 6,
          archived: false,
          createdAt: 1000,
          updatedAt: 1000,
        })),
        tasks: [
          {
            id: "mt-1",
            title: "Tablet Priority Task",
            notes: "Side-by-side with Day Timeline on tablet",
            status: "queued",
            questId: "mq-purple",
            rank: 1000,
            accumulatedSeconds: 180,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        habits: [
          {
            id: "mh-1",
            title: "Daily Stretch",
            notes: "5 min",
            questId: "mq-rose",
            rank: 1000,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        timeLogs: [
          {
            id: "ml-1",
            taskId: "mt-1",
            taskTitleSnapshot: "Tablet Priority Task",
            questId: "mq-purple",
            startTime: now - 1800_000,
            endTime: now - 600_000,
            durationSeconds: 1200,
            dateKey: toLocalDateKey(now),
          },
        ],
        activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      },
    });

    try {
      // TODAY ("command") view renders both queue pane and timeline pane inside .today-tablet-split
      expect(w.document.querySelector(".today-tablet-split")).not.toBeNull();
      expect(w.document.querySelector(".today-queue-pane")).not.toBeNull();
      expect(w.document.querySelector(".today-timeline-pane")).not.toBeNull();

      // QUESTS ("quests") view renders .quests-grid and 8 color options in New Quest & Edit Quest sheets
      w.switchView("quests");
      expect(w.document.querySelector(".quests-grid")).not.toBeNull();
      w.openNewQuestSheet();
      expect(w.document.querySelectorAll("#sheetContainer .sheet-pill[data-color]")).toHaveLength(8);
      w.closeSheet(true);

      w.openQuestEditorSheet("mq-purple");
      expect(w.document.querySelectorAll("#sheetContainer .sheet-pill[data-color]")).toHaveLength(8);
      w.closeSheet(true);

      // HABITS ("habits") view renders .habits-grid
      w.switchView("habits");
      expect(w.document.querySelector(".habits-grid")).not.toBeNull();

      // REVIEW ("telemetry") view renders .review-tablet-split
      w.switchView("telemetry");
      expect(w.document.querySelector(".review-tablet-split")).not.toBeNull();

      // GUIDE ("guide") view renders .guide-principles-grid, .guide-workshop-split, and 8 workshop color pills
      w.eval("openGuideView('quests')");
      expect(w.document.querySelector(".guide-principles-grid")).not.toBeNull();
      w.eval("openGuideView('workshop'); guideLabMode='quest'; renderApp();");
      expect(w.document.querySelector(".guide-workshop-split")).not.toBeNull();
      expect(w.document.querySelectorAll('[aria-label="Quest accent color"] button')).toHaveLength(8);

      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Desktop Fullscreen Window Controls (Minimize, Restore/Fullscreen, Exit) & Icon Cache Busting
// ---------------------------------------------------------------------------
describe("Desktop fullscreen window controls & Falcon shortcut icon refresh", () => {
  afterEach(() => {
    setWin32ActionExecutorForTests(null);
  });

  it("renders Minimize, Fullscreen/Restore, and Exit controls in TopTelemetryBar and FocusHudView", async () => {
    const token = "a".repeat(64);
    window.localStorage.setItem("hunt-sync-token-v1", token);

    const fetchCalls: Array<{ url: string; action: string; token: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const body = init?.body ? (JSON.parse(String(init.body)) as { action: string }) : { action: "" };
        fetchCalls.push({
          url,
          action: body.action,
          token: headers.get("X-Hunt-Token"),
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, found: true, action: body.action }),
        } as unknown as Response;
      })
    );

    // Simulate OS/Browser --start-fullscreen where document.fullscreenElement is null
    // but innerWidth/innerHeight match screen.width/screen.height.
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: { width: 1920, height: 1080 },
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });

    const bar = render(<TopTelemetryBar />);
    const minBtn = screen.getByRole("button", { name: "Minimize window" });
    const fsBtn = screen.getByRole("button", { name: "Exit fullscreen" });
    const exitBtn = screen.getByRole("button", { name: "Exit Hunt" });

    expect(fsBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(minBtn);
    });
    expect(fetchCalls.at(-1)).toEqual({
      url: "/api/window",
      action: "minimize",
      token,
    });

    await act(async () => {
      fireEvent.click(fsBtn);
    });
    expect(fetchCalls.at(-1)?.action).toBe("exit-fullscreen");

    // Resize to windowed dimensions updates button state to "Enter fullscreen"
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 980 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const enterFsBtn = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enterFsBtn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(exitBtn);
    });
    expect(fetchCalls.at(-1)?.action).toBe("close");
    bar.unmount();

    // Verify FocusHudView also exposes Minimize, Fullscreen, and Exit Hunt controls (idle & active)
    const focusIdle = render(<FocusHudView />);
    expect(await screen.findByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit Hunt" })).toBeTruthy();
    focusIdle.unmount();

    await db.tasks.add({
      id: "t-focus-win",
      title: "Fullscreen Focus Task",
      notes: "",
      status: "active",
      questId: null,
      rank: 1000,
      accumulatedSeconds: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });
    useCommandStore.setState({ activeView: "focus", activeTaskId: "t-focus-win" });

    const focusActive = render(<FocusHudView />);
    expect(await screen.findByText("Fullscreen Focus Task")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit Hunt" })).toBeTruthy();
    focusActive.unmount();
  });

  it("enforces localhost + X-Hunt-Token auth on POST /api/window and dispatches valid actions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-win-api-"));
    const prevDataDir = process.env.HUNT_DATA_DIR;
    process.env.HUNT_DATA_DIR = tmpDir;
    const secret = "b".repeat(64);
    fs.writeFileSync(path.join(tmpDir, "hunt-sync.key"), secret, "utf8");

    const dispatched: DesktopWindowAction[] = [];
    setWin32ActionExecutorForTests(async (action) => {
      dispatched.push(action);
      return { ok: true, found: true };
    });

    try {
      // 1. Rejects non-localhost Host header (e.g. LAN peer)
      const lanRes = await windowRoutePost(
        new Request("http://192.168.1.50:3000/api/window", {
          method: "POST",
          headers: {
            host: "192.168.1.50:3000",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "minimize" }),
        })
      );
      expect(lanRes.status).toBe(403);

      // 2. Rejects cross-origin Origin header even on localhost
      const csrfRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            origin: "https://evil.example",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "close" }),
        })
      );
      expect(csrfRes.status).toBe(403);

      // 3. Rejects missing or wrong X-Hunt-Token
      const unauthRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            "content-type": "application/json",
            "x-hunt-token": "wrong",
          },
          body: JSON.stringify({ action: "minimize" }),
        })
      );
      expect(unauthRes.status).toBe(401);

      // 4. Rejects unknown action
      const badActionRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "reboot" }),
        })
      );
      expect(badActionRes.status).toBe(400);

      // 5. Dispatches all valid actions cleanly
      for (const action of [
        "minimize",
        "exit-fullscreen",
        "enter-fullscreen",
        "close",
      ] as const) {
        const okRes = await windowRoutePost(
          new Request("http://localhost:3000/api/window", {
            method: "POST",
            headers: {
              host: "localhost:3000",
              origin: "http://localhost:3000",
              "content-type": "application/json",
              "x-hunt-token": secret,
            },
            body: JSON.stringify({ action }),
          })
        );
        expect(okRes.status).toBe(200);
        const json = (await okRes.json()) as { ok: boolean; action: string };
        expect(json.ok).toBe(true);
        expect(json.action).toBe(action);
      }
      expect(dispatched).toEqual([
        "minimize",
        "exit-fullscreen",
        "enter-fullscreen",
        "close",
      ]);
    } finally {
      if (prevDataDir === undefined) delete process.env.HUNT_DATA_DIR;
      else process.env.HUNT_DATA_DIR = prevDataDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("compiles native Win32 window helper cleanly on Windows and configures HUNT-Falcon.ico cache busting", async () => {
    if (process.platform === "win32") {
      const exe = await ensureCompiledWinCtlHelper();
      expect(exe).not.toBeNull();
      expect(fs.existsSync(exe!)).toBe(true);
    }

    const vbs = fs.readFileSync(path.join(ROOT, "Launch-Hunt.vbs"), "utf8");
    expect(vbs).toContain("RefreshHuntShortcuts");
    expect(vbs).toContain("HUNT-Falcon.ico");
    expect(vbs).toContain("MonitorFromWindow");

    const iss = fs.readFileSync(path.join(ROOT, "installer", "hunt-desktop.iss"), "utf8");
    expect(iss).toContain("HUNT-Falcon.ico");
    expect(iss).toContain("ChangesAssociations=yes");

    const workflow = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "release.yml"),
      "utf8"
    );
    expect(workflow).toContain("HUNT-Falcon.ico");
  });
});
