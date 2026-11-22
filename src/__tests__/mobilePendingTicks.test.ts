// @vitest-environment node
// Pending Ticks on the phone page (ADR-0006): on boot the page reads the Day Widget's queued ticks
// from the shell, applies them through HuntCore, saves, logs skipped ticks to diagnostics and only
// then acknowledges them, so the shell clears exactly what was applied.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 22, 10, 0, 0).getTime();
const TICKED_AT = new Date(2026, 10, 22, 7, 15, 0).getTime();
const DAY = "2026-11-22";

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

const seed = {
  tasks: [
    { id: "tsk-a", title: "Write outline", status: "queued", rank: 1000, notes: "", questId: null, updatedAt: 500 },
    { id: "tsk-b", title: "Call bank", status: "completed", completedAt: 900, rank: 2000, notes: "", questId: null, updatedAt: 900 },
  ],
};

const ticks = [
  { taskId: "tsk-a", dateKey: DAY, tickedAt: TICKED_AT },
  { taskId: "tsk-b", dateKey: DAY, tickedAt: TICKED_AT },
  { taskId: "tsk-gone", dateKey: DAY, tickedAt: TICKED_AT },
];

interface Shell {
  calls: string[];
  saved: string[];
  acks: string[];
  coreCalls: number;
}

/** What the shell's readPendingTicks answers: the queued ticks plus anything to report (ADR-0006). */
type QueueRead = { ticks: unknown; heldBack?: number; unreadable?: "corrupt" | "malformed" | "read-error"; keptAs?: string };

function boot(options: { queue?: unknown; read?: QueueRead; rawQueue?: string; corrupt?: boolean } = {}): Shell {
  const shell: Shell = { calls: [], saved: [], acks: [], coreCalls: 0 };
  w = loadMobile({
    bridge: {
      loadState: () => (options.corrupt ? "{not json" : JSON.stringify(seed)),
      saveState: (json) => {
        shell.calls.push("saveState");
        shell.saved.push(json);
      },
      saveCorruptState: () => false, // quarantine fails: saving stays blocked
      readPendingTicks: () => {
        shell.calls.push("readPendingTicks");
        return options.rawQueue ?? JSON.stringify(options.read ?? { ticks: options.queue ?? ticks });
      },
      ackPendingTicks: (json) => {
        shell.calls.push("ackPendingTicks");
        shell.acks.push(json);
      },
    },
    beforeBoot: (page) => {
      if (options.corrupt) {
        // No quarantine copy can be kept anywhere, so the page refuses to save (persistBlocked).
        const proto = Object.getPrototypeOf(page.localStorage) as Storage;
        const realSet = proto.setItem;
        proto.setItem = function (this: Storage, key: string, value: string) {
          if (key.startsWith("hunt-mobile-corrupt-")) throw new page.DOMException("full", "QuotaExceededError");
          return realSet.call(this, key, value);
        };
      }
      // The drain runs during boot, so the bundle's `var HuntCore = ...` is caught by an accessor and
      // replaced with a recording copy (its exports are getters and cannot be patched in place).
      type Core = Record<string, unknown> & { applyPendingTicks: (...a: unknown[]) => unknown };
      let core: Core | undefined;
      Object.defineProperty(page, "HuntCore", {
        configurable: true,
        get: () => core,
        set: (bundle: Core) => {
          const shared = bundle.applyPendingTicks;
          core = {
            ...bundle,
            applyPendingTicks: (...args: unknown[]) => {
              shell.coreCalls++;
              return shared(...args);
            },
          };
        },
      });
    },
  });
  return shell;
}

const task = (id: string) => readState(w!).tasks.find((t) => t.id === id);

