"use client";

import React, { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Trash2,
} from "lucide-react";
import {
  db,
  accentStyle,
  dateFromKey,
  toLocalDateKey,
  formatChronoMMSS,
} from "@/lib/db";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";

export function TelemetryDashboardView() {
  const deleteTimeLog = useCommandStore((s) => s.deleteTimeLog);
  const quests = useLiveQuery(
    () => db.quests.orderBy("slotIndex").toArray(),
    []
  );

  const [weekOffset, setWeekOffset] = useState(0);
  const [showSessionHistory, setShowSessionHistory] = useState(false);

  const todayKey = toLocalDateKey();

  // The 7 days ending on today + weekOffset weeks, each a calendar step from a
  // noon anchor (DST-safe: no day is skipped or repeated).
  const weekDays = React.useMemo(() => {
    const days: Array<{
      dateKey: string;
      weekday: string;
      shortDate: string;
      isToday: boolean;
    }> = [];

    for (let i = 6; i >= 0; i--) {
      const d = dateFromKey(todayKey, weekOffset * 7 - i);
      const dateKey = toLocalDateKey(d.getTime());
      days.push({
        dateKey,
        weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
        shortDate: d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        isToday: dateKey === todayKey,
      });
    }
    return days;
  }, [weekOffset, todayKey]);

  const weekDateKeys = React.useMemo(
    () => weekDays.map((d) => d.dateKey),
    [weekDays]
  );

  const weekId = weekDateKeys.join(",");

  // Only the shown week's logs are read (dateKey is indexed), newest first.
  // The keys derive from weekOffset and todayKey, so the deps stay primitive.
  // After a week change useLiveQuery keeps returning the previous week's result
  // until the new read answers, so each result names its week, and another
  // week's result counts as still loading (not as an empty week).
  const weekResult = useLiveQuery(
    async () => ({
      weekId,
      logs: (await db.timeLogs.where("dateKey").anyOf(weekDateKeys).toArray()).sort(
        (a, b) => b.startTime - a.startTime
      ),
    }),
    [weekOffset, todayKey]
  );
  const loggedThisWeek =
    weekResult?.weekId === weekId ? weekResult.logs : undefined;
  // '–' instead of misleading zeros until the logs and targets have loaded.
  const loading = loggedThisWeek === undefined || quests === undefined;

  const dateRangeLabel = React.useMemo(() => {
    if (weekDays.length === 0) return "";
    return `${weekDays[0].shortDate} – ${weekDays[weekDays.length - 1].shortDate}`;
  }, [weekDays]);

  const weekLogs = React.useMemo(() => loggedThisWeek ?? [], [loggedThisWeek]);

  // Single-pass O(L) aggregation by day and by quest (eliminates nested O(Q * L) scans).
  const { byDay, byQuest } = React.useMemo(() => {
    const dayTotals = new Map<string, { questSec: number; otherSec: number }>();
    const questTotals = new Map<string, number>();
    for (const log of weekLogs) {
      let bucket = dayTotals.get(log.dateKey);
      if (!bucket) {
        bucket = { questSec: 0, otherSec: 0 };
        dayTotals.set(log.dateKey, bucket);
      }
      if (log.questId !== null) {
        bucket.questSec += log.durationSeconds;
        questTotals.set(
          log.questId,
          (questTotals.get(log.questId) ?? 0) + log.durationSeconds
        );
      } else {
        bucket.otherSec += log.durationSeconds;
      }
    }
    return { byDay: dayTotals, byQuest: questTotals };
  }, [weekLogs]);

  const dailyData = React.useMemo(() => {
    return weekDays.map((day) => {
      const bucket = byDay.get(day.dateKey);
      const questSec = bucket?.questSec ?? 0;
      const otherSec = bucket?.otherSec ?? 0;

      return {
        ...day,
        questHours: Number((questSec / 3600).toFixed(1)),
        otherHours: Number((otherSec / 3600).toFixed(1)),
      };
    });
  }, [weekDays, byDay]);

  const totalQuestHours = dailyData.reduce((acc, d) => acc + d.questHours, 0);
  const totalOtherHours = dailyData.reduce((acc, d) => acc + d.otherHours, 0);
  const grandTotalHours = totalQuestHours + totalOtherHours;

  const activeQuests = React.useMemo(
    () => (quests ?? []).filter((q) => !q.archived),
    [quests]
  );

  const totalWeeklyTargetHours = React.useMemo(() => {
    return activeQuests.reduce(
      (acc, q) => acc + (Number(q.targetWeeklyHours) || 0),
      0
    );
  }, [activeQuests]);

  const targetPct =
    totalWeeklyTargetHours > 0
      ? Math.round((totalQuestHours / totalWeeklyTargetHours) * 100)
      : 0;

  const activeDaysCount = Math.max(
    1,
    dailyData.filter((d) => d.questHours > 0 || d.otherHours > 0).length
  );
  const dailyAverage = totalQuestHours / activeDaysCount;

  const questVsOtherPct =
    grandTotalHours > 0
      ? Math.round((totalQuestHours / grandTotalHours) * 100)
      : 0;

  const maxDayQuestHours = Math.max(
    5,
    ...dailyData.map((d) => d.questHours)
  );

  const hoursByQuest = React.useMemo(() => {
    return (quests ?? [])
      .map((q) => {
        const sec = byQuest.get(q.id) ?? 0;
        return {
          quest: q,
          hours: Number((sec / 3600).toFixed(1)),
        };
      })
      .filter(({ quest, hours }) => !quest.archived || hours > 0);
  }, [quests, byQuest]);

  const maxQuestHours = Math.max(
    4,
    ...hoursByQuest.map((item) => item.hours)
  );

  const hoursText = (hours: number) =>
    loading ? "–" : `${hours.toFixed(1)}h`;

  // The store records the tombstone, deletes the row and requests a sync.
  const handleDeleteLog = async (id: string) => {
    hudAudio.playClick();
    await deleteTimeLog(id);
  };

  return (
    <div className="mx-auto max-w-[1440px] px-6 py-10 sm:px-10 lg:px-16 lg:py-12">
      {/* ================================================================= */}
      {/* HEADER: "Weekly review" + Date Range Controls                     */}
      {/* ================================================================= */}
      <div className="mb-10 flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-medium tracking-tight text-white sm:text-4xl">
            Weekly review
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            How much of the week moved your quests forward.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setWeekOffset((w) => w - 1)}
            aria-label="Previous week"
            className={`rounded-lg p-2 text-neutral-400 hover:bg-white/[0.05] hover:text-white ${PRESSABLE}`}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[120px] text-center text-sm text-neutral-200">
            {dateRangeLabel}
          </span>
          <button
            type="button"
            onClick={() => setWeekOffset((w) => Math.min(0, w + 1))}
            disabled={weekOffset === 0}
            aria-label="Next week"
            className={`rounded-lg p-2 text-neutral-400 enabled:hover:bg-white/[0.05] enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-30 ${PRESSABLE}`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => setWeekOffset(0)}
            className={`ml-2 flex items-center gap-2 rounded-full border border-white/10 bg-[#111318] px-4 py-2 text-xs font-medium text-neutral-200 hover:border-white/25 ${PRESSABLE}`}
          >
            <Calendar className="h-3.5 w-3.5 text-neutral-400" />
            <span>This week</span>
          </button>
        </div>
      </div>

      {/* ================================================================= */}
      {/* TOP ROW: 3 Large KPI Cards (Quest.app Weekly Review layout)       */}
      {/* ================================================================= */}
      <div className="mb-6 grid grid-cols-1 gap-6 md:grid-cols-3">
        {/* Card 1: QUEST HOURS */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Quest Hours
          </div>
          <div className="mt-4 flex items-baseline gap-2 tabular-nums">
            <span className="text-4xl font-medium tracking-tight text-[#ffb800] sm:text-5xl">
              {hoursText(totalQuestHours)}
            </span>
            <span className="text-lg text-hud-muted">
              / {loading ? "–" : `${totalWeeklyTargetHours}h`}
            </span>
          </div>
          <div className="mt-4 text-sm text-hud-muted tabular-nums">
            {loading ? "–" : `${targetPct}%`} of target
          </div>
        </div>

        {/* Card 2: DAILY AVERAGE */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Daily Average
          </div>
          <div className="mt-4 text-4xl font-medium tracking-tight text-white tabular-nums sm:text-5xl">
            {hoursText(dailyAverage)}
          </div>
        </div>

        {/* Card 3: QUEST WORK VS OTHER */}
        <div className="rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Quest Work vs Other
          </div>
          <div className="mt-4 flex items-baseline gap-1 tabular-nums">
            <span className="text-4xl font-medium tracking-tight text-white sm:text-5xl">
              {loading ? "–" : questVsOtherPct}
            </span>
            {!loading && <span className="text-xl text-hud-muted">%</span>}
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* BOTTOM ROW: 2-Column Split (Per Day Chart + Hours By Quest)       */}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left (7 cols): QUEST HOURS · PER DAY */}
        <div className="lg:col-span-7 flex flex-col justify-between rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Quest Hours · Per Day
          </div>

          <div className="mt-8 grid grid-cols-7 gap-3 sm:gap-5">
            {dailyData.map((day) => {
              const barPct =
                day.questHours > 0
                  ? Math.max(8, Math.round((day.questHours / maxDayQuestHours) * 100))
                  : 2;

              return (
                <div
                  key={day.dateKey}
                  data-testid="review-day"
                  data-date-key={day.dateKey}
                  className="flex flex-col items-center"
                >
                  {/* Top Hours Value */}
                  <span
                    className={`mb-4 font-mono text-xs tabular-nums ${
                      day.isToday
                        ? "font-semibold text-[#ffb800]"
                        : day.questHours > 0
                        ? "text-neutral-300"
                        : "text-hud-muted"
                    }`}
                  >
                    {day.questHours > 0 ? `${day.questHours}h` : "0h"}
                  </span>

                  {/* Vertical Bar Track */}
                  <div className="flex h-56 w-full max-w-[44px] items-end justify-center">
                    <div
                      style={{ height: `${barPct}%` }}
                      className={`w-full rounded-t-md transition-all duration-500 ${
                        day.isToday
                          ? "bg-[#ffb800]"
                          : day.questHours > 0
                          ? "bg-[#3b3d46]"
                          : "bg-white/[0.06]"
                      }`}
                    />
                  </div>

                  {/* Weekday Label */}
                  <span
                    className={`mt-4 text-xs ${
                      day.isToday
                        ? "font-medium text-[#ffb800]"
                        : "text-hud-muted"
                    }`}
                  >
                    {day.weekday}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right (5 cols): HOURS BY QUEST + QUEST WORK VS OTHER */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          {/* Card: HOURS BY QUEST */}
          <div className="flex-1 rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
            <div className="mb-6 text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
              Hours by Quest
            </div>

            <div className="space-y-5">
              {quests !== undefined && hoursByQuest.length === 0 && (
                <p className="text-sm text-hud-muted">
                  No quests yet. Create one in Quests.
                </p>
              )}
              {hoursByQuest.map(({ quest, hours }) => {
                const style = accentStyle(quest.accentColor);
                const widthPct =
                  hours > 0
                    ? Math.max(8, Math.round((hours / maxQuestHours) * 100))
                    : 0;

                return (
                  <div key={quest.id} className="space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.bg}`}
                        />
                        <span className="truncate text-neutral-200" title={quest.title}>
                          {quest.title}
                        </span>
                        {quest.archived && (
                          <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] text-hud-muted">
                            Completed
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-neutral-300">
                        {hours}h
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className={`h-full rounded-full ${style.bg} transition-all duration-500`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Card: QUEST WORK VS OTHER */}
          <div className="rounded-2xl border border-white/[0.08] bg-[#111318] p-7">
            <div className="mb-5 text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
              Quest Work vs Other
            </div>

            {/* Thick Proportion Bar */}
            <div className="flex h-11 w-full overflow-hidden rounded-lg bg-[#1d1f26]">
              <div
                style={{ width: `${questVsOtherPct}%` }}
                className="h-full bg-[#ffb800] transition-all duration-500"
              />
            </div>

            <div className="mt-4 flex items-center gap-6 text-xs">
              <div className="flex items-center gap-2 text-neutral-200">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ffb800]" />
                <span>Quest work · {hoursText(totalQuestHours)}</span>
              </div>
              <div className="flex items-center gap-2 text-hud-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-[#2c2f3a]" />
                <span>Other · {hoursText(totalOtherHours)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Collapsible Session History Log */}
      <div className="mt-10">
        <button
          type="button"
          onClick={() => setShowSessionHistory(!showSessionHistory)}
          aria-expanded={showSessionHistory}
          className={`text-xs font-medium uppercase tracking-[0.16em] text-hud-muted hover:text-neutral-300 ${PRESSABLE}`}
        >
          {showSessionHistory
            ? "Hide Session Log ↑"
            : `View Session Log (${loading ? "–" : weekLogs.length} sessions this week) ↓`}
        </button>

        {showSessionHistory && (
          <div className="mt-4 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.08] bg-[#111318] px-6 py-2">
            {loggedThisWeek !== undefined && weekLogs.length === 0 && (
              <p className="py-3.5 text-sm text-hud-muted">
                No sessions logged this week.
              </p>
            )}
            {weekLogs.map((log) => {
              const style = accentStyle(log.accentColorSnapshot);
              return (
                <div
                  key={log.id}
                  data-testid="session-row"
                  data-log-id={log.id}
                  className="group flex items-center justify-between gap-4 py-3.5 text-sm"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
                    <span className="w-24 shrink-0 text-xs text-hud-muted">
                      {log.dateKey}
                    </span>
                    <span className="truncate text-neutral-200" title={log.taskTitleSnapshot}>
                      {log.taskTitleSnapshot}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-4 font-mono text-xs tabular-nums text-neutral-400">
                    <span>
                      {formatChronoMMSS(log.durationSeconds).formatted}
                    </span>
                    {/* The arbitrary transition-property comes after the
                        component's transition-colors in the compiled CSS, so
                        both the colour and the hover fade transition. */}
                    <ConfirmDeleteButton
                      label="Delete session"
                      onConfirm={() => handleDeleteLog(log.id)}
                      className="whitespace-nowrap font-sans text-hud-muted opacity-0 hover:text-[#ff2a5f] group-hover:opacity-100 focus-visible:opacity-100 data-[state=armed]:opacity-100 [transition-property:color,opacity]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </ConfirmDeleteButton>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
