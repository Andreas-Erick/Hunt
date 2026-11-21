import {
  compareQuestSlot,
  dateFromKey,
  dateKeyFromOffset,
  toLocalDateKey,
} from "./dateUtils";
import type { Quest, Task, TimeLog } from "./domainTypes";

export type ReviewHorizon = "day" | "week" | "month" | "quarter" | "year";
export type ReviewScope = "ALL" | "OTHER" | string;
export type ReviewChartMetric = "hours" | "tasks";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HorizonWindow {
  horizon: ReviewHorizon;
  offset: number;
  startKey: string;
  endKey: string;
  totalDays: number;
  elapsedDays: number;
  rangeLabel: string;
  heading: string;
  subtitle: string;
  prevLabel: string;
  nextLabel: string;
  currentLabel: string;
  sessionUnitLabel: string;
}

export interface PeriodBucket {
  key: string;
  dateKey?: string;
  label: string;
  compactLabel: string;
  detailLabel: string;
  hours: number;
  seconds: number;
  otherHours: number;
  otherSeconds: number;
  completedTasks: number;
  sessions: number;
  isCurrent: boolean;
}

export interface QuestBreakdownItem {
  quest: Quest;
  hours: number;
  seconds: number;
  completedTasks: number;
  sessions: number;
  sharePct: number;
}

export interface PeriodReport {
  scope: ReviewScope;
  focusHours: number;
  focusSeconds: number;
  questHours: number;
  questSeconds: number;
  otherHours: number;
  otherSeconds: number;
  grandTotalHours: number;
  grandTotalSeconds: number;
  targetHours: number;
  targetPct: number;
  dailyAverageHours: number;
  dailyAverageSeconds: number;
  activeDaysCount: number;
  consistencyPct: number;
  focusSharePct: number;
  completedTasksCount: number;
  stepTasksCompleted: number;
  habitTasksCompleted: number;
  otherTasksCompleted: number;
  sessionsCount: number;
  avgSessionMinutes: number;
  longestSessionMinutes: number;
  peakBucket: PeriodBucket | null;
  buckets: PeriodBucket[];
  questBreakdown: QuestBreakdownItem[];
  filteredLogs: TimeLog[];
}

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

export interface TimelineBlockInput {
  id: string;
  startTime: number;
  durationSeconds: number;
}

export interface TimelineBlockPlacement {
  id: string;
  startHour: number;
  endHour: number;
  colIndex: number;
  totalCols: number;
}

export interface DayTimelineLayout {
  windowStartHour: number;
  windowEndHour: number;
  hours: number[];
  placements: Map<string, TimelineBlockPlacement>;
}

/**
 * Formats logged duration cleanly across both tiny (<6m) and huge (100h–10,000h+)
 * datasets without ever showing misleading "0.0h" for active micro-sessions or
 * overflowing narrow chart columns on multi-hundred-hour horizons.
 */
export function formatTelemetryDuration(
  seconds: number,
  options?: { zeroAs?: string; compactLarge?: boolean }
): string {
  const sec = safeSeconds(seconds);
  if (sec <= 0) return options?.zeroAs ?? "0.0h";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 360) return `${Math.max(1, Math.round(sec / 60))}m`;
  const hours = sec / 3600;
  if (options?.compactLarge) {
    if (hours >= 10_000) return `${Math.round(hours / 1000)}kh`;
    if (hours >= 1000) return `${(hours / 1000).toFixed(1)}kh`;
    if (hours >= 100) return `${Math.round(hours)}h`;
  }
  return `${hours.toFixed(1)}h`;
}

/**
 * Computes dynamic hour bounds (expanding beyond 08:00–22:00 for early/late
 * sessions) and non-overlapping column lanes (capped at 4 columns) so dense or
 * concurrent sessions on Today's Timeline remain distinct and readable.
 */
