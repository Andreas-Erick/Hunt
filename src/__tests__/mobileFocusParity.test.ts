// @vitest-environment node
// The phone's focus buttons run the SAME state machine and burst-log builder as the desktop
// (HuntCore.transitionFocus / buildBurstLog). Drive the real page with a seeded random sequence and
// replay the same events through the desktop modules: focus state and logs must match step by step.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromFocusSession, toFocusSession, type ActiveFocusState, type FocusSession } from "@/lib/domainTypes";
import { transitionFocus, type FocusEvent } from "@/lib/focusSession";
import { buildBurstLog } from "@/lib/taskQueue";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

type FocusPage = MobileWindow & {
  initializeFocus(taskId?: string): void;
  toggleTimerPause(): void;
  returnToQueueFromFocus(): void;
};

let w: FocusPage | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const QUEST = { id: "qst-a", title: "Alpha", accentColor: "cyan", slotIndex: 0, createdAt: 1, updatedAt: 1 };
const TASKS = ["tsk-1", "tsk-2", "tsk-3"].map((id, i) => ({
  id,
  title: `Task ${i + 1}`,
  questId: i === 2 ? null : QUEST.id,
  status: "queued",
  rank: (i + 1) * 1000,
  accumulatedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
}));

describe("phone focus parity with the desktop state machine", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: 40 random start / pause / resume / leave steps`, () => {
      w = loadMobile({
        seedState: { quests: [QUEST], tasks: TASKS, timeLogs: [] },
      }) as FocusPage;
      const rand = rng(seed);
      let session: FocusSession = toFocusSession(readState(w).activeFocus as ActiveFocusState);
      const expectedLogs: ReturnType<typeof buildBurstLog>[] = [];

      for (let step = 0; step < 40; step++) {
        vi.advanceTimersByTime(1000 + Math.floor(rand() * 600_000));
        const now = Date.now();
        const roll = rand();
        let event: FocusEvent;
        if (roll < 0.4) {
          const taskId = TASKS[Math.floor(rand() * TASKS.length)].id;
          event = { type: "start", taskId };
          w.initializeFocus(taskId);
        } else if (roll < 0.75) {
          event = { type: session.status === "running" ? "pause" : "resume" };
          if (session.status === "idle") continue; // the button is not shown without a focus task
          w.toggleTimerPause();
        } else {
          event = { type: "leave" };
          w.returnToQueueFromFocus();
        }

        const transition = transitionFocus(session, event, now);
        for (const effect of transition.effects) {
          if (effect.kind !== "flush") continue;
          const task = TASKS.find((t) => t.id === effect.taskId)!;
          const quest = task.questId ? QUEST : null;
          expectedLogs.unshift(buildBurstLog(task, quest as never, effect.sessionStartedAt, effect.endAt ?? now));
        }
        session = transition.session;

        const page = readState(w);
        expect(page.activeFocus, `step ${step} ${event.type}`).toEqual(fromFocusSession(session));
        expect(page.timeLogs, `step ${step} ${event.type}`).toEqual(expectedLogs);
      }
    });
  }
});