describe("phone page: Pending Ticks on boot", () => {
  it("applies queued ticks through HuntCore before the first paint, saves, then acknowledges", () => {
    const shell = boot();
    expect(shell.coreCalls).toBe(1);
    expect(task("tsk-a")).toMatchObject({ status: "completed", completedAt: TICKED_AT });
    const saved = JSON.parse(shell.saved[0]) as { tasks: { id: string; status: string }[] };
    expect(saved.tasks.find((t) => t.id === "tsk-a")?.status).toBe("completed");
    expect(shell.calls.indexOf("saveState")).toBeLessThan(shell.calls.indexOf("ackPendingTicks"));
    expect(JSON.parse(shell.acks[0])).toEqual(ticks);
    // The first paint already shows it under Completed today.
    expect(w!.document.querySelector('#mainContainer .queue-item-card.completed[data-flip-task-id="tsk-a"]')).not.toBeNull();
  });

  it("logs each skipped tick to diagnostics with its reason, without titles", () => {
    boot();
    const skipped = w!.__huntDiagnostics
      .getBreadcrumbs()
      .filter((b) => b.event === "tick_skipped")
      .map((b) => b.context);
    expect(skipped).toEqual([
      { taskId: "tsk-b", reason: "already-done" },
      { taskId: "tsk-gone", reason: "missing" },
    ]);
  });

  it("acknowledges ticks that were all stale, so the queue does not grow", () => {
    const shell = boot({ queue: [ticks[2]] });
    expect(shell.saved).toEqual([]);
    expect(JSON.parse(shell.acks[0])).toEqual([ticks[2]]);
  });

  it("does nothing with an empty queue", () => {
    const shell = boot({ queue: [] });
    expect(shell.acks).toEqual([]);
  });

  it("keeps an unreadable queue and logs it", () => {
    const shell = boot({ rawQueue: "[{oops" });
    expect(shell.acks).toEqual([]);
    expect(w!.__huntDiagnostics.getBreadcrumbs().some((b) => b.event === "ticks_unreadable")).toBe(true);
  });

  it("tells the user once when the shell had to set an unreadable queue aside, and logs which copy it kept", () => {
    const keptAs = "hunt-pending-ticks-unreadable-1763800000000.json";
    const shell = boot({ read: { ticks: [], unreadable: "corrupt", keptAs } });
    expect(shell.acks).toEqual([]);
    const toast = w!.document.querySelector("#toastHost .toast-msg")?.textContent ?? "";
    expect(toast).toMatch(/widget/i);
    expect(toast).toMatch(/couldn.t be read/);
    expect(toast).toMatch(/copy was kept/);
    expect(toast).toMatch(/tick those Tasks again/);
    const logged = w!.__huntDiagnostics.getBreadcrumbs().filter((b) => b.event === "ticks_unreadable");
    expect(logged.map((b) => b.context)).toEqual([{ reason: "corrupt", keptAs }]);
    // A second report in the same run is logged but not shown again.
    w!.eval("drainPendingTicks()");
    expect(w!.document.querySelectorAll("#toastHost .toast-msg")).toHaveLength(1);
  });

  it("tells the user when entries that were not ticks were set aside, and applies the ticks it read", () => {
    const keptAs = "hunt-pending-ticks-malformed-1763800000000.json";
    boot({ read: { ticks: [ticks[0]], unreadable: "malformed", keptAs } });
    expect(task("tsk-a")).toMatchObject({ status: "completed" });
    const toast = w!.document.querySelector("#toastHost .toast-msg")?.textContent ?? "";
    expect(toast).toMatch(/copy was kept/);
    expect(toast).not.toMatch(/stay saved/);
  });

  it("tells the user a queue it could not read stays saved, and applies nothing", () => {
    const shell = boot({ read: { ticks: [], unreadable: "read-error" } });
    expect(shell.coreCalls).toBe(0);
    expect(w!.document.querySelector("#toastHost .toast-msg")?.textContent ?? "").toMatch(/stay saved/);
  });

  it("logs ticks the shell is still holding back, and applies the ones it read", () => {
    boot({ read: { ticks: [ticks[0]], heldBack: 2 } });
    expect(task("tsk-a")).toMatchObject({ status: "completed" });
    const held = w!.__huntDiagnostics.getBreadcrumbs().filter((b) => b.event === "ticks_held_back");
    expect(held.map((b) => b.context)).toEqual([{ count: 2 }]);
  });

  it("leaves the ticks queued while saving is blocked", () => {
    const shell = boot({ corrupt: true });
    expect(w!.eval("persistBlocked")).toBe(true);
    expect(shell.calls).toContain("readPendingTicks");
    expect(shell.acks).toEqual([]);
  });

  it("applies nothing while saving is blocked, so no change waits unsaved and nothing is skipped twice", () => {
    const shell = boot({ corrupt: true });
    expect(shell.coreCalls).toBe(0);
    expect(w!.__huntDiagnostics.getBreadcrumbs().filter((b) => b.event === "tick_skipped")).toEqual([]);
    w!.eval("drainPendingTicks()");
    expect(shell.coreCalls).toBe(0);
  });

  it("drains the queue once the user lets Hunt save again", () => {
    const shell = boot({ corrupt: true });
    w!.eval("allowSavingAfterLoadFailure()");
    expect(shell.coreCalls).toBe(1);
    expect(JSON.parse(shell.acks[0])).toEqual(ticks);
  });
});
