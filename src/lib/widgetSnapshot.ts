import { habitTaskId, isOpenTask, isTaskVisibleToday } from "./dateUtils";
import { QUEST_ACCENT_KEYS } from "./domainTypes";
import type { QuestAccent, Task } from "./domainTypes";
import type { Look } from "./lookPreference";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";
import { buildHabitTaskRow } from "./taskQueue";
import { buildWidgetStats } from "./widgetStats";
import type { WidgetStatsEntry } from "./widgetStats";

/**
 * Widget Snapshot: the ready-to-draw data the Android Widgets read (ADR-0006).
 * The phone page builds it after every save and hands it to the shell; the
 * native widget only draws it, so no Hunt rule is reimplemented in Java.
 *
 * Bump the version only for a change an older widget would misread. Adding a
 * field (more days, a `future` view per day, `stats`) keeps version 1: the
 * widget ignores fields it does not know.
 */
export const WIDGET_SNAPSHOT_VERSION = 1;

export interface WidgetTaskRow {
  /** Task id; a Pending Tick names it. */
  id: string;
  title: string;
  /** Quest accent key; "slate" for Other work. Java maps it to the look's colour. */
  accent: QuestAccent | "slate";
  /** False for the Focus Task: finishing it needs a TimeLog and a Focus transition. */
  tickable: boolean;
  /** The Task currently in Focus (drawn with ▶; a tap opens Hunt). */
  focus: boolean;
  /** A daily Habit instance. */
  habit: boolean;
}

export interface WidgetDay {
  /** Local YYYY-MM-DD. */
  dateKey: string;
  /** What the Day Widget lists when `dateKey` is the current local date. */
  today: WidgetTaskRow[];
}

export interface WidgetSnapshot {
  version: typeof WIDGET_SNAPSHOT_VERSION;
  look: Look;
  /** The local date the snapshot was built on; days[0].dateKey. */
  todayKey: string;
  /** True before the user has any Quest, Task or Habit: "Open Hunt to get started". */
  noData: boolean;
  /** One entry per date, starting with today. */
  days: WidgetDay[];
  /** Stats Widget: today's entry, then tomorrow's for the midnight rollover. */
  stats: WidgetStatsEntry[];
}

const ACCENTS: ReadonlySet<string> = new Set(QUEST_ACCENT_KEYS);

/**
 * Today's list as the app's Today view shows it: open Tasks visible today
 * (overdue and unscheduled roll in, Habits only on their own day) in rank
 * order, with today's Habits filled in by their fixed ids when Hunt has not
 * created the rows yet. Pure: `state` is not modified.
 */
function todayTasks(state: SyncPayload, todayKey: string): Task[] {
  const tasks = state.tasks ?? [];
  const known = new Set(tasks.map((t) => t.id));
  for (const id of state.deletedTaskIds ?? []) known.add(id);
  const synthesized = (state.habits ?? [])
    .filter((h) => !known.has(habitTaskId(h.id, todayKey)))
    .map((h) => buildHabitTaskRow(h, todayKey));
  return tasks
    .concat(synthesized)
    .filter((t) => isOpenTask(t, todayKey) && isTaskVisibleToday(t, todayKey))
    .sort(compareRank);
}

export function buildWidgetSnapshot(
  state: SyncPayload,
  todayKey: string,
  look: Look
): WidgetSnapshot {
  const accentOf = new Map<string, QuestAccent | "slate">();
  for (const q of state.quests ?? []) {
    accentOf.set(q.id, ACCENTS.has(q.accentColor) ? q.accentColor : "slate");
  }
  const focusId = state.activeFocus?.activeTaskId ?? null;
  const toRow = (t: Task): WidgetTaskRow => ({
    id: t.id,
    title: t.title,
    accent: (t.questId && accentOf.get(t.questId)) || "slate",
    tickable: t.id !== focusId,
    focus: t.id === focusId,
    habit: Boolean(t.habitId),
  });
  const noData =
    !(state.quests ?? []).length && !(state.tasks ?? []).length && !(state.habits ?? []).length;
  return {
    version: WIDGET_SNAPSHOT_VERSION,
    look,
    todayKey,
    noData,
    days: [{ dateKey: todayKey, today: todayTasks(state, todayKey).map(toRow) }],
    stats: buildWidgetStats(state, todayKey),
  };
}
