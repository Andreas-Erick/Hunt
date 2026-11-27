import { db } from "./db";
import { buildDemoSeed } from "./demoSeed";
import { NOTES_DRAFT_KEY_PREFIX } from "./noteDraftStore";

/*
 * Writes the browser demo's sample data (ADR-0010). Only the demo build calls this module;
 * the native app's first-run seed lives in db.ts.
 */

/** Device preferences a Reset keeps: the visitor's look and sound choice are not demo data. */
const KEPT_STORAGE_KEYS = new Set(["hunt-look", "hunt-audio-muted-v1"]);

/** True for a localStorage key Hunt owns (store, tombstones, drafts, snoozes, …). */
function isHuntStorageKey(key: string): boolean {
  return key.startsWith("hunt-") || key.startsWith("journey-hud-") || key.startsWith(NOTES_DRAFT_KEY_PREFIX);
}

async function writeSeed(now: number): Promise<void> {
  const seed = buildDemoSeed(now);
  await db.transaction("rw", [db.quests, db.tasks, db.timeLogs, db.habits, db.lists], async () => {
    await Promise.all([
      db.quests.clear(),
      db.tasks.clear(),
      db.timeLogs.clear(),
      db.habits.clear(),
      db.lists.clear(),
    ]);
    await db.quests.bulkPut(seed.quests);
    await db.tasks.bulkPut(seed.tasks);
    await db.timeLogs.bulkPut(seed.timeLogs);
    await db.habits.bulkPut(seed.habits);
    await db.lists.bulkPut(seed.lists);
  });
}

/** First visit (or cleared site data): fills the demo database. A visitor's edits are kept. */
export async function seedDemoIfEmpty(now: number = Date.now()): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const counts = await Promise.all([db.quests.count(), db.tasks.count(), db.habits.count(), db.lists.count()]);
  if (counts.some((n) => n > 0)) return false;
  await writeSeed(now);
  return true;
}

/**
 * Reset demo: drops everything the visitor changed (rows, a running focus session, note
 * drafts, snoozes) and writes the sample data again. The caller reloads the page, so the
 * store starts from the fresh rows instead of patching its in-memory state.
 */
export async function resetDemoData(now: number = Date.now()): Promise<void> {
  try {
    const storage = window.localStorage;
    const owned: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && isHuntStorageKey(key) && !KEPT_STORAGE_KEYS.has(key)) owned.push(key);
    }
    for (const key of owned) storage.removeItem(key);
  } catch {
    // Storage blocked (private mode, a sandboxed iframe): there is nothing stored to clear.
  }
  await writeSeed(now);
}
