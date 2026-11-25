import {
  compareQuestSlot,
  dateFromKey,
  dateKeyFromOffset,
  toLocalDateKey,
} from "./dateUtils";
import type { Quest, Task, TimeLog } from "./domainTypes";
import { completionDateKey } from "./habitDay";
import { matchesScope, safeSeconds, type ReviewScope } from "./reviewCommon";

// The heatmap and the day timeline live in their own modules; re-exported so callers keep one import.
export type { ReviewScope } from "./reviewCommon";
export * from "./reviewHeatmap";
export * from "./dayTimelineLayout";

export type ReviewHorizon = "day" | "week" | "month" | "quarter" | "year";
export type ReviewChartMetric = "hours" | "tasks";

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

function calendarDaysInclusive(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const diff = Math.round(
    (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000
  );
  return Math.max(1, diff + 1);
}

/**
 * The local YYYY-MM-DD day a completed task counts for (the shared
 * completionDateKey rule: habit instances count for their own day).
 */
export function getCompletedTaskDateKey(
  task: Pick<Task, "status" | "completedAt" | "scheduledDate" | "updatedAt" | "habitId">
): string | null {
  return completionDateKey(task);
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
