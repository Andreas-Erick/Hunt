// The shared "complete a Task" rule (completeTaskRow in taskQueue.ts, exported by HuntCore). The
// phone's direct completion and the desktop store's completion both build the completed row with it,
// so the same Task completed at the same time is the same row on either device.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeTaskRow } from "@/mobile/huntCore";
import type { Task } from "@/lib/domainTypes";
import { db } from "@/lib/db";
import { useCommandStore } from "@/store/useCommandStore";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "tsk-1",
    title: "Write report",
    notes: "draft first",
    questId: "quest-1",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 120,
    scheduledDate: "2026-11-22",
    createdAt: 10,
    updatedAt: 500,
    ...overrides,
  };
}

describe("completeTaskRow", () => {
  it("marks the Task completed at the given time and stamps it at that time", () => {
    const before = task();
    const done = completeTaskRow(before, 9_000);
    expect(done).toEqual({ ...before, status: "completed", completedAt: 9_000, updatedAt: 9_000 });
    expect(before.status).toBe("queued"); // the input row is not modified
  });

  it("stamps newer than a row from a clock that runs ahead (R6)", () => {
    const done = completeTaskRow(task({ updatedAt: 20_000 }), 9_000);
    expect(done.completedAt).toBe(9_000);
    expect(done.updatedAt).toBe(20_001);
  });
});

describe("phone and desktop complete a Task through the shared rule", () => {
  const NOW = new Date(2026, 10, 22, 14, 30).getTime();
  let page: MobileWindow | null = null;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await db.tasks.clear();
  });

  afterEach(() => {
    page?.close();
    page = null;
    vi.useRealTimers();
  });

  type CoreHolder = { HuntCore: { completeTaskRow: typeof completeTaskRow } };

  function phoneCompletes(row: Task, onPage?: (w: MobileWindow) => void): Record<string, unknown> {
    page = loadMobile({ seedState: { quests: [], tasks: [row], timeLogs: [] } });
    onPage?.(page);
    page.completeTaskDirect(row.id);
    const done = readState(page).tasks.find((t) => t.id === row.id);
    if (!done) throw new Error("phone lost the task");
    return { ...done };
  }

  async function desktopCompletes(row: Task): Promise<Task> {
    await db.tasks.add(row);
    await useCommandStore.getState().completeTaskById(row.id);
    const done = await db.tasks.get(row.id);
    if (!done) throw new Error("desktop lost the task");
    return done;
  }

  it.each([
    ["an ordinary Task", task({ id: "tsk-a" })],
    ["a Task stamped by a clock that runs ahead", task({ id: "tsk-b", updatedAt: NOW + 60_000 })],
  ])("produces the same completed row for %s", async (_label, row) => {
    const phone = phoneCompletes(row);
    const desktop = await desktopCompletes(row);
    expect(phone).toEqual(desktop);
    expect(desktop).toEqual(completeTaskRow(row, NOW));
  });

  it("the phone's direct completion goes through HuntCore.completeTaskRow, and its Undo still restores the Task", () => {
    const row = task({ id: "tsk-c" });
    const calls: string[] = [];
    phoneCompletes(row, (w) => {
      // The bundle's exports are getters, so the page's global is swapped for a recording copy.
      const holder = w as unknown as CoreHolder;
      const shared = holder.HuntCore.completeTaskRow;
      holder.HuntCore = {
        ...holder.HuntCore,
        completeTaskRow: (t, at) => {
          calls.push(t.id);
          return shared(t, at);
        },
      };
    });
    expect(calls).toEqual(["tsk-c"]);
    const undo = page!.document.querySelector<HTMLButtonElement>(".toast-action");
    expect(undo, "Undo button in the toast").not.toBeNull();
    undo!.click();
    const restored = readState(page!).tasks.find((t) => t.id === "tsk-c");
    expect(restored?.status).toBe("queued");
    expect(restored?.completedAt).toBeUndefined();
  });
});
