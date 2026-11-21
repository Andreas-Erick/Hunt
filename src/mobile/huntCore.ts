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
export { completionDateKey } from "../lib/habitDay";
export {
  canonicalString,
  compareRank,
  isSafeSyncId,
  losingSessionEndAt,
  mergeSyncPayloads,
  sameContent,
} from "../lib/syncTypes";
export { buildHabitTaskRow, nextStamp, sessionLogId } from "../lib/taskQueue";
