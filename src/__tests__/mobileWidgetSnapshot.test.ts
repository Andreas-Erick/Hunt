// @vitest-environment node
// The phone page hands the Widget Snapshot to the Android shell after every save (ADR-0006), so the
// Day Widget always draws what the app last saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, type MobileWindow } from "./helpers/loadMobile";

interface Snap {
  look: string;
  todayKey: string;
  days: { dateKey: string; today: { id: string }[] }[];
}

let w: MobileWindow | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 22, 10, 0, 0));
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

const seed = {
  tasks: [
    { id: "tsk-a", title: "Write outline", status: "queued", rank: 1000, notes: "", questId: null },
    { id: "tsk-b", title: "Call bank", status: "queued", rank: 2000, notes: "", questId: null },
  ],
};

function bootWithShell(): Snap[] {
  const snaps: Snap[] = [];
  w = loadMobile({
    bridge: {
      loadState: () => JSON.stringify(seed),
      saveState: () => undefined,
      saveWidgetSnapshot: (json) => {
        snaps.push(JSON.parse(json) as Snap);
      },
    },
  });
  return snaps;
}

const lastIds = (snaps: Snap[]) => snaps[snaps.length - 1].days[0].today.map((r) => r.id);

describe("phone page: Widget Snapshot hand-off", () => {
  it("hands today's list to the shell when the page starts", () => {
    const snaps = bootWithShell();
    expect(snaps[snaps.length - 1].todayKey).toBe("2026-11-22");
    expect(lastIds(snaps)).toEqual(["tsk-a", "tsk-b"]);
  });

  it("hands a fresh snapshot to the shell after a save", () => {
    const snaps = bootWithShell();
    w!.completeTaskDirect("tsk-a");
    vi.advanceTimersByTime(300);
    expect(lastIds(snaps)).toEqual(["tsk-b"]);
  });

  it("republishes with the new look when the look changes", () => {
    const snaps = bootWithShell();
    w!.setLook("dawn");
    expect(snaps[snaps.length - 1].look).toBe("dawn");
  });

  it("does not hand over an unchanged snapshot again", () => {
    const snaps = bootWithShell();
    const before = snaps.length;
    w!.persistState(JSON.stringify({ ...seed, lastSyncedAt: 5 }));
    expect(snaps.length).toBe(before);
  });
});
