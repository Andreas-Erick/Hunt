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
  isTaskVisibleToday,
  toLocalDateKey,
} from "./dateUtils";
import {
  QUEST_ACCENT_STYLES,
  accentStyle,
  type QuestAccentStyle,
} from "./questAccents";
import { syncPayloadHasContent, type SyncPayload } from "./syncTypes";

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

export const SEED_SERVER_CHECK_TIMEOUT_MS = 1500;

/**
 * Asks the local sync server whether it already holds real data before demo
 * rows are seeded into an empty local DB (fresh browser profile, cleared site
 * data, another origin such as 127.0.0.1 or the LAN URL). Seeding then would
 * push fake tasks and time logs into the synced dataset and on to the phone.
 *
 * Returns false (seed) ONLY after a successful 2xx whose parsed sync payload
 * holds no rows and no tombstones. Everything else returns true (do NOT seed):
 * rows or tombstones on the server, an HTTP error (it exists but its data could
 * not be read), and also a timeout/abort, a network error or a body that is not
 * a sync payload. The desktop page is served by this same server, so a failed
 * check means "slow" (cold compile, resume, antivirus), not "no server", and
 * seeding then would pollute the real dataset.
 */
async function serverAlreadyHoldsData(): Promise<boolean> {
  if (typeof fetch !== "function") return true;
  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), SEED_SERVER_CHECK_TIMEOUT_MS)
    : null;
  try {
    const headers: Record<string, string> = { "X-Hunt-Client": "desktop" };
    try {
      const token = window.localStorage?.getItem(SYNC_TOKEN_STORAGE_KEY);
      if (token && token.length >= 32) headers["X-Hunt-Token"] = token;
    } catch {
      // ignore storage errors
    }
    const res = await fetch("/api/sync", {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!res.ok) return true;
    const data = (await res.json()) as { payload?: unknown } | null;
    const payload = data && typeof data === "object" ? data.payload : null;
    const isSyncPayload =
      !!payload &&
      typeof payload === "object" &&
      Array.isArray((payload as Partial<SyncPayload>).quests) &&
      Array.isArray((payload as Partial<SyncPayload>).tasks) &&
      Array.isArray((payload as Partial<SyncPayload>).timeLogs);
    if (!isSyncPayload) return true;
    return syncPayloadHasContent(payload as Partial<SyncPayload>);
  } catch {
    // Abort (timeout), network error or unparsable body: unknown → do not seed.
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Seeds initial 3 Quests, daily & weekly tasks, and 7-day sample telemetry
 * on first boot so the interface is immediately operational — but only when
 * neither this browser nor the local sync server holds any data yet.
 */
export async function seedInitialDataIfNeeded(): Promise<void> {
  if (typeof window === "undefined") return;

  const [questCount, taskCount, logCount, habitCount] = await Promise.all([
    db.quests.count(),
    db.tasks.count(),
    db.timeLogs.count(),
    db.habits.count(),
  ]);
  const hasTombstones = Boolean(
    window.localStorage?.getItem(TOMBSTONE_STORAGE_KEY)
  );
  if (questCount > 0 || taskCount > 0 || logCount > 0 || habitCount > 0 || hasTombstones) return;

  if (await serverAlreadyHoldsData()) return;

  // Re-check: another tab (or a sync) may have filled the DB while we waited.
  const [questCount2, taskCount2, logCount2, habitCount2] = await Promise.all([
    db.quests.count(),
    db.tasks.count(),
    db.timeLogs.count(),
    db.habits.count(),
  ]);
  if (questCount2 > 0 || taskCount2 > 0 || logCount2 > 0 || habitCount2 > 0) return;

  const now = Date.now();
  const DAY_MS = 86_400_000;
  const todayKey = toLocalDateKey(now);
  const yesterdayKey = toLocalDateKey(now - DAY_MS);
  const twoDaysAgoKey = toLocalDateKey(now - 2 * DAY_MS);
  const tomorrowKey = toLocalDateKey(now + DAY_MS);
  const inTwoDaysKey = toLocalDateKey(now + 2 * DAY_MS);

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
      createdAt: now - 7 * DAY_MS,
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
      createdAt: now - 7 * DAY_MS,
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
      createdAt: now - 7 * DAY_MS,
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
      accumulatedSeconds: 2160, // 36:00
      scheduledDate: todayKey,
      createdAt: now - 3600_000 * 5,
    },
    {
      id: "tsk-02",
      title: "Make the first impression feel effortless",
      notes:
        "Refine onboarding interactions and eliminate any unnecessary setup friction.",
      questId: "quest-slot-0",
      status: "queued",
      rank: 2000,
      accumulatedSeconds: 3600, // 1:00:00
      scheduledDate: todayKey,
      createdAt: now - 3600_000 * 4,
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
      createdAt: now - 3600_000 * 3,
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
      createdAt: now - 3600_000 * 2,
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
      createdAt: now - 3600_000 * 2,
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
      createdAt: now - 3600_000,
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
      createdAt: now - 3600_000,
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
      createdAt: now - 3600_000,
    },
    // Completed tasks today
    {
      id: "tsk-hist-01",
      title: "Read a chapter, take a few notes",
      notes: "Deep work synthesis.",
      questId: "quest-slot-2",
      status: "completed",
      rank: 100,
      accumulatedSeconds: 1800, // 30:00
      scheduledDate: todayKey,
      createdAt: now - 3600_000 * 8,
      completedAt: now - 3600_000 * 4,
    },
    {
      id: "tsk-hist-02",
      title: "Map the ideas worth pursuing",
      notes: "Completed architecture map.",
      questId: "quest-slot-0",
      status: "completed",
      rank: 200,
      accumulatedSeconds: 5400, // 1:30:00
      scheduledDate: todayKey,
      createdAt: now - 3600_000 * 10,
      completedAt: now - 3600_000 * 6,
    },
    // Completed tasks yesterday & 2 days ago (for "Plan the week" columns)
    {
      id: "tsk-prev-01",
      title: "Build the first prototype",
      notes: "",
      questId: "quest-slot-0",
      status: "completed",
      rank: 300,
      accumulatedSeconds: 7200,
      scheduledDate: yesterdayKey,
      createdAt: now - DAY_MS,
      completedAt: now - DAY_MS + 3600_000,
    },
    {
      id: "tsk-prev-02",
      title: "Hill repeats — stay consistent",
      notes: "",
      questId: "quest-slot-2",
      status: "completed",
      rank: 400,
      accumulatedSeconds: 3600,
      scheduledDate: yesterdayKey,
      createdAt: now - DAY_MS,
      completedAt: now - DAY_MS + 7200_000,
    },
    {
      id: "tsk-prev-03",
      title: "Explore three directions",
      notes: "",
      questId: "quest-slot-0",
      status: "completed",
      rank: 500,
      accumulatedSeconds: 5400,
      scheduledDate: twoDaysAgoKey,
      createdAt: now - 2 * DAY_MS,
      completedAt: now - 2 * DAY_MS + 3600_000,
    },
  ];

  // Historical logs across the last 7 days for rich Done-List Timeline & Weekly Review
  const todayNineAm = new Date(now);
  todayNineAm.setHours(9, 0, 0, 0);
  const baseNineMs = todayNineAm.getTime();

  const defaultLogs: TimeLog[] = [
    // Today's Done-List Timeline blocks (09:00-10:30, 11:00-12:00, 12:30-13:00)
    {
      id: "log-seed-today-1",
      taskId: "tsk-hist-02",
      taskTitleSnapshot: "Map the ideas worth pursuing",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: baseNineMs,
      endTime: baseNineMs + 5400 * 1000,
      durationSeconds: 5400,
      dateKey: todayKey,
    },
    {
      id: "log-seed-today-2",
      taskId: "tsk-02",
      taskTitleSnapshot: "Make the first impression feel effortless",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: baseNineMs + 2 * 3600_000,
      endTime: baseNineMs + 3 * 3600_000,
      durationSeconds: 3600,
      dateKey: todayKey,
    },
    {
      id: "log-seed-today-3",
      taskId: "tsk-hist-01",
      taskTitleSnapshot: "Read a chapter, take a few notes",
      questId: "quest-slot-2",
      questCodeSnapshot: "Run a half marathon",
      accentColorSnapshot: "emerald",
      startTime: baseNineMs + 3.5 * 3600_000,
      endTime: baseNineMs + 4.0 * 3600_000,
      durationSeconds: 1800,
      dateKey: todayKey,
    },
    {
      id: "log-seed-today-4",
      taskId: "tsk-01",
      taskTitleSnapshot: "Design the next chapter",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: baseNineMs + 5 * 3600_000,
      endTime: baseNineMs + 5 * 3600_000 + 2160 * 1000,
      durationSeconds: 2160,
      dateKey: todayKey,
    },
    // Previous days of the week
    {
      id: "log-seed-d1-1",
      taskId: "tsk-prev-01",
      taskTitleSnapshot: "Build the first prototype",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: now - DAY_MS - 5 * 3600_000,
      endTime: now - DAY_MS - 2 * 3600_000,
      durationSeconds: 10800, // 3.0h
      dateKey: yesterdayKey,
    },
    {
      id: "log-seed-d1-2",
      taskId: "tsk-prev-02",
      taskTitleSnapshot: "Hill repeats — stay consistent",
      questId: "quest-slot-2",
      questCodeSnapshot: "Run a half marathon",
      accentColorSnapshot: "emerald",
      startTime: now - DAY_MS - 2 * 3600_000,
      endTime: now - DAY_MS - 300_000,
      durationSeconds: 6120, // 1.7h
      dateKey: yesterdayKey,
    },
    {
      id: "log-seed-d1-3",
      taskId: "tsk-maint-1",
      taskTitleSnapshot: "Inbox & administrative follow-ups",
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime: now - DAY_MS - 3600_000,
      endTime: now - DAY_MS,
      durationSeconds: 3600, // 1.0h
      dateKey: yesterdayKey,
    },
    {
      id: "log-seed-d2-1",
      taskId: "tsk-prev-03",
      taskTitleSnapshot: "Explore three directions",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: now - 2 * DAY_MS - 6 * 3600_000,
      endTime: now - 2 * DAY_MS - 2.5 * 3600_000,
      durationSeconds: 12600, // 3.5h
      dateKey: twoDaysAgoKey,
    },
    {
      id: "log-seed-d2-2",
      taskId: "tsk-write-1",
      taskTitleSnapshot: "Outline weekly essay structure",
      questId: "quest-slot-1",
      questCodeSnapshot: "Write every week",
      accentColorSnapshot: "amber",
      startTime: now - 2 * DAY_MS - 2 * 3600_000,
      endTime: now - 2 * DAY_MS - 100_000,
      durationSeconds: 6120, // 1.7h
      dateKey: twoDaysAgoKey,
    },
    {
      id: "log-seed-d3-1",
      taskId: "tsk-d3-1",
      taskTitleSnapshot: "Core architecture research & synthesis",
      questId: "quest-slot-0",
      questCodeSnapshot: "Launch my idea",
      accentColorSnapshot: "cyan",
      startTime: now - 3 * DAY_MS - 5 * 3600_000,
      endTime: now - 3 * DAY_MS - 1.5 * 3600_000,
      durationSeconds: 10800, // 3.0h
      dateKey: toLocalDateKey(now - 3 * DAY_MS),
    },
    {
      id: "log-seed-d3-2",
      taskId: "tsk-d3-2",
      taskTitleSnapshot: "Write draft notes & examples",
      questId: "quest-slot-1",
      questCodeSnapshot: "Write every week",
      accentColorSnapshot: "amber",
      startTime: now - 3 * DAY_MS - 2 * 3600_000,
      endTime: now - 3 * DAY_MS - 500_000,
      durationSeconds: 5400, // 1.5h
      dateKey: toLocalDateKey(now - 3 * DAY_MS),
    },
    {
      id: "log-seed-d3-3",
      taskId: "tsk-maint-2",
      taskTitleSnapshot: "Quarterly vendor & tax admin",
      questId: null,
      questCodeSnapshot: "Other",
      accentColorSnapshot: "slate",
      startTime: now - 3 * DAY_MS - 5400_000,
      endTime: now - 3 * DAY_MS,
      durationSeconds: 5400, // 1.5h
      dateKey: toLocalDateKey(now - 3 * DAY_MS),
    },
  ];

  await db.transaction("rw", db.quests, db.tasks, db.timeLogs, async () => {
    await db.quests.bulkPut(defaultQuests);
    await db.tasks.bulkPut(defaultTasks);
    await db.timeLogs.bulkPut(defaultLogs);
  });
}
