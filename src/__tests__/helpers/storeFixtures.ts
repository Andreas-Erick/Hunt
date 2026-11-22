// Shared fixtures for the desktop feature suites: deterministic random numbers, quest / log
// builders, and a per-test reset of IndexedDB, localStorage and the store (sync stubbed out).
import path from "path";
import { beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { Quest, QuestAccent, TimeLog } from "@/lib/domainTypes";
import { db } from "@/lib/db";
import { resetBootOnceForTests } from "@/lib/bootSequence";
import { useCommandStore } from "@/store/useCommandStore";

export const ROOT = path.resolve(__dirname, "..", "..", "..");

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

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeQuest(
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

export function makeTimeLog(params: {
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

export async function resetDbAndStore() {
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

/** Fresh IndexedDB, localStorage and store (with stubbed sync) around every test in the calling file. */
export function resetStoreAroundEachTest(): void {
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
}
