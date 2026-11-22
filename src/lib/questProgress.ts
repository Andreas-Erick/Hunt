import { dateKeyFromOffset } from "./dateUtils";
import type { Quest, TimeLog } from "./domainTypes";

/** Days in the rolling quest week: today and the 6 days before it. */
export const QUEST_WEEK_DAYS = 7;

/**
 * The rolling quest week ending on `todayKey`, newest first, stepped from a
 * noon anchor so DST days never skip or repeat a key.
 */
export function rollingWeekKeys(todayKey: string): string[] {
  return Array.from({ length: QUEST_WEEK_DAYS }, (_, i) =>
    dateKeyFromOffset(todayKey, -i)
  );
}

/** A focus burst that is running right now and not yet logged. */
export interface LiveBurst {
  questId: string | null;
  seconds: number;
}

export interface QuestWeekStats {
  todaySeconds: number;
  weekSeconds: number;
  targetHours: number;
  /** Week progress toward the target, 0–100 (0 when the target is not positive). */
  pct: number;
  /** The week's seconds reach a positive target (pct can round up to 100 first). */
  met: boolean;
}

export interface QuestWeekProgress {
  /** Stats for one quest id (zeros and its target for a quest without logs). */
  forQuest: (quest: Pick<Quest, "id" | "targetWeeklyHours">) => QuestWeekStats;
  /**
   * All quest work: seconds of every log linked to any quest (completed quests
   * included), against the summed targets of the ACTIVE quests.
   */
  total: QuestWeekStats;
}

function safeSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeTarget(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isTargetMet(seconds: number, targetHours: number): boolean {
  return targetHours > 0 && seconds >= targetHours * 3600;
}

function percentOf(seconds: number, targetHours: number): number {
  if (targetHours <= 0) return 0;
  return Math.min(100, Math.round((seconds / 3600 / targetHours) * 100));
}

/**
 * SHARED quest-week rule for Home and Quests: logged seconds per quest for
 * today and the rolling week, plus the running burst, against each quest's
 * weekly target. Logs outside the week are ignored (a live query can hold the
 * previous window for one render after midnight). Pure.
 */
export function computeQuestWeekProgress(params: {
  quests: readonly Pick<Quest, "id" | "archived" | "targetWeeklyHours">[];
  logs: readonly Pick<TimeLog, "questId" | "dateKey" | "durationSeconds">[];
  todayKey: string;
  live?: LiveBurst | null;
}): QuestWeekProgress {
  const { quests, logs, todayKey, live } = params;
  const week = new Set(rollingWeekKeys(todayKey));
  const today = new Map<string, number>();
  const weekly = new Map<string, number>();
  let totalToday = 0;
  let totalWeek = 0;

  const add = (questId: string, dateKey: string, seconds: number) => {
    weekly.set(questId, (weekly.get(questId) ?? 0) + seconds);
    totalWeek += seconds;
    if (dateKey === todayKey) {
      today.set(questId, (today.get(questId) ?? 0) + seconds);
      totalToday += seconds;
    }
  };

  for (const log of logs) {
    if (!log.questId || !week.has(log.dateKey)) continue;
    add(log.questId, log.dateKey, safeSeconds(log.durationSeconds));
  }
  if (live && live.questId) add(live.questId, todayKey, safeSeconds(live.seconds));

  const totalTarget = quests
    .filter((q) => !q.archived)
    .reduce((acc, q) => acc + safeTarget(q.targetWeeklyHours), 0);

  return {
    forQuest(quest) {
      const weekSeconds = weekly.get(quest.id) ?? 0;
      const targetHours = safeTarget(quest.targetWeeklyHours);
      return {
        todaySeconds: today.get(quest.id) ?? 0,
        weekSeconds,
        targetHours,
        pct: percentOf(weekSeconds, targetHours),
        met: isTargetMet(weekSeconds, targetHours),
      };
    },
    total: {
      todaySeconds: totalToday,
      weekSeconds: totalWeek,
      targetHours: totalTarget,
      pct: percentOf(totalWeek, totalTarget),
      met: isTargetMet(totalWeek, totalTarget),
    },
  };
}