export function layoutTimelineBlocks(
  items: readonly TimelineBlockInput[],
  defaultStartHour = 8,
  defaultEndHour = 22
): DayTimelineLayout {
  let minStart = defaultStartHour;
  let maxEnd = defaultEndHour;

  const raw = items.map((item) => {
    const d = new Date(item.startTime);
    const rawStart = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const safeStart = Number.isFinite(rawStart) ? Math.max(0, Math.min(23.75, rawStart)) : defaultStartHour;
    const durHr = Math.max(0.42, safeSeconds(item.durationSeconds) / 3600);
    const safeEnd = Math.min(24, safeStart + durHr);
    if (safeStart < minStart) minStart = Math.max(0, Math.floor(safeStart));
    if (safeEnd > maxEnd) maxEnd = Math.min(24, Math.ceil(safeEnd));
    return { id: item.id, startHour: safeStart, endHour: safeEnd };
  });

  raw.sort((a, b) => a.startHour - b.startHour || b.endHour - a.endHour);

  const MAX_COLS = 4;
  const placements = new Map<string, TimelineBlockPlacement>();
  let cluster: Array<{ id: string; startHour: number; endHour: number; col: number }> = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const flushCluster = () => {
    if (cluster.length === 0) return;
    const usedCols = Math.min(
      MAX_COLS,
      Math.max(1, ...cluster.map((c) => c.col + 1))
    );
    for (const c of cluster) {
      placements.set(c.id, {
        id: c.id,
        startHour: c.startHour,
        endHour: c.endHour,
        colIndex: c.col % usedCols,
        totalCols: usedCols,
      });
    }
    cluster = [];
    clusterEnd = -1;
    laneEnds = [];
  };

  for (const item of raw) {
    if (cluster.length > 0 && item.startHour >= clusterEnd - 0.01) {
      flushCluster();
    }
    let assigned = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= item.startHour + 0.01) {
        assigned = i;
        laneEnds[i] = item.endHour;
        break;
      }
    }
    if (assigned === -1) {
      if (laneEnds.length < MAX_COLS) {
        assigned = laneEnds.length;
        laneEnds.push(item.endHour);
      } else {
        // Pick lane finishing earliest so >4 simultaneous bursts never vanish
        let earliestIdx = 0;
        for (let i = 1; i < laneEnds.length; i++) {
          if (laneEnds[i] < laneEnds[earliestIdx]) earliestIdx = i;
        }
        assigned = earliestIdx;
        laneEnds[earliestIdx] = Math.max(laneEnds[earliestIdx], item.endHour);
      }
    }
    cluster.push({ ...item, col: assigned });
    if (item.endHour > clusterEnd) clusterEnd = item.endHour;
  }
  flushCluster();

  const hours: number[] = [];
  for (let h = minStart; h <= maxEnd; h++) hours.push(h);

  return {
    windowStartHour: minStart,
    windowEndHour: maxEnd,
    hours,
    placements,
  };
}

function safeSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function calendarDaysInclusive(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const diff = Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000
  );
  return Math.max(1, diff + 1);
}

/** Resolves the local YYYY-MM-DD date key on which a completed task finished. */
export function getCompletedTaskDateKey(
  task: Pick<Task, "status" | "completedAt" | "scheduledDate" | "updatedAt">
): string | null {
  if (task.status !== "completed") return null;
  if (typeof task.completedAt === "number" && Number.isFinite(task.completedAt) && task.completedAt > 0) {
    return toLocalDateKey(task.completedAt);
  }
  if (typeof task.scheduledDate === "string" && DATE_KEY_RE.test(task.scheduledDate)) {
    return task.scheduledDate;
  }
  if (typeof task.updatedAt === "number" && Number.isFinite(task.updatedAt) && task.updatedAt > 0) {
    return toLocalDateKey(task.updatedAt);
  }
  return null;
}

function matchesScope(questId: string | null | undefined, scope: ReviewScope): boolean {
  const normalized = questId ?? null;
  if (scope === "ALL") return normalized !== null;
  if (scope === "OTHER") return normalized === null;
  return normalized === scope;
}

