import type { ActiveFocusState, Habit, List, Quest, Task, TimeLog } from "./domainTypes";

/** The synced state one device sends and the server merges (see syncTypes.ts for the merge). */
export interface SyncPayload {
  quests: Quest[];
  tasks: Task[];
  timeLogs: TimeLog[];
  habits?: Habit[];
  /** Standalone Lists (absent from older devices: read as none). */
  lists?: List[];
  deletedQuestIds?: string[];
  deletedTaskIds: string[];
  deletedLogIds: string[];
  deletedHabitIds?: string[];
  deletedListIds?: string[];
  activeFocus: ActiveFocusState;
  lastSyncedAt: number;
}

/** Max ids kept per tombstone list (newest win). */
export const MAX_TOMBSTONES_PER_KIND = 5000;
