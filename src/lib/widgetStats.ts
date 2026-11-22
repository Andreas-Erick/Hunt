import { dateKeyFromOffset } from "./dateUtils";
import { QUEST_ACCENT_KEYS } from "./domainTypes";
import type { QuestAccent } from "./domainTypes";
import { summarizeHabitDays } from "./habitDay";
import { computeQuestWeekProgress } from "./questProgress";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";

/** One active Quest's rolling-week progress, as the Stats Widget draws it. */
export interface WidgetQuestStat {
  code: string;
  /** Quest accent key; "slate" for an unknown key. Java maps it to the look's colour. */
  accent: QuestAccent | "slate";
  /** Logged seconds over the rolling 7 days ending on the entry's date. */
  weekSeconds: number;
  /** Weekly target in hours (0 when none is set). */
  targetHours: number;
  /** Progress toward the target, 0–100, exactly as the app's Quest progress. */
  pct: number;
  /** The week's hours reach a positive target (drawn with ✓ in the success colour). */
  met: boolean;
}

export interface WidgetHabitStreak {
  title: string;
  /** Consecutive completed days, the app's streak rule. */
  days: number;
}

/** What the Stats Widget shows when `dateKey` is the current local date. */
export interface WidgetStatsEntry {
  dateKey: string;
  /** Today's logged Quest focus time (the app's "today" Quest hours). */
  focusSeconds: number;
  /** Active Quests in slot order; empty: "Set up a Quest in Hunt". */
  quests: WidgetQuestStat[];
  /** Every Habit's streak, in Habit order. */
  streaks: WidgetHabitStreak[];
}

const ACCENTS: ReadonlySet<string> = new Set(QUEST_ACCENT_KEYS);

function statsFor(state: SyncPayload, dateKey: string): WidgetStatsEntry {
  const quests = state.quests ?? [];
  const progress = computeQuestWeekProgress({ quests, logs: state.timeLogs ?? [], todayKey: dateKey });
  const { summaryFor } = summarizeHabitDays(state.tasks ?? [], dateKey);
  return {
    dateKey,
    focusSeconds: progress.total.todaySeconds,
    quests: quests
      .filter((q) => !q.archived)
      .sort((a, b) => a.slotIndex - b.slotIndex)
      .map((q) => {
        const p = progress.forQuest(q);
        return {
          code: q.code,
          accent: ACCENTS.has(q.accentColor) ? q.accentColor : "slate",
          weekSeconds: p.weekSeconds,
          targetHours: p.targetHours,
          pct: p.pct,
          met: p.targetHours > 0 && p.weekSeconds >= p.targetHours * 3600,
        };
      }),
    streaks: (state.habits ?? [])
      .slice()
      .sort(compareRank)
      .map((h) => ({ title: h.title, days: summaryFor(h.id).streak })),
  };
}

/**
 * Stats Widget entries for today and tomorrow (the second lets the widget roll
 * over at midnight without the app). Reuses the app's Quest progress and streak
 * rules; holds none of its own. Pure: `state` is not modified.
 */
export function buildWidgetStats(state: SyncPayload, todayKey: string): WidgetStatsEntry[] {
  return [statsFor(state, todayKey), statsFor(state, dateKeyFromOffset(todayKey, 1))];
}
