// @vitest-environment node
// Phone page: a dated Task's reminder time is set and cleared from Task Options, saved on the Task
// row (so it syncs like every other Task field), and offered only on dated, non-habit Tasks.
// Phone notifications themselves arrive with the Android shell ticket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 25, 8, 0).getTime();
const TODAY = "2026-11-25";

let w: MobileWindow | null = null;

function state(tasks: Record<string, unknown>[]) {
  return {
    quests: [{ id: "quest-1", slotIndex: 0, title: "Launch", description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1 }],
    tasks,
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
  };
}

function task(extra: Record<string, unknown> = {}) {
  return {
    id: "tsk-1",
    title: "Call the bank",
    status: "queued",
    rank: 0,
    questId: "quest-1",
    accumulatedSeconds: 0,
    scheduledDate: TODAY,
    updatedAt: 1,
    ...extra,
  };
}

function reminderInput(p: MobileWindow): HTMLInputElement | null {
  return p.document.querySelector<HTMLInputElement>('#sheetContainer input[aria-label="Reminder time"]');
}

function savedTask(p: MobileWindow) {
  return readState(p).tasks.find((t) => t.id === "tsk-1");
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

describe("phone Task reminder", () => {
  it("sets a reminder time from Task Options and stamps the Task so it syncs", () => {
    const p = (w = loadMobile({ seedState: state([task()]) }));
    p.openTaskInspectorSheet("tsk-1");
    const input = reminderInput(p);
    expect(input).not.toBeNull();
    input!.value = "18:45";
    input!.dispatchEvent(new p.Event("change", { bubbles: true }));
    expect(savedTask(p)?.reminderTime).toBe("18:45");
    expect(Number(savedTask(p)?.updatedAt)).toBeGreaterThan(1);
  });

  it("clears the reminder, leaving the Task date-only", () => {
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]) }));
    p.openTaskInspectorSheet("tsk-1");
    expect(reminderInput(p)?.value).toBe("18:45");
    const clear = Array.from(p.document.querySelectorAll("#sheetContainer button")).find(
      (b) => b.getAttribute("aria-label") === "Clear reminder"
    );
    click(p, clear ?? null);
    expect(savedTask(p)).not.toHaveProperty("reminderTime");
  });

  it("never saves a malformed time", () => {
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]) }));
    // A time input never reports "7pm" (an invalid entry reads as ""), so the save is called directly.
    const page = p as MobileWindow & { setTaskReminder(taskId: string, value: string): void };
    page.setTaskReminder("tsk-1", "7pm");
    expect(savedTask(p)?.reminderTime).toBe("18:45");
  });

  it("offers no reminder on an undated Task or a habit day", () => {
    const p = (w = loadMobile({ seedState: state([task({ scheduledDate: undefined })]) }));
    p.openTaskInspectorSheet("tsk-1");
    expect(reminderInput(p)).toBeNull();
    p.close();
    const h = (w = loadMobile({ seedState: state([task({ habitId: "hab-1", id: "tsk-1" })]) }));
    h.openTaskInspectorSheet("tsk-1");
    expect(reminderInput(h)).toBeNull();
  });
});
