import Dexie, { type EntityTable } from "dexie";
import {
  QUEST_ACCENT_KEYS,
  SYNC_TOKEN_STORAGE_KEY,
  TOMBSTONE_STORAGE_KEY,
  type Habit,
  type Quest,
  type QuestAccent,
  type Task,
  type TaskStatus,
  type TimeLog,
} from "./domainTypes";
import {
  compareQuestSlot,
  dateFromKey,
  dateKeyFromOffset,
  formatChronoMMSS,
  formatTacticalDuration,
  habitTaskId,
  isMissedHabitTask,
  isOpenTask,
  isTaskVisibleToday,
  toLocalDateKey,
} from "./dateUtils";
import {
  QUEST_ACCENT_STYLES,
  accentStyle,
  type QuestAccentStyle,
} from "./questAccents";

export {
  QUEST_ACCENT_KEYS,
  SYNC_TOKEN_STORAGE_KEY,
  TOMBSTONE_STORAGE_KEY,
  compareQuestSlot,
  dateFromKey,
  dateKeyFromOffset,
  formatChronoMMSS,
  formatTacticalDuration,
  habitTaskId,
  isMissedHabitTask,
  isOpenTask,
  isTaskVisibleToday,
  toLocalDateKey,
  QUEST_ACCENT_STYLES,
  accentStyle,
  type Habit,
  type Quest,
  type QuestAccent,
  type QuestAccentStyle,
  type Task,
  type TaskStatus,
  type TimeLog,
};

class CommandCenterDB extends Dexie {
  quests!: EntityTable<Quest, "id">;
  tasks!: EntityTable<Task, "id">;
  timeLogs!: EntityTable<TimeLog, "id">;
  habits!: EntityTable<Habit, "id">;

  constructor() {
    super("JourneyCommandDB");

    this.version(1).stores({
      quests: "id, slotIndex, archived",
      tasks: "id, [status+rank], status, rank, questId, completedAt",
      timeLogs: "id, dateKey, questId, taskId, startTime, [dateKey+questId]",
    });

    this.version(2).stores({
      quests: "id, slotIndex, archived",
      tasks: "id, [status+rank], status, rank, questId, scheduledDate, completedAt",
      timeLogs: "id, dateKey, questId, taskId, startTime, [dateKey+questId]",
    });

    this.version(3).stores({
      quests: "id, slotIndex, archived",
      tasks: "id, [status+rank], status, rank, questId, scheduledDate, habitId, completedAt",
      timeLogs: "id, dateKey, questId, taskId, startTime, [dateKey+questId]",
      habits: "id, rank, questId",
    });

    // Yield stale connections on schema upgrades while keeping auto-open enabled
    // (Dexie 4's default close() sets disableAutoOpen: true, which permanently
    // locks out liveQueries in this tab if a versionchange fires during boot).
    this.on("versionchange", () => {
      this.close({ disableAutoOpen: false });
    });
  }
}

export const db = new CommandCenterDB();

/** Reads all quests from the primary store and sorts safely in memory. */
export async function loadSortedQuests(): Promise<Quest[]> {
  return (await db.quests.toArray()).sort(compareQuestSlot);
}

/** True when any local table holds a row. */
async function localDbHasRows(): Promise<boolean> {
  const counts = await Promise.all([
    db.quests.count(),
    db.tasks.count(),
    db.timeLogs.count(),
    db.habits.count(),
  ]);
  return counts.some((count) => count > 0);
}

/**
 * Seeds a starter template on first boot (3 Quests plus queued tasks for today
 * and the next two days) so the core action is one tap away. It holds no
 * history: no completed tasks, no tracked time and no time logs, so Review and
 * the heatmap start empty and honest, and nothing fake syncs to the phone.
 *
 * Runs only when this browser holds no rows and `syncDataExistsElsewhere`
 * (tombstones in this browser, or data on the local sync server: wired in by
 * bootSequence, the composition root) answers false.
 */
