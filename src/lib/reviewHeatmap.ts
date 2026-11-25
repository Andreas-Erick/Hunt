/** Review's activity heatmap: a Monday-aligned contribution grid with streak and weekday stats. */
import { dateFromKey, dateKeyFromOffset, toLocalDateKey } from "./dateUtils";
import type { Task, TimeLog } from "./domainTypes";
import { completionDateKey } from "./habitDay";
import { matchesScope, safeSeconds, type ReviewScope } from "./reviewCommon";

export interface HeatmapCell {
  dateKey: string;
  shortLabel: string;
  weekdayShort: string;
  hours: number;
  seconds: number;
  completedTasks: number;
  sessions: number;
  level: 0 | 1 | 2 | 3 | 4;
  isToday: boolean;
  isFuture: boolean;
}

export interface HeatmapWeekColumn {
  weekKey: string;
  monthLabel: string | null;
  cells: HeatmapCell[];
}

export interface ActivityHeatmapReport {
  startKey: string;
  endKey: string;
  columns: HeatmapWeekColumn[];
  activeDays: number;
  elapsedDays: number;
  activePct: number;
  currentStreak: number;
  longestStreak: number;
  totalHours: number;
  totalSeconds: number;
  totalCompletedTasks: number;
  bestWeekday: { label: string; avgHours: number; totalTasks: number } | null;
  peakDay: { dateKey: string; label: string; hours: number; seconds: number; completedTasks: number } | null;
}

function heatmapLevel(
  sec: number,
  completedTasks: number
): 0 | 1 | 2 | 3 | 4 {
  if (sec <= 0 && completedTasks <= 0) return 0;
  const score = sec / 3600 + completedTasks * 0.35;
  if (score < 1.0) return 1;
  if (score < 2.5) return 2;
  if (score < 4.5) return 3;
  return 4;
}

/** Returns the Monday-aligned start dateKey for an N-week trailing heatmap ending on `todayKey`. */
export function getHeatmapStartKey(weeksCount: number, todayKey: string = toLocalDateKey()): string {
  const safeWeeks = Math.max(1, Math.trunc(weeksCount));
  const todayDate = dateFromKey(todayKey);
  const mondayDow = (todayDate.getDay() + 6) % 7; // 0 = Mon .. 6 = Sun
  return dateKeyFromOffset(todayKey, -mondayDow - (safeWeeks - 1) * 7);
}

