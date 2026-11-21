import React from "react";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { db } from "@/lib/db";
import { toLocalDateKey } from "@/lib/dateUtils";
import { QUEST_PRINCIPLES } from "@/lib/questScienceContent";
import { useCommandStore } from "@/store/useCommandStore";
import { CommandCenterView } from "@/components/CommandCenterView";
import { PlanWeekView } from "@/components/PlanWeekView";
import { FocusHudView } from "@/components/FocusHudView";
import { QuestMatrixPanel } from "@/components/QuestMatrixPanel";
import { HabitsView } from "@/components/HabitsView";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { GuideView } from "@/components/GuideView";
import { MobileSyncModal } from "@/components/MobileSyncModal";

const ROOT = process.cwd();
const GLOBALS_CSS = fs.readFileSync(
  path.join(ROOT, "src", "app", "globals.css"),
  "utf8"
);
const MOBILE_HTML = fs.readFileSync(
  path.join(ROOT, "public", "hunt-mobile.html"),
  "utf8"
);

describe("Focus Pass 15 — Intrinsic Fluid Layouts & Multi-Viewport Adaptation (320px to 4K+)", () => {
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("offline-test"))
    );
    await Promise.all([
      db.quests.clear(),
      db.tasks.clear(),
      db.timeLogs.clear(),
      db.habits.clear(),
    ]);
    window.localStorage.clear();
    useCommandStore.setState({
      ...useCommandStore.getInitialState(),
      syncNow: vi.fn(async () => false),
      autoSync: vi.fn(async () => false),
      requestSync: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("enforces sticky-safe overflow-x: clip, @container queries, and scroll-shadow cues in globals.css", () => {
    // Sticky-safe root overflow: overflow-x: clip, never body { overflow-x: hidden }
    expect(GLOBALS_CSS).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*clip;/);
    expect(GLOBALS_CSS).not.toMatch(/body\s*\{\s*[^}]*overflow-x:\s*hidden/);

    // Component-level CSS Container Queries
    expect(GLOBALS_CSS).toContain("container-type: inline-size;");
    expect(GLOBALS_CSS).toMatch(/@container\s*\(min-width:/);

    // Pure-CSS scroll-shadow cues for local horizontal scrollers
    expect(GLOBALS_CSS).toContain(".scroll-shadow-x");
    expect(GLOBALS_CSS).toContain("background-attachment: local, local, scroll, scroll;");

    // Short-height (<= 560px, covering 768x500) and narrow (<= 380px, covering 320x568) rules
    expect(GLOBALS_CSS).toMatch(/@media\s*\(max-height:\s*560px\)/);
    expect(GLOBALS_CSS).toMatch(/@media\s*\(max-width:\s*380px\)/);
  });

  it("uses dynamic viewport units (dvh/svh) and @container queries in hunt-mobile.html without orphan vh traps", () => {
    expect(MOBILE_HTML).toContain("min-height: 100dvh;");
    expect(MOBILE_HTML).toContain(
      "max-height: calc(100dvh - var(--safe-top) - var(--eff-kb, 0px) - 28px);"
    );
    expect(MOBILE_HTML).toContain(
      "max-height: min(54dvh, calc(100dvh - var(--safe-top) - var(--eff-kb, 0px) - 28px));"
    );
    expect(MOBILE_HTML).toContain("min-height: 82dvh;");
    expect(MOBILE_HTML).toContain("min-height: 78dvh;");
    expect(MOBILE_HTML).not.toContain('style="min-height:78vh;');

    // Fluid clamp() typography so H:MM:SS never overflows 320px
    expect(MOBILE_HTML).toContain("font-size: clamp(52px, 18vw, 84px);");
    expect(MOBILE_HTML).toContain("container-type: inline-size;");
    expect(MOBILE_HTML).toMatch(/@container\s*\(min-width:\s*400px\)/);
    expect(MOBILE_HTML).toMatch(/@container\s*\(max-width:\s*280px\)/);
    expect(MOBILE_HTML).toContain("max-width: 68ch;");
  });

  it("uses intrinsic minmax(min(100%, ...), 1fr) grids, prose ch caps, and min-w-0 guards across desktop views", async () => {
    const todayKey = toLocalDateKey();
    const longUnbroken = "X".repeat(220);

    await db.quests.put({
      id: "q-fluid",
      slotIndex: 0,
      code: "FLUID",
      title: `Quest_${longUnbroken}`,
      description:
        "Sustained architectural craft with a clear 65ch prose measure cap on ultrawide displays.",
      accentColor: "cyan",
      targetWeeklyHours: 10,
      archived: false,
      createdAt: 1000,
      updatedAt: 1000,
    });
    await db.habits.put({
      id: "hab-fluid",
      title: "Daily Layout Check",
      notes: "Check 320px, 640px, 768x500, 1280px, and 2560px viewports.",
      questId: "q-fluid",
      rank: 1000,
      createdAt: 1000,
      updatedAt: 1000,
    });
    await db.tasks.put({
      id: "t-fluid",
      title: `Task_${longUnbroken}`,
      notes: "Long task notes constrained to readable character measure.",
      questId: "q-fluid",
      status: "queued",
      rank: 1000,
      accumulatedSeconds: 5400,
      scheduledDate: todayKey,
      createdAt: 1000,
      updatedAt: 1000,
    });
    await db.timeLogs.put({
      id: "log-fluid",
      taskId: "t-fluid",
      taskTitleSnapshot: `Task_${longUnbroken}`,
      questId: "q-fluid",
      questCodeSnapshot: "FLUID",
      accentColorSnapshot: "cyan",
      startTime: Date.now() - 5400_000,
      endTime: Date.now(),
      durationSeconds: 5400,
      dateKey: todayKey,
    });

    // 1. PlanWeekView: max-w-[1440px] cap + intrinsic auto-fit 5-day board
    const plan = render(<PlanWeekView />);
    const dayCol = await screen.findAllByTestId("day-column");
    expect(dayCol).toHaveLength(5);
    expect(dayCol[0].parentElement?.className).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))]"
    );
    expect(plan.container.firstElementChild?.className).toContain("max-w-[1440px]");
    plan.unmount();

    // 2. QuestMatrixPanel: intrinsic auto-fill grid + cq-card + 65ch description measure
    const quests = render(<QuestMatrixPanel />);
    const qCard = await screen.findByTestId("quest-card");
    expect(qCard).toHaveClass("cq-card", "min-w-0");
    expect(qCard.parentElement?.className).toContain(
      "grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))]"
    );
    expect(
      screen.getByText(/Sustained architectural craft/)
    ).toHaveClass("max-w-[65ch]", "break-words");
    quests.unmount();

    // 3. HabitsView: cq-card + 70ch notes measure
    const habits = render(<HabitsView />);
    const hRow = await screen.findByTestId("habit-row");
    expect(hRow).toHaveClass("cq-card");
    expect(
      screen.getByText(/Check 320px, 640px/)
    ).toHaveClass("max-w-[70ch]", "break-words");
    habits.unmount();

    // 4. TelemetryDashboardView: viewport-safe Scope popover, Year scroll-shadow-x, & intrinsic KPI grids
    const review = render(<TelemetryDashboardView />);
    const statTasks = await screen.findByTestId("stat-tasks-completed");
    expect(statTasks.parentElement?.className).toContain(
      "grid-cols-[repeat(auto-fit,minmax(min(100%,11.5rem),1fr))]"
    );

    fireEvent.click(screen.getByRole("button", { name: /Filter review scope/i }));
    const listbox = screen.getByRole("listbox", { name: "Quest filter options" });
    expect(listbox.className).toContain("w-[min(16rem,calc(100vw-2rem))]");
    expect(listbox.className).toContain("max-h-[min(22rem,70dvh)]");
    expect(listbox).toHaveClass("overflow-y-auto");

    fireEvent.click(screen.getByRole("button", { name: "Year" }));
    const yearBuckets = await screen.findAllByTestId("review-bucket");
    expect(yearBuckets).toHaveLength(12);
    expect(yearBuckets[0].parentElement?.className).toContain("min-w-[21rem]");
    expect(yearBuckets[0].parentElement?.parentElement).toHaveClass(
      "scroll-shadow-x",
      "overflow-x-auto"
    );
    review.unmount();

    // 5. GuideView: cq-card + cq-two-col @container grid + 68ch prose cap
    const guide = render(<GuideView />);
    const principle = screen.getByTestId(`principle-${QUEST_PRINCIPLES[0].id}`);
    expect(principle).toHaveClass("cq-card", "min-w-0");
    expect(principle.querySelector(".cq-two-col")).not.toBeNull();
    guide.unmount();

    // 6. CommandCenterView & FocusHudView & MobileSyncModal short-height / dvh safety
    const home = render(<CommandCenterView />);
    expect((await screen.findAllByTestId("task-row")).length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText("Long task notes constrained to readable character measure.")
    ).toHaveClass("max-w-[70ch]");
    home.unmount();

    useCommandStore.setState({ activeView: "focus", activeTaskId: "t-fluid" });
    const focus = render(<FocusHudView />);
    const timer = await screen.findByTestId("focus-timer");
    expect(timer).toHaveClass(
      "focus-fluid-chrono",
      "text-7xl",
      "max-w-full",
      "sm:text-[8.5rem]",
      "md:text-[9.5rem]"
    );
    focus.unmount();

    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    expect(await screen.findByTestId("pairing-qr")).toBeInTheDocument();
    const dialog = screen.getByRole("dialog");
    expect(dialog.firstElementChild?.className).toContain("max-h-[calc(100dvh-1.5rem)]");
    expect(dialog.firstElementChild).toHaveClass("my-auto", "overflow-y-auto");
  });
});