/** Builds a DST-safe calendar window for any Review horizon and non-positive step offset. */
export function buildHorizonWindow(
  horizon: ReviewHorizon,
  rawOffset: number,
  todayKey: string = toLocalDateKey()
): HorizonWindow {
  const offset = Math.min(0, Math.trunc(Number(rawOffset) || 0));
  const todayNoon = dateFromKey(todayKey);

  if (horizon === "day") {
    const dayDate = dateFromKey(todayKey, offset);
    const key = toLocalDateKey(dayDate.getTime());
    const rangeLabel = dayDate.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    return {
      horizon,
      offset,
      startKey: key,
      endKey: key,
      totalDays: 1,
      elapsedDays: 1,
      rangeLabel,
      heading: "Daily review",
      subtitle: "Deep-work blocks and tasks completed on this day.",
      prevLabel: "Previous day",
      nextLabel: "Next day",
      currentLabel: "Today",
      sessionUnitLabel: offset === 0 ? "today" : "this day",
    };
  }

  if (horizon === "week") {
    const startDate = dateFromKey(todayKey, offset * 7 - 6);
    const endDate = dateFromKey(todayKey, offset * 7);
    const startKey = toLocalDateKey(startDate.getTime());
    const endKey = toLocalDateKey(endDate.getTime());
    const startShort = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const endShort = endDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return {
      horizon,
      offset,
      startKey,
      endKey,
      totalDays: 7,
      elapsedDays: 7,
      rangeLabel: `${startShort} – ${endShort}`,
      heading: "Weekly review",
      subtitle: "How much of the week moved your quests forward.",
      prevLabel: "Previous week",
      nextLabel: "Next week",
      currentLabel: "This week",
      sessionUnitLabel: "this week",
    };
  }

  if (horizon === "month") {
    const first = new Date(todayNoon.getFullYear(), todayNoon.getMonth() + offset, 1, 12);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12);
    const startKey = toLocalDateKey(first.getTime());
    const endKey = toLocalDateKey(last.getTime());
    const totalDays = last.getDate();
    const elapsedDays = offset === 0 ? Math.max(1, todayNoon.getDate()) : totalDays;
    return {
      horizon,
      offset,
      startKey,
      endKey,
      totalDays,
      elapsedDays,
      rangeLabel: first.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      heading: "Monthly review",
      subtitle: "Weekly momentum, focus hours, and completed tasks across the month.",
      prevLabel: "Previous month",
      nextLabel: "Next month",
      currentLabel: "This month",
      sessionUnitLabel: "this month",
    };
  }

  if (horizon === "quarter") {
    const curQ = Math.floor(todayNoon.getMonth() / 3);
    const totalQ = todayNoon.getFullYear() * 4 + curQ + offset;
    const qYear = Math.floor(totalQ / 4);
    const qIdx = ((totalQ % 4) + 4) % 4;
    const first = new Date(qYear, qIdx * 3, 1, 12);
    const last = new Date(qYear, qIdx * 3 + 3, 0, 12);
    const startKey = toLocalDateKey(first.getTime());
    const endKey = toLocalDateKey(last.getTime());
    const totalDays = calendarDaysInclusive(startKey, endKey);
    const elapsedDays =
      offset === 0 ? Math.min(totalDays, calendarDaysInclusive(startKey, todayKey)) : totalDays;
    return {
      horizon,
      offset,
      startKey,
      endKey,
      totalDays,
      elapsedDays,
      rangeLabel: `Q${qIdx + 1} ${qYear}`,
      heading: "Quarterly review",
      subtitle: "90-day strategic trajectory across quests and habits.",
      prevLabel: "Previous quarter",
      nextLabel: "Next quarter",
      currentLabel: "This quarter",
      sessionUnitLabel: "this quarter",
    };
  }

  const year = todayNoon.getFullYear() + offset;
  const startKey = `${year}-01-01`;
  const endKey = `${year}-12-31`;
  const totalDays = calendarDaysInclusive(startKey, endKey);
  const elapsedDays =
    offset === 0 ? Math.min(totalDays, calendarDaysInclusive(startKey, todayKey)) : totalDays;
  return {
    horizon: "year",
    offset,
    startKey,
    endKey,
    totalDays,
    elapsedDays,
    rangeLabel: String(year),
    heading: "Yearly review",
    subtitle: "Month-by-month deep work and task output across the year.",
    prevLabel: "Previous year",
    nextLabel: "Next year",
    currentLabel: "This year",
    sessionUnitLabel: "this year",
  };
}

