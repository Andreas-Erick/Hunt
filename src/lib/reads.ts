import { db, loadSortedQuests } from "./db";
import type { Habit, Quest, Task, TimeLog } from "./domainTypes";
import { compareRank } from "./syncTypes";

/**
 * Named reads of this device's IndexedDB data: the one place that knows the
 * Dexie tables, their indexes and the query shapes. Views wrap these in
 * useLiveQuery; the store reads through them too.
 *
 * Index rules kept here, not in views:
 * - time logs are read ONLY through an indexed range on dateKey or questId,
 *   never toArray / orderBy over the whole (ever-growing) log table;
 * - habit tasks come from the habitId index (rows without a habitId are not in
 *   it, and habit ids are non-empty strings), so no full-table scan;
 * - quests are sorted in memory (compareQuestSlot) because an IDB index cursor
 *   would drop a synced row with a missing slotIndex.
 */
export const reads = {
  /** Every quest, active and completed, in slot order. */
  quests: (): Promise<Quest[]> => loadSortedQuests(),

  quest: (questId: string | null | undefined): Promise<Quest | undefined> =>
    questId ? db.quests.get(questId) : Promise.resolve(undefined),

  /** Every task (all statuses). */
  allTasks: (): Promise<Task[]> => db.tasks.toArray(),

  task: (taskId: string | null | undefined): Promise<Task | undefined> =>
    taskId ? db.tasks.get(taskId) : Promise.resolve(undefined),

  queuedTasks: (): Promise<Task[]> => db.tasks.where("status").equals("queued").toArray(),

  /** Queued and in-Focus Tasks: the ones a reminder can still be due for. */
  undoneTasks: (): Promise<Task[]> =>
    db.tasks.where("status").anyOf(["queued", "active"]).toArray(),

  completedTasks: (): Promise<Task[]> =>
    db.tasks.where("status").equals("completed").toArray(),

  /** Every materialized daily habit instance (any day, any status). */
  habitTasks: (): Promise<Task[]> => db.tasks.where("habitId").above("").toArray(),

  /** Every habit in rank order. */
  habits: async (): Promise<Habit[]> => (await db.habits.toArray()).sort(compareRank),

  /** Logs whose dateKey is one of `dateKeys`. */
  logsOnDays: (dateKeys: readonly string[]): Promise<TimeLog[]> =>
    db.timeLogs.where("dateKey").anyOf([...dateKeys]).toArray(),

  /** Logs with startKey <= dateKey <= endKey, newest first. */
  logsBetween: async (startKey: string, endKey: string): Promise<TimeLog[]> =>
    (await db.timeLogs.where("dateKey").between(startKey, endKey, true, true).toArray()).sort(
      (a, b) => b.startTime - a.startTime
    ),

  /** Logs linked to any of `questIds` (no read at all for none). */
  logsForQuests: (questIds: readonly string[]): Promise<TimeLog[]> =>
    questIds.length === 0
      ? Promise.resolve([])
      : db.timeLogs.where("questId").anyOf([...questIds]).toArray(),
};
