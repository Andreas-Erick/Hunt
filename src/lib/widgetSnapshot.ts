import { dateKeyFromOffset, isOpenTask, isTaskVisibleToday } from "./dateUtils";
import type { Habit, HabitKind, QuestAccent, Task } from "./domainTypes";
import { countProgressLabel, habitDayAmount, habitKindOf } from "./habitKind";
import type { Look } from "./lookPreference";
import { isEndedHabit } from "./habitEnd";
import { compareRank } from "./syncTypes";
import type { SyncPayload } from "./syncTypes";
import { missingHabitRows } from "./taskQueue";
import { buildWidgetStats, widgetAccent } from "./widgetStats";
import type { WidgetStatsEntry } from "./widgetStats";

/**
 * Widget Snapshot: the ready-to-draw data the Android Widgets read (ADR-0006).
 * The phone page builds it after every save and hands it to the shell; the
 * native widget only draws it, so no Hunt rule is reimplemented in Java.
 *
 * Bump the version only for a change an older widget would misread. Adding a
 * field (more days, a `future` view per day, `stats`) keeps the version: the
 * widget ignores fields it does not know. Version 2: a Count Habit row's tap
 * means +1 (`habitKind`), which a version-1 widget would queue as done.
 */
export const WIDGET_SNAPSHOT_VERSION = 2;

/**
 * Days in a snapshot: today to today + 7. The ‹ › arrows reach today + 6; the
 * eighth day lets the widget roll over at midnight before Hunt is opened.
 */
export const WIDGET_SNAPSHOT_DAYS = 8;

export interface WidgetTaskRow {
  /** Task id; a Pending Tick names it. */
  id: string;
  title: string;
  /** Quest accent key; "slate" for Other work. Java maps it to the look's colour. */
  accent: QuestAccent | "slate";
  /**
   * The snapshot's decision whether the widget offers a tick (Java never decides it): false for
   * the Focus Task, since finishing it needs a TimeLog and a Focus transition.
   */
  tickable: boolean;
  /** The Task currently in Focus (drawn with ▶; a tap opens Hunt). */
  focus: boolean;
  /** A daily Habit instance. */
  habit: boolean;
  /**
   * A Habit row's Habit Kind (absent on other Tasks). A tick on a "count" row
   * is queued as a `+1` Pending Tick, any other as done.
   */
  habitKind?: HabitKind;
  /** A Count Habit row's progress, ready to draw: "2 / 3 miles". */
  progress?: string;
}

export interface WidgetDay {
  /** Local YYYY-MM-DD. */
  dateKey: string;
  /** What the Day Widget lists when `dateKey` is the current local date. */
  today: WidgetTaskRow[];
  /** What it lists when `dateKey` is a later day: Tasks scheduled on it, no Habits. */
  future: WidgetTaskRow[];
}

export interface WidgetSnapshot {
  version: typeof WIDGET_SNAPSHOT_VERSION;
  look: Look;
  /** The local date the snapshot was built on; days[0].dateKey. */
  todayKey: string;
  /** True before the user has any Quest, Task or Habit: "Open Hunt to get started". */
  noData: boolean;
  /** WIDGET_SNAPSHOT_DAYS entries, one per date, starting with today. */
  days: WidgetDay[];
  /** Stats Widget: today's entry, then tomorrow's for the midnight rollover. */
  stats: WidgetStatsEntry[];
}

/**
 * A later day's list as the Day Widget shows it before that day comes: open
 * Tasks scheduled on exactly that date, in rank order. Habits are left out,
 * since Hunt creates a Habit's row only on its own day.
 */
function futureTasks(state: SyncPayload, dateKey: string): Task[] {
  return (state.tasks ?? [])
    .filter((t) => !t.habitId && t.scheduledDate === dateKey && isOpenTask(t, dateKey))
    .sort(compareRank);
}

/**
 * Today's list as the app's Today view shows it: open Tasks visible today
 * (overdue and unscheduled roll in, Habits only on their own day) in rank
 * order, with today's Habits filled in by their fixed ids when Hunt has not
 * created the rows yet. A day Task of an Ended Habit is left out even when it
 * exists (made on another device before the end date synced). Pure: `state` is
 * not modified.
 */
function todayTasks(state: SyncPayload, todayKey: string): Task[] {
  const endedIds = new Set((state.habits ?? []).filter((h) => isEndedHabit(h, todayKey)).map((h) => h.id));
  return (state.tasks ?? [])
    .concat(missingHabitRows(state, todayKey))
    .filter((t) => isOpenTask(t, todayKey) && isTaskVisibleToday(t, todayKey))
    .filter((t) => !t.habitId || !endedIds.has(t.habitId))
    .sort(compareRank);
}

/**
 * Builds the Widget Snapshot for `state` on the local date `todayKey`, drawn
 * in `look`. Each of the WIDGET_SNAPSHOT_DAYS days carries both lists (the
 * widget picks `today` only when that day is the current date), the Focus Task
 * is listed but never tickable, and `noData` marks a Hunt with nothing in it
 * yet. Pure: `state` is not modified.
 */
export function buildWidgetSnapshot(
  state: SyncPayload,
  todayKey: string,
  look: Look
): WidgetSnapshot {
  const accentOf = new Map<string, QuestAccent | "slate">();
  for (const q of state.quests ?? []) accentOf.set(q.id, widgetAccent(q.accentColor));
  const habitOf = new Map<string, Habit>();
  for (const h of state.habits ?? []) habitOf.set(h.id, h);
  const focusId = state.activeFocus?.activeTaskId ?? null;
  const toRow = (t: Task): WidgetTaskRow => {
    const row: WidgetTaskRow = {
      id: t.id,
      title: t.title,
      accent: (t.questId && accentOf.get(t.questId)) || "slate",
      tickable: t.id !== focusId,
      focus: t.id === focusId,
      habit: Boolean(t.habitId),
    };
    if (!t.habitId) return row;
    const habit = habitOf.get(t.habitId);
    row.habitKind = habitKindOf(habit);
    if (habit && row.habitKind === "count") row.progress = countProgressLabel(habit, habitDayAmount(t));
    return row;
  };
  const noData =
    !(state.quests ?? []).length && !(state.tasks ?? []).length && !(state.habits ?? []).length;
  return {
    version: WIDGET_SNAPSHOT_VERSION,
    look,
    todayKey,
    noData,
    days: Array.from({ length: WIDGET_SNAPSHOT_DAYS }, (_, i) => {
      const dateKey = dateKeyFromOffset(todayKey, i);
      return {
        dateKey,
        today: todayTasks(state, dateKey).map(toRow),
        future: futureTasks(state, dateKey).map(toRow),
      };
    }),
    stats: buildWidgetStats(state, todayKey),
  };
}