function computeHorizonTargetHours(
  window: HorizonWindow,
  quests: readonly Quest[],
  scope: ReviewScope
): number {
  let weeklyBase = 0;
  if (scope === "ALL") {
    for (const q of quests) {
      if (!q.archived) weeklyBase += Math.max(0, Number(q.targetWeeklyHours) || 0);
    }
  } else if (scope !== "OTHER") {
    const found = quests.find((q) => q.id === scope);
    weeklyBase = found ? Math.max(0, Number(found.targetWeeklyHours) || 0) : 0;
  }
  if (weeklyBase <= 0) return 0;
  if (window.horizon === "week") return weeklyBase;
  if (window.horizon === "day") return Number((weeklyBase / 7).toFixed(1));
  return Math.round((weeklyBase * window.totalDays) / 7);
}

interface RawBucketAcc {
  key: string;
  dateKey?: string;
  label: string;
  compactLabel: string;
  detailLabel: string;
  scopeSec: number;
  otherSec: number;
  completedTasks: number;
  sessions: number;
  isCurrent: boolean;
}

function initBuckets(window: HorizonWindow, todayKey: string): RawBucketAcc[] {
  if (window.horizon === "day") {
    const blocks = [
      ["00–04", "12a"],
      ["04–08", "4a"],
      ["08–12", "8a"],
      ["12–16", "12p"],
      ["16–20", "4p"],
      ["20–24", "8p"],
    ] as const;
    const nowHour = new Date().getHours();
    return blocks.map(([detail, short], idx) => ({
      key: `${window.startKey}-b${idx}`,
      label: short,
      compactLabel: short,
      detailLabel: detail,
      scopeSec: 0,
      otherSec: 0,
      completedTasks: 0,
      sessions: 0,
      isCurrent: window.startKey === todayKey && Math.floor(nowHour / 4) === idx,
    }));
  }

  if (window.horizon === "week") {
    const out: RawBucketAcc[] = [];
    for (let i = 0; i < 7; i++) {
      const dk = dateKeyFromOffset(window.startKey, i);
      const d = dateFromKey(dk);
      const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
      out.push({
        key: dk,
        dateKey: dk,
        label: weekday,
        compactLabel: weekday,
        detailLabel: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        scopeSec: 0,
        otherSec: 0,
        completedTasks: 0,
        sessions: 0,
        isCurrent: dk === todayKey,
      });
    }
    return out;
  }

  if (window.horizon === "month") {
    const ym = window.startKey.slice(0, 7);
    const out: RawBucketAcc[] = [];
    let startDay = 1;
    let wk = 1;
    while (startDay <= window.totalDays) {
      const endDay = Math.min(window.totalDays, startDay + 6);
      const sKey = `${ym}-${String(startDay).padStart(2, "0")}`;
      const eKey = `${ym}-${String(endDay).padStart(2, "0")}`;
      const label = `${startDay}–${endDay}`;
      out.push({
        key: `${ym}-w${wk}`,
        label,
        compactLabel: `W${wk}`,
        detailLabel: `Days ${label}`,
        scopeSec: 0,
        otherSec: 0,
        completedTasks: 0,
        sessions: 0,
        isCurrent: todayKey >= sKey && todayKey <= eKey,
      });
      startDay += 7;
      wk++;
    }
    return out;
  }

  if (window.horizon === "quarter") {
    const [sy, sm] = window.startKey.split("-").map(Number);
    const out: RawBucketAcc[] = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(sy, sm - 1 + i, 1, 12);
      const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const shortM = d.toLocaleDateString("en-US", { month: "short" });
      out.push({
        key: ym,
        label: shortM,
        compactLabel: shortM,
        detailLabel: d.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        scopeSec: 0,
        otherSec: 0,
        completedTasks: 0,
        sessions: 0,
        isCurrent: todayKey.startsWith(ym),
      });
    }
    return out;
  }

  const year = Number(window.startKey.slice(0, 4));
  const out: RawBucketAcc[] = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(year, m, 1, 12);
    const ym = `${year}-${String(m + 1).padStart(2, "0")}`;
    const shortM = d.toLocaleDateString("en-US", { month: "short" });
    out.push({
      key: ym,
      label: shortM,
      compactLabel: shortM.slice(0, 1),
      detailLabel: `${shortM} ${year}`,
      scopeSec: 0,
      otherSec: 0,
      completedTasks: 0,
      sessions: 0,
      isCurrent: todayKey.startsWith(ym),
    });
  }
  return out;
}