export async function seedInitialDataIfNeeded(
  syncDataExistsElsewhere: () => Promise<boolean>
): Promise<void> {
  if (typeof window === "undefined") return;
  if (await localDbHasRows()) return;
  if (await syncDataExistsElsewhere()) return;
  // Re-check: another tab (or a sync) may have filled the DB while we waited.
  if (await localDbHasRows()) return;

  const now = Date.now();
  const todayKey = toLocalDateKey(now);
  const tomorrowKey = dateKeyFromOffset(todayKey, 1);
  const inTwoDaysKey = dateKeyFromOffset(todayKey, 2);

  const defaultQuests: Quest[] = [
    {
      id: "quest-slot-0",
      slotIndex: 0,
      code: "CORE-ARCH",
      title: "Launch my idea",
      description:
        "Primary product architecture, core engineering milestones, and shipping the v1 release.",
      accentColor: "cyan",
      targetWeeklyHours: 12,
      archived: false,
      createdAt: now,
    },
    {
      id: "quest-slot-1",
      slotIndex: 1,
      code: "WRITING",
      title: "Write every week",
      description:
        "Publish deep technical essays, product updates, and share insights consistently.",
      accentColor: "amber",
      targetWeeklyHours: 5,
      archived: false,
      createdAt: now,
    },
    {
      id: "quest-slot-2",
      slotIndex: 2,
      code: "MARATHON",
      title: "Run a half marathon",
      description:
        "Zone-2 aerobic base building, long runs, and deliberate physical conditioning.",
      accentColor: "emerald",
      targetWeeklyHours: 4,
      archived: false,
      createdAt: now,
    },
  ];

  const defaultTasks: Task[] = [
    // Today's active/queued tasks
    {
      id: "tsk-01",
      title: "Design the next chapter",
      notes:
        "Outline core user flow, finalize focus timer interactions, and review weekly progress metrics.",
      questId: "quest-slot-0",
      status: "queued",
      rank: 1000,
      accumulatedSeconds: 0,
      scheduledDate: todayKey,
      createdAt: now,
    },
    {
      id: "tsk-02",
      title: "Make the first impression feel effortless",
      notes:
        "Refine onboarding interactions and eliminate any unnecessary setup friction.",
      questId: "quest-slot-0",
      status: "queued",
      rank: 2000,
      accumulatedSeconds: 0,
      scheduledDate: todayKey,
      createdAt: now,
    },
    {
      id: "tsk-03",
      title: "Draft this week's essay",
      notes:
        "Focus on the 6 principles of calm productivity: Done-list over rigid timeblocking, and Input over Output.",
      questId: "quest-slot-1",
      status: "queued",
      rank: 3000,
      accumulatedSeconds: 0,
      scheduledDate: todayKey,
      createdAt: now,
    },
    {
      id: "tsk-04",
      title: "Easy 5 km. Leave the headphones at home.",
      notes: "Nasal breathing pace, enjoy the route.",
      questId: "quest-slot-2",
      status: "queued",
      rank: 4000,
      accumulatedSeconds: 0,
      scheduledDate: todayKey,
      createdAt: now,
    },
    // Other / Maintenance work for today
    {
      id: "tsk-05",
      title: "Reconcile monthly cloud invoices & receipts",
      notes: "Export billing CSVs to accounting folder.",
      questId: null,
      status: "queued",
      rank: 5000,
      accumulatedSeconds: 0,
      scheduledDate: todayKey,
      createdAt: now,
    },
    // Tomorrow planned tasks (for "Plan the week")
    {
      id: "tsk-tom-01",
      title: "Polish the details that matter",
      notes: "Micro-interactions, keyboard shortcuts, and visual balance.",
      questId: "quest-slot-0",
      status: "queued",
      rank: 6000,
      accumulatedSeconds: 0,
      scheduledDate: tomorrowKey,
      createdAt: now,
    },
    {
      id: "tsk-tom-02",
      title: "Publish this week's essay",
      notes: "Final proofread and send to newsletter subscribers.",
      questId: "quest-slot-1",
      status: "queued",
      rank: 7000,
      accumulatedSeconds: 0,
      scheduledDate: tomorrowKey,
      createdAt: now,
    },
    // In 2 days planned tasks
    {
      id: "tsk-sat-01",
      title: "Long run · enjoy the route",
      notes: "12 km easy aerobic pace.",
      questId: "quest-slot-2",
      status: "queued",
      rank: 8000,
      accumulatedSeconds: 0,
      scheduledDate: inTwoDaysKey,
      createdAt: now,
    },
  ];

  await db.transaction("rw", db.quests, db.tasks, async () => {
    await db.quests.bulkPut(defaultQuests);
    await db.tasks.bulkPut(defaultTasks);
  });
}
