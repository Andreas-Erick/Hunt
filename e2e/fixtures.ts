import type { Habit, List, Quest, Task, TimeLog } from "../src/lib/domainTypes";

/**
 * Long-text fixtures for the geometry suite. One data set feeds both apps: the
 * desktop app's Dexie tables (written straight into IndexedDB) and the phone
 * app's saved state (localStorage). Date keys are UTC; playwright.config.ts runs
 * the browser in UTC so "today" matches.
 */

const DAY_MS = 86_400_000;

/** 35 characters, one word: nothing to break on but the characters themselves. */
export const LONG_QUEST_TITLE = "Datenschutzgrundverordnungumsetzung";

/** 180 characters of ordinary words. */
export const LONG_TASK_TITLE = (
  "Draft the quarterly architecture review covering the sync engine, the habit " +
  "materializer, the review analytics pipeline, the tablet plan board and every " +
  "remaining layout regression we know of today"
).slice(0, 180);

/** 90 characters with no break opportunity. */
export const URL_TASK_TITLE = (
  "https://docs.example.com/engineering/architecture/decisions/0042-" +
  "x".repeat(90)
).slice(0, 90);

const LONG_NOTE =
  "Notes: " +
  "https://example.com/" +
  "averyveryverylongpathsegmentwithoutanybreakopportunity".repeat(3) +
  " followed by a normal sentence that should wrap politely inside its card.";

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface GeometryFixtures {
  quests: Quest[];
  tasks: Task[];
  habits: Habit[];
  lists: List[];
  timeLogs: TimeLog[];
}

export function buildFixtures(now: number = Date.now()): GeometryFixtures {
  const today = dateKey(now);
  const tomorrow = dateKey(now + DAY_MS);

  const quests: Quest[] = [
    {
      id: "quest-slot-0",
      slotIndex: 0,
      code: "GEOM-LONG",
      title: LONG_QUEST_TITLE,
      description: `${LONG_TASK_TITLE} ${URL_TASK_TITLE}`,
      accentColor: "cyan",
      targetWeeklyHours: 10,
      archived: false,
      createdAt: now - 30 * DAY_MS,
    },
    {
      id: "quest-slot-1",
      slotIndex: 1,
      code: "SHORT",
      title: "Ship",
      description: "Short quest for contrast.",
      accentColor: "emerald",
      targetWeeklyHours: 4,
      archived: false,
      createdAt: now - 30 * DAY_MS,
    },
  ];

  const task = (t: Partial<Task> & Pick<Task, "id" | "title">): Task => ({
    notes: "",
    questId: "quest-slot-0",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: today,
    createdAt: now - DAY_MS,
    ...t,
  });

  const tasks: Task[] = [
    task({
      id: "task-long",
      title: LONG_TASK_TITLE,
      notes: LONG_NOTE,
      rank: 1000,
      accumulatedSeconds: 5400,
      checklist: [
        { id: "chk-geom-1", text: URL_TASK_TITLE, done: true },
        { id: "chk-geom-2", text: LONG_TASK_TITLE, done: false },
        { id: "chk-geom-3", text: LONG_QUEST_TITLE, done: false },
      ],
    }),
    task({ id: "task-url", title: URL_TASK_TITLE, notes: URL_TASK_TITLE, rank: 2000, accumulatedSeconds: 1800 }),
    task({ id: "task-other", title: URL_TASK_TITLE, questId: null, rank: 3000 }),
    task({ id: "task-tomorrow", title: LONG_TASK_TITLE, questId: "quest-slot-1", rank: 4000, scheduledDate: tomorrow }),
    task({
      id: "task-done",
      title: `${URL_TASK_TITLE} done`,
      notes: LONG_NOTE,
      status: "completed",
      rank: 5000,
      accumulatedSeconds: 3600,
      completedAt: now - 60 * 60 * 1000,
    }),
  ];

  const habits: Habit[] = [
    {
      id: "habit-long",
      title: URL_TASK_TITLE,
      notes: LONG_NOTE,
      questId: "quest-slot-0",
      rank: 1000,
      createdAt: now - 10 * DAY_MS,
    },
    // A Count Habit with a long unit: its "+1" ring and "n / target unit" progress must fit too.
    {
      id: "habit-count",
      title: LONG_TASK_TITLE,
      notes: "",
      questId: null,
      rank: 2000,
      createdAt: now - 3 * DAY_MS,
      kind: "count",
      target: 12.5,
      unit: "glasses of sparkling mineral water",
    },
    // An Avoid Habit: its mark, "Kept so far" and the "Log a Slip" button must fit beside a long title.
    {
      id: "habit-avoid",
      title: LONG_TASK_TITLE,
      notes: "",
      questId: null,
      rank: 3000,
      createdAt: now - 3 * DAY_MS,
      kind: "avoid",
    },
  ];

  // A standalone List with an unbreakable name and long items, one of them ticked.
  const lists: List[] = [
    {
      id: "list-long",
      title: LONG_QUEST_TITLE + LONG_QUEST_TITLE,
      items: [
        { id: "chk-l1", text: URL_TASK_TITLE, done: true },
        { id: "chk-l2", text: LONG_TASK_TITLE, done: false },
      ],
      rank: 1000,
      createdAt: now - 3 * DAY_MS,
      updatedAt: now - 3 * DAY_MS,
    },
  ];

  // A spread of sessions over the past weeks so Review, the heatmap and the session log render.
  const timeLogs: TimeLog[] = [0, 1, 2, 4, 7, 12, 20, 40].map((daysAgo, i) => {
    const startTime = now - daysAgo * DAY_MS - 3 * 60 * 60 * 1000;
    const durationSeconds = 1500 + i * 600;
    const taskId = i % 2 === 0 ? "task-long" : "task-url";
    return {
      id: `log-${startTime}-${taskId}`,
      taskId,
      taskTitleSnapshot: i % 2 === 0 ? LONG_TASK_TITLE : URL_TASK_TITLE,
      questId: i % 3 === 2 ? null : "quest-slot-0",
      questCodeSnapshot: i % 3 === 2 ? "OTHER" : "GEOM-LONG",
      accentColorSnapshot: i % 3 === 2 ? "slate" : "cyan",
      startTime,
      endTime: startTime + durationSeconds * 1000,
      durationSeconds,
      dateKey: dateKey(startTime),
    };
  });

  return { quests, tasks, habits, lists, timeLogs };
}

/** The phone app's saved-state shape (see getEmptyState in public/hunt-mobile.html). */
export function buildMobileState(fixtures: GeometryFixtures) {
  return {
    ...fixtures,
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    deletedHabitIds: [],
    deletedListIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
  };
}
