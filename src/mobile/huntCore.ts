/**
 * The shared domain core as the phone sees it. scripts/build-mobile-core.mjs
 * bundles this entry (an IIFE assigning `window.HuntCore`) into the generated
 * block of public/hunt-mobile.html and its Android asset copy, so the phone
 * runs the SAME rule implementations as the desktop and the sync server.
 *
 * Only pure modules may be exported here (no Dexie, React or browser APIs).
 * After changing anything reachable from this file run:
 *   node scripts/build-mobile-core.mjs
 * (mobileCore.test.ts fails while the generated block is stale.)
 */
export {
  computeHabitStreak,
  habitTaskId,
  isMissedHabitTask,
  isOpenTask,
  isTaskVisibleToday,
  toLocalDateKey,
} from "../lib/dateUtils";
export { completionDateKey, habitTodayTally, summarizeHabitDays } from "../lib/habitDay";
export { habitDayOutcome, habitStreakOf } from "../lib/habitOutcome";
export {
  applyChecklistEdit,
  canHoldChecklist,
  checklistOf,
  checklistProgress,
  newChecklistItemId,
} from "../lib/checklist";
export {
  HABIT_WEEKDAYS,
  habitFrequencyLabel,
  habitFrequencyOn,
  isHabitScheduledOn,
  parseHabitFrequency,
  sameHabitFrequency,
  withHabitFrequency,
} from "../lib/habitFrequency";
export {
  canonicalString,
  compareRank,
  isSafeSyncId,
  losingSessionEndAt,
  MAX_CHECKLIST_TEXT_LENGTH,
  mergeSyncPayloads,
  sameContent,
  SYNCED_ENTITY_KEYS,
  TOMBSTONE_KEY,
} from "../lib/syncTypes";
export { fromFocusSession, toFocusSession } from "../lib/domainTypes";
export { transitionFocus } from "../lib/focusSession";
export {
  buildBurstLog,
  buildHabitTaskRow,
  completeTaskRow,
  habitTodayTaskAfterEdit,
  missingHabitRows,
  nextStamp,
  pickNextFocusTask,
  sessionLogId,
  skipHabitDayRow,
} from "../lib/taskQueue";
export { buildWidgetSnapshot, WIDGET_SNAPSHOT_VERSION } from "../lib/widgetSnapshot";
export { applyPendingTicks } from "../lib/pendingTicks";
export { dueReminders, isReminderTime } from "../lib/reminders";
export { REMINDER_PLAN_AHEAD_MS, REMINDER_PLAN_MAX, reminderPlan } from "../lib/reminderPlan";
