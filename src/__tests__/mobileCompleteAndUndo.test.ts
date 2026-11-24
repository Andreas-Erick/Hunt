// Phone: a double-tap on ✓ completes one Task, and Undo never restores a row
// that points at a Quest deleted since.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
let w: MobileWindow | null = null;

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

function quest(id: string, title: string) {
  return { id, slotIndex: 0, title, description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1 };
}

function task(id: string, title: string, rank: number) {
  return {
    id,
    title,
    status: "queued",
    rank,
    questId: "quest-1",
    accumulatedSeconds: 0,
    scheduledDate: localKey(NOW),
    updatedAt: 1,
  };
}

function load(tasks: unknown[]): MobileWindow {
  w = loadMobile({
    seedState: {
      quests: [quest("quest-1", "Launch")],
      tasks,
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
    },
  });
  return w;
}

const statusOf = (p: MobileWindow, id: string) => readState(p).tasks.find((t) => t.id === id)?.status;

function tapUndo(p: MobileWindow, message: string): void {
  const toast = Array.from(p.document.querySelectorAll("#toastHost .toast")).find((el) =>
    (el.textContent ?? "").includes(message)
  );
  click(p, toast?.querySelector(".toast-action") ?? null);
}

describe("a double-tap on ✓ completes only the Task under the finger", () => {
  it("the second tap, landing on the next Task that moved into the slot, is ignored", () => {
    const p = load([task("tsk-a", "First", 1000), task("tsk-b", "Second", 2000)]);
    p.completeTaskDirect("tsk-a");
    vi.advanceTimersByTime(120);
    p.completeTaskDirect("tsk-b");
    expect(statusOf(p, "tsk-a")).toBe("completed");
    expect(statusOf(p, "tsk-b")).toBe("queued");
    expect(pageErrors(p)).toEqual([]);
  });

  it("a deliberate second completion after the double-tap window still works", () => {
    const p = load([task("tsk-a", "First", 1000), task("tsk-b", "Second", 2000)]);
    p.completeTaskDirect("tsk-a");
    vi.advanceTimersByTime(600);
    p.completeTaskDirect("tsk-b");
    expect(statusOf(p, "tsk-b")).toBe("completed");
  });
});

describe("Undo after the Task's Quest was deleted", () => {
  it("restores the deleted Task without its deleted Quest", () => {
    const p = load([task("tsk-a", "First", 1000)]);
    p.deleteTaskItem("tsk-a");
    p.deleteQuestItem("quest-1");
    tapUndo(p, "First");

    const state = readState(p);
    const restored = state.tasks.find((t) => t.id === "tsk-a");
    expect(restored).toBeDefined();
    expect(restored?.questId).toBeNull();
    expect(restored?.updatedAt).toBeGreaterThan(1);
    expect(state.deletedQuestIds).toContain("quest-1");
    expect(pageErrors(p)).toEqual([]);
  });
});
