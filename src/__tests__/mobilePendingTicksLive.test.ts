// @vitest-environment node
// Pending Ticks while Hunt is open (#10, ADR-0006): when the Day Widget queues a tick and the page
// is alive, the shell calls window.__huntPendingTicksArrived(); the page applies the queue right away
// with the same drain-and-acknowledge path as boot. The fake shell below keeps the queue the way
// PendingTicks.java does: append adds, ack removes exactly the acknowledged entries, and the ack
// lands later (on the shell's write thread), not during the bridge call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 22, 10, 0, 0).getTime();
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
    { id: "tsk-b", title: "Call bank", status: "queued", rank: 2000, notes: "", questId: null, updatedAt: 500 },
  ],
};

interface Tick {
  taskId: string;
  dateKey: string;
  tickedAt: number;
}

const tick = (taskId: string, tickedAt = NOW - 60_000): Tick => ({ taskId, dateKey: DAY, tickedAt });
const key = (t: Tick) => `${t.taskId}|${t.dateKey}|${t.tickedAt}`;

class FakeShell {
  queue: Tick[] = [];
  calls: string[] = [];
  private landingAcks: string[] = [];
  onSave: (() => void) | null = null;

  append(t: Tick) {
    this.queue.push(t);
  }
  read() {
    this.calls.push("readPendingTicks");
    return JSON.stringify(this.queue);
  }
  ack(json: string) {
    this.calls.push("ackPendingTicks");
    this.landingAcks.push(json);
  }
  /** The write thread runs the queued acks: only the acknowledged entries leave the queue. */
  landAcks() {
    for (const json of this.landingAcks.splice(0)) {
      const acked = new Set((JSON.parse(json) as Tick[]).map(key));
      this.queue = this.queue.filter((t) => !acked.has(key(t)));
    }
  }
}

function boot(shell: FakeShell) {
  w = loadMobile({
    bridge: {
      loadState: () => JSON.stringify(seed),
      saveState: () => {
        shell.calls.push("saveState");
        shell.onSave?.();
      },
      readPendingTicks: () => shell.read(),
      ackPendingTicks: (json) => shell.ack(json),
    },
  });
  shell.calls.length = 0;
}

const task = (id: string) => readState(w!).tasks.find((t) => t.id === id);
const shownCompleted = (id: string) =>
  w!.document.querySelector(`#mainContainer .queue-item-card.completed[data-flip-task-id="${id}"]`) !== null;
const breadcrumbs = (event: string) => w!.__huntDiagnostics.getBreadcrumbs().filter((b) => b.event === event);

describe("phone page: Pending Ticks while Hunt is open", () => {
  it("the ticks-arrived signal drains: applies, saves, acknowledges and repaints", () => {
    const shell = new FakeShell();
    boot(shell);
    expect(shownCompleted("tsk-a")).toBe(false);

    shell.append(tick("tsk-a"));
    w!.__huntPendingTicksArrived();

    expect(task("tsk-a")).toMatchObject({ status: "completed", completedAt: NOW - 60_000 });
    expect(shell.calls).toEqual(["readPendingTicks", "saveState", "ackPendingTicks"]);
    expect(shownCompleted("tsk-a")).toBe(true);
    shell.landAcks();
    expect(shell.queue).toEqual([]);
  });

  it("a tick that arrives between reading and acknowledging stays queued and is applied on its own signal", () => {
    const shell = new FakeShell();
    boot(shell);
    shell.append(tick("tsk-a"));
    shell.onSave = () => {
      shell.onSave = null;
      shell.append(tick("tsk-b")); // the widget taps while the page is saving
    };
    w!.__huntPendingTicksArrived();
    shell.landAcks();
    expect(shell.queue).toEqual([tick("tsk-b")]);
    expect(task("tsk-b")?.status).toBe("queued");

    w!.__huntPendingTicksArrived();
    shell.landAcks();
    expect(task("tsk-b")?.status).toBe("completed");
    expect(shell.queue).toEqual([]);
  });

  it("a second signal before the first acknowledgement lands applies nothing twice", () => {
    const shell = new FakeShell();
    boot(shell);
    shell.append(tick("tsk-a"));
    w!.__huntPendingTicksArrived();
    shell.append(tick("tsk-b"));
    w!.__huntPendingTicksArrived(); // tsk-a is still in the file: its ack has not landed yet
    shell.landAcks();

    expect(task("tsk-b")?.status).toBe("completed");
    expect(shell.queue).toEqual([]);
    expect(breadcrumbs("tick_skipped")).toEqual([]);
    const acked = shell.calls.filter((c) => c === "ackPendingTicks");
    expect(acked).toHaveLength(2);
    expect(breadcrumbs("ticks_applied").map((b) => b.context)).toEqual([{ count: 1 }, { count: 1 }]);
  });

  it("coming back to the foreground drains ticks no signal reached", () => {
    const shell = new FakeShell();
    boot(shell);
    w!.__huntLifecycle("pause");
    shell.append(tick("tsk-a")); // e.g. queued while the page was reloading
    w!.__huntLifecycle("resume");
    expect(task("tsk-a")?.status).toBe("completed");
    expect(shownCompleted("tsk-a")).toBe(true);
  });
});