/** Builds a Monday–Sunday contribution heatmap, streak stats, and weekday rhythm for any scope. */
export function computeActivityHeatmap(params: {
  logs: readonly TimeLog[];
  tasks: readonly Task[];
  scope: ReviewScope;
  weeksCount?: number;
  todayKey?: string;
}): ActivityHeatmapReport {
  const {
    logs,
    tasks,
    scope,
    weeksCount = 26,
    todayKey = toLocalDateKey(),
  } = params;

  const safeWeeks = Math.max(1, Math.trunc(weeksCount));
  const startKey = getHeatmapStartKey(safeWeeks, todayKey);
  const lastCellKey = dateKeyFromOffset(startKey, safeWeeks * 7 - 1);

  const dayMap = new Map<string, { sec: number; tasks: number; sessions: number }>();

  for (const log of logs) {
    if (!log || typeof log.dateKey !== "string") continue;
    if (log.dateKey < startKey || log.dateKey > todayKey) continue;
    const inLogScope =
      scope === "ALL" ? true : matchesScope(log.questId ?? null, scope);
    if (!inLogScope) continue;
    const dur = safeSeconds(log.durationSeconds);
    if (dur <= 0) continue;
    const cur = dayMap.get(log.dateKey) ?? { sec: 0, tasks: 0, sessions: 0 };
    cur.sec += dur;
    cur.sessions += 1;
    dayMap.set(log.dateKey, cur);
  }

  for (const task of tasks) {
    if (!task || task.status !== "completed") continue;
    const dk = completionDateKey(task);
    if (!dk || dk < startKey || dk > todayKey) continue;
    const inTaskScope =
      scope === "ALL" ? true : matchesScope(task.questId ?? null, scope);
    if (!inTaskScope) continue;
    const cur = dayMap.get(dk) ?? { sec: 0, tasks: 0, sessions: 0 };
    cur.tasks += 1;
    dayMap.set(dk, cur);
  }

  const columns: HeatmapWeekColumn[] = [];
  const weekdayTotals = Array.from({ length: 7 }, () => ({
    sec: 0,
    tasks: 0,
    days: 0,
  }));
  const weekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

  let prevMonth = -1;
  let activeDays = 0;
  let elapsedDays = 0;
  let runningStreak = 0;
  let longestStreak = 0;
  let totalSec = 0;
  let totalCompletedTasks = 0;
  let peakDay: ActivityHeatmapReport["peakDay"] = null;

  for (let w = 0; w < safeWeeks; w++) {
    const cells: HeatmapCell[] = [];
    let monthLabel: string | null = null;

    for (let dow = 0; dow < 7; dow++) {
      const dk = dateKeyFromOffset(startKey, w * 7 + dow);
      const d = dateFromKey(dk);
      const isFuture = dk > todayKey;

      if (dow === 0) {
        const m = d.getMonth();
        if (m !== prevMonth) {
          monthLabel = d.toLocaleDateString("en-US", { month: "short" });
          prevMonth = m;
        }
      }

      const rec = isFuture ? undefined : dayMap.get(dk);
      const sec = rec?.sec ?? 0;
      const comp = rec?.tasks ?? 0;
      const sessions = rec?.sessions ?? 0;
      const hours = Number((sec / 3600).toFixed(1));
      const level = isFuture ? 0 : heatmapLevel(sec, comp);

      const shortLabel = d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      if (!isFuture) {
        elapsedDays++;
        totalSec += sec;
        totalCompletedTasks += comp;
        weekdayTotals[dow].sec += sec;
        weekdayTotals[dow].tasks += comp;
        weekdayTotals[dow].days += 1;

        const isActive = sec > 0 || comp > 0;
        if (isActive) {
          activeDays++;
          runningStreak++;
          if (runningStreak > longestStreak) longestStreak = runningStreak;
          if (
            !peakDay ||
            sec > peakDay.seconds ||
            (sec === peakDay.seconds && comp > peakDay.completedTasks)
          ) {
            peakDay = { dateKey: dk, label: shortLabel, hours, seconds: sec, completedTasks: comp };
          }
        } else {
          runningStreak = 0;
        }
      }

      cells.push({
        dateKey: dk,
        shortLabel,
        weekdayShort: weekdayNames[dow],
        hours,
        seconds: sec,
        completedTasks: comp,
        sessions,
        level,
        isToday: dk === todayKey,
        isFuture,
      });
    }

    columns.push({
      weekKey: cells[0].dateKey,
      monthLabel,
      cells,
    });
  }

  // Current streak: counts today back if active today, else yesterday back so morning check-ins keep streak alive.
  let currentStreak = 0;
  const todayRec = dayMap.get(todayKey);
  const startOffset = todayRec && (todayRec.sec > 0 || todayRec.tasks > 0) ? 0 : -1;
  for (let off = startOffset; ; off--) {
    const dk = dateKeyFromOffset(todayKey, off);
    if (dk < startKey) break;
    const rec = dayMap.get(dk);
    if (rec && (rec.sec > 0 || rec.tasks > 0)) currentStreak++;
    else break;
  }

  let bestWeekday: ActivityHeatmapReport["bestWeekday"] = null;
  let bestScore = 0;
  for (let dow = 0; dow < 7; dow++) {
    const wt = weekdayTotals[dow];
    const score = wt.sec / 3600 + wt.tasks * 0.25;
    if (score > bestScore && wt.days > 0) {
      bestScore = score;
      bestWeekday = {
        label: weekdayNames[dow],
        avgHours: Number((wt.sec / 3600 / wt.days).toFixed(1)),
        totalTasks: wt.tasks,
      };
    }
  }

  return {
    startKey,
    endKey: lastCellKey > todayKey ? todayKey : lastCellKey,
    columns,
    activeDays,
    elapsedDays: Math.max(1, elapsedDays),
    activePct: Math.round((activeDays / Math.max(1, elapsedDays)) * 100),
    currentStreak,
    longestStreak,
    totalHours: Number((totalSec / 3600).toFixed(1)),
    totalSeconds: totalSec,
    totalCompletedTasks,
    bestWeekday,
    peakDay,
  };
}