function bucketIndexForRecord(
  window: HorizonWindow,
  dateKey: string,
  timestampMs?: number
): number {
  if (window.horizon === "day") {
    if (typeof timestampMs === "number" && Number.isFinite(timestampMs) && timestampMs > 0) {
      const h = new Date(timestampMs).getHours();
      return Math.min(5, Math.max(0, Math.floor(h / 4)));
    }
    return 2; // 08–12 fallback for date-only records
  }
  if (window.horizon === "week") {
    return calendarDaysInclusive(window.startKey, dateKey) - 1;
  }
  if (window.horizon === "month") {
    const dayNum = Number(dateKey.slice(8, 10)) || 1;
    return Math.floor((dayNum - 1) / 7);
  }
  if (window.horizon === "quarter") {
    const startMonth = Number(window.startKey.slice(5, 7));
    const recMonth = Number(dateKey.slice(5, 7));
    return Math.min(2, Math.max(0, recMonth - startMonth));
  }
  return Math.min(11, Math.max(0, (Number(dateKey.slice(5, 7)) || 1) - 1));
}

/** Computes comprehensive deep-work & task telemetry for a horizon window and quest scope. */
export function computePeriodReport(params: {
  window: HorizonWindow;
  logs: readonly TimeLog[];
  tasks: readonly Task[];
  quests: readonly Quest[];
  scope: ReviewScope;
  todayKey?: string;
}): PeriodReport {
  const { window, logs, tasks, quests, scope, todayKey = toLocalDateKey() } = params;
  const rawBuckets = initBuckets(window, todayKey);
  const questSecById = new Map<string, number>();
  const questSessionsById = new Map<string, number>();
  const questTasksById = new Map<string, number>();
  const activeDaysSet = new Set<string>();
  const focusActiveDaysSet = new Set<string>();

  let questSec = 0;
  let otherSec = 0;
  let scopeSec = 0;
  let sessionsCount = 0;
  let longestSessionSec = 0;
  const filteredLogs: TimeLog[] = [];

  for (const log of logs) {
    if (!log || typeof log.dateKey !== "string") continue;
    if (log.dateKey < window.startKey || log.dateKey > window.endKey) continue;
    const dur = safeSeconds(log.durationSeconds);
    const qId = log.questId ?? null;

    if (qId !== null) {
      questSec += dur;
      questSecById.set(qId, (questSecById.get(qId) ?? 0) + dur);
      if (dur > 0) {
        questSessionsById.set(qId, (questSessionsById.get(qId) ?? 0) + 1);
      }
    } else {
      otherSec += dur;
    }

    const inScope = matchesScope(qId, scope);
    const idx = bucketIndexForRecord(window, log.dateKey, log.startTime);
    const bucket = rawBuckets[idx];

    if (inScope) {
      scopeSec += dur;
      if (dur > 0) {
        sessionsCount++;
        if (dur > longestSessionSec) longestSessionSec = dur;
        activeDaysSet.add(log.dateKey);
        focusActiveDaysSet.add(log.dateKey);
      }
      if (bucket && dur > 0) {
        bucket.scopeSec += dur;
        bucket.sessions += 1;
      }
    } else if (scope === "ALL" && qId === null && bucket) {
      bucket.otherSec += dur;
    }

    if (scope === "ALL" || inScope) {
      filteredLogs.push(log);
    }
  }

  filteredLogs.sort((a, b) => (Number(b.startTime) || 0) - (Number(a.startTime) || 0));

  let completedTasksCount = 0;
  let stepTasksCompleted = 0;
  let habitTasksCompleted = 0;
  let otherTasksCompleted = 0;

  for (const task of tasks) {
    if (!task || task.status !== "completed") continue;
    const dk = getCompletedTaskDateKey(task);
    if (!dk || dk < window.startKey || dk > window.endKey) continue;
    const qId = task.questId ?? null;

    if (qId !== null) {
      questTasksById.set(qId, (questTasksById.get(qId) ?? 0) + 1);
    } else {
      otherTasksCompleted++;
    }

    const inTaskScope = scope === "ALL" ? true : matchesScope(qId, scope);
    if (!inTaskScope) continue;

    completedTasksCount++;
    if (task.habitId) habitTasksCompleted++;
    else stepTasksCompleted++;

    if (matchesScope(qId, scope)) {
      activeDaysSet.add(dk);
    }

    const idx = bucketIndexForRecord(window, dk, task.completedAt);
    const bucket = rawBuckets[idx];
    if (bucket) bucket.completedTasks += 1;
  }

  const buckets: PeriodBucket[] = rawBuckets.map((b) => ({
    key: b.key,
    dateKey: b.dateKey,
    label: b.label,
    compactLabel: b.compactLabel,
    detailLabel: b.detailLabel,
    hours: Number((b.scopeSec / 3600).toFixed(1)),
    seconds: b.scopeSec,
    otherHours: Number((b.otherSec / 3600).toFixed(1)),
    otherSeconds: b.otherSec,
    completedTasks: b.completedTasks,
    sessions: b.sessions,
    isCurrent: b.isCurrent,
  }));

  const grandSec = questSec + otherSec;
  const focusHours = Number((scopeSec / 3600).toFixed(1));
  const questHours = Number((questSec / 3600).toFixed(1));
  const otherHours = Number((otherSec / 3600).toFixed(1));
  const grandTotalHours = Number((grandSec / 3600).toFixed(1));

  const targetHours = computeHorizonTargetHours(window, quests, scope);
  const targetPct = targetHours > 0 ? Math.round(((scopeSec / 3600) / targetHours) * 100) : 0;

  const activeDaysCount = activeDaysSet.size;
  const focusDenomDays = Math.max(
    1,
    focusActiveDaysSet.size > 0 ? focusActiveDaysSet.size : activeDaysCount
  );
  const dailyAverageSeconds = scopeSec / focusDenomDays;
  const dailyAverageHours = focusHours / focusDenomDays;
  const consistencyPct = Math.min(
    100,
    Math.round((activeDaysCount / Math.max(1, window.elapsedDays)) * 100)
  );

  const focusSharePct =
    grandSec > 0 ? Math.round((scopeSec / grandSec) * 100) : 0;

  const avgSessionMinutes =
    sessionsCount > 0 && scopeSec > 0
      ? Math.max(1, Math.round(scopeSec / sessionsCount / 60))
      : 0;
  const longestSessionMinutes =
    longestSessionSec > 0 ? Math.max(1, Math.round(longestSessionSec / 60)) : 0;

  let peakBucket: PeriodBucket | null = null;
  for (const b of buckets) {
    if (b.seconds <= 0 && b.completedTasks <= 0) continue;
    if (
      !peakBucket ||
      b.seconds > peakBucket.seconds ||
      (b.seconds === peakBucket.seconds && b.completedTasks > peakBucket.completedTasks)
    ) {
      peakBucket = b;
    }
  }

  const questBreakdown: QuestBreakdownItem[] = quests
    .map((q) => {
      const sec = questSecById.get(q.id) ?? 0;
      const qTasks = questTasksById.get(q.id) ?? 0;
      const qSessions = questSessionsById.get(q.id) ?? 0;
      return {
        quest: q,
        hours: Number((sec / 3600).toFixed(1)),
        seconds: sec,
        completedTasks: qTasks,
        sessions: qSessions,
        sharePct: grandSec > 0 ? Math.round((sec / grandSec) * 100) : 0,
      };
    })
    .filter((item) => !item.quest.archived || item.seconds > 0 || item.completedTasks > 0)
    .sort(
      (a, b) =>
        b.seconds - a.seconds ||
        b.completedTasks - a.completedTasks ||
        compareQuestSlot(a.quest, b.quest)
    );

  return {
    scope,
    focusHours,
    focusSeconds: scopeSec,
    questHours,
    questSeconds: questSec,
    otherHours,
    otherSeconds: otherSec,
    grandTotalHours,
    grandTotalSeconds: grandSec,
    targetHours,
    targetPct,
    dailyAverageHours,
    dailyAverageSeconds,
    activeDaysCount,
    consistencyPct,
    focusSharePct,
    completedTasksCount,
    stepTasksCompleted,
    habitTasksCompleted,
    otherTasksCompleted,
    sessionsCount,
    avgSessionMinutes,
    longestSessionMinutes,
    peakBucket,
    buckets,
    questBreakdown,
    filteredLogs,
  };
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
    const dk = getCompletedTaskDateKey(task);
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
