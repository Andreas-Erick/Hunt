import { dateKeyFromOffset } from "./dateUtils";
import { QUEST_ACCENT_KEYS } from "./domainTypes";
import type { QuestAccent } from "./domainTypes";
import { summarizeHabitDays } from "./habitDay";
import { computeQuestWeekProgress } from "./questProgress";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";

/** One active Quest's rolling-week progress, as the Stats Widget draws it. */
export interface WidgetQuestStat {
  /** The Quest's short code (kept for older widget builds, which draw it). */
  code: string;
  /** The Quest's full title, as the app names it; the widget ellipsizes it to one line. */
  title: string;
  /** Quest accent key; "slate" for an unknown key. Java maps it to the look's colour. */
  accent: QuestAccent | "slate";
  /** Logged seconds over the rolling 7 days ending on the entry's date. */
  weekSeconds: number;
  /** Weekly target in hours (0 when none is set). */
  targetHours: number;
  /** Progress toward the target, 0–100, exactly as the app's Quest progress. */
  pct: number;
  /** The app's Quest progress calls the target met (drawn with ✓ in the success colour). */
  met: boolean;
}

export interface WidgetHabitStreak {
  title: string;
  /** The Habit's Streak (the app's rule): Met days, or Met Habit Weeks when `unit` is "week". */
  days: number;
  /** "week" for an N per week Habit, drawn as "3w"; absent for a Streak in days ("3d"). */
  unit?: "week";
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

/**
 * A Quest's accent as both Widgets draw it: its own key, or "slate" for a key
 * the widget has no colour for. Java maps the key to the look's colour.
 */
export function widgetAccent(accentColor: string | undefined): QuestAccent | "slate" {
  return accentColor && ACCENTS.has(accentColor) ? (accentColor as QuestAccent) : "slate";
}

function statsFor(state: SyncPayload, dateKey: string): WidgetStatsEntry {
  const quests = state.quests ?? [];
  const progress = computeQuestWeekProgress({ quests, logs: state.timeLogs ?? [], todayKey: dateKey });
  const { summaryFor } = summarizeHabitDays(state.tasks ?? [], dateKey, state.habits ?? []);
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
          title: q.title,
          accent: widgetAccent(q.accentColor),
          weekSeconds: p.weekSeconds,
          targetHours: p.targetHours,
          pct: p.pct,
          met: p.met,
        };
      }),
    streaks: (state.habits ?? [])
      .slice()
      .sort(compareRank)
      .map((h): WidgetHabitStreak => {
        const { streak, streakUnit } = summaryFor(h.id);
        return streakUnit === "week" ? { title: h.title, days: streak, unit: "week" } : { title: h.title, days: streak };
      }),
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
