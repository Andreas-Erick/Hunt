"use client";

import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  Flame,
  Trash2,
  TrendingUp,
  X,
} from "lucide-react";
import {
  db,
  accentStyle,
  loadSortedQuests,
  formatChronoMMSS,
} from "@/lib/db";
import {
  buildHorizonWindow,
  computeActivityHeatmap,
  computePeriodReport,
  formatTelemetryDuration,
  getHeatmapStartKey,
  type ReviewChartMetric,
  type ReviewHorizon,
  type ReviewScope,
} from "@/lib/reviewAnalytics";
import { hudAudio } from "@/lib/hudAudio";
import { useCommandStore } from "@/store/useCommandStore";
import { ConfirmDeleteButton } from "./ConfirmDeleteButton";
import { ReviewHeatmapCard } from "./ReviewHeatmapCard";
import { useTodayDateKey } from "./useTodayDateKey";

const PRESSABLE = "transition-colors duration-150 ease-out active:opacity-80";
const HEATMAP_WEEKS_DESKTOP = 26;
export const SESSION_LOG_PAGE_SIZE = 50;

const HORIZON_OPTIONS: ReadonlyArray<{ id: ReviewHorizon; label: string }> = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
  { id: "year", label: "Year" },
];

export function TelemetryDashboardView() {
  const deleteTimeLog = useCommandStore((s) => s.deleteTimeLog);
  const quests = useLiveQuery(() => loadSortedQuests(), []);

  const [horizon, setHorizon] = useState<ReviewHorizon>("week");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [scope, setScope] = useState<ReviewScope>("ALL");
  const [chartMetric, setChartMetric] = useState<ReviewChartMetric>("hours");
  const [showScopeMenu, setShowScopeMenu] = useState(false);
  const [showSessionHistory, setShowSessionHistory] = useState(false);
  const [visibleLogLimit, setVisibleLogLimit] = useState(SESSION_LOG_PAGE_SIZE);
  const scopeMenuRef = useRef<HTMLDivElement | null>(null);
  const scopeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const scopeListboxRef = useRef<HTMLDivElement | null>(null);

  const todayKey = useTodayDateKey();

  useEffect(() => {
    if (!showScopeMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (scopeMenuRef.current && !scopeMenuRef.current.contains(e.target as Node)) {
        setShowScopeMenu(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setShowScopeMenu(false);
      // The focused option unmounts with the list: hand focus back to the trigger.
      scopeTriggerRef.current?.focus();
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [showScopeMenu]);

  // Opening the list moves focus to the selected option (or the first one).
  useEffect(() => {
    if (!showScopeMenu) return;
    const listbox = scopeListboxRef.current;
    const target =
      listbox?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      listbox?.querySelector<HTMLElement>('[role="option"]');
    target?.focus();
  }, [showScopeMenu]);

  const windowSpec = React.useMemo(
    () => buildHorizonWindow(horizon, periodOffset, todayKey),
    [horizon, periodOffset, todayKey]
  );

  const periodId = `${horizon}:${periodOffset}:${windowSpec.startKey}:${windowSpec.endKey}`;

  // Indexed read ONLY on dateKey (never toArray / orderBy / toCollection on db.timeLogs).
  // Each result carries its periodId so stepping to another week/month shows '–' until loaded.
  const periodResult = useLiveQuery(
    async () => ({
      periodId,
      logs: (
        await db.timeLogs
          .where("dateKey")
          .between(windowSpec.startKey, windowSpec.endKey, true, true)
          .toArray()
      ).sort((a, b) => b.startTime - a.startTime),
    }),
    [horizon, periodOffset, todayKey]
  );

  const heatmapStartKey = React.useMemo(
    () => getHeatmapStartKey(HEATMAP_WEEKS_DESKTOP, todayKey),
    [todayKey]
  );

  const heatmapLogs = useLiveQuery(
    () =>
      db.timeLogs
        .where("dateKey")
        .between(heatmapStartKey, todayKey, true, true)
        .toArray(),
    [heatmapStartKey, todayKey]
  );

  const completedTasks = useLiveQuery(
    () => db.tasks.where("status").equals("completed").toArray(),
    []
  );

  const periodLogs =
    periodResult?.periodId === periodId ? periodResult.logs : undefined;
  const loading = periodLogs === undefined || quests === undefined;

  const selectedQuest = React.useMemo(() => {
    if (scope === "ALL" || scope === "OTHER") return null;
    return (quests ?? []).find((q) => q.id === scope) ?? null;
  }, [quests, scope]);

  // If the selected quest was deleted, fall back cleanly to ALL.
  const effectiveScope: ReviewScope =
    scope !== "ALL" && scope !== "OTHER" && quests !== undefined && !selectedQuest
      ? "ALL"
      : scope;

  const report = React.useMemo(
    () =>
      computePeriodReport({
        window: windowSpec,
        logs: periodLogs ?? [],
        tasks: completedTasks ?? [],
        quests: quests ?? [],
        scope: effectiveScope,
        todayKey,
      }),
    [windowSpec, periodLogs, completedTasks, quests, effectiveScope, todayKey]
  );

  const heatmap = React.useMemo(
    () =>
      computeActivityHeatmap({
        logs: heatmapLogs ?? [],
        tasks: completedTasks ?? [],
        scope: effectiveScope,
        weeksCount: HEATMAP_WEEKS_DESKTOP,
        todayKey,
      }),
    [heatmapLogs, completedTasks, effectiveScope, todayKey]
  );

  const scopeTitle =
    effectiveScope === "ALL"
      ? "All Quests"
      : effectiveScope === "OTHER"
      ? "Other work"
      : selectedQuest?.title ?? "All Quests";

  const scopeStyle = selectedQuest
    ? accentStyle(selectedQuest.accentColor)
    : effectiveScope === "OTHER"
    ? accentStyle("slate")
    : null;

  const primaryBarClass = scopeStyle ? scopeStyle.bg : "bg-[#ffb800]";
  const primaryTextClass = scopeStyle ? scopeStyle.text : "text-[#ffb800]";

  useEffect(() => {
    setVisibleLogLimit(SESSION_LOG_PAGE_SIZE);
  }, [periodId, effectiveScope]);

  const maxBucketValue = React.useMemo(() => {
    if (chartMetric === "tasks") {
      return Math.max(4, ...report.buckets.map((b) => b.completedTasks));
    }
    return Math.max(1800, ...report.buckets.map((b) => b.seconds));
  }, [chartMetric, report.buckets]);

  const maxQuestSeconds = Math.max(
    1800,
    ...report.questBreakdown.map((item) => item.seconds)
  );

  const durationText = (seconds: number, zeroAs = "0.0h") =>
    loading ? "–" : formatTelemetryDuration(seconds, { zeroAs });

  const handleHorizonChange = (next: ReviewHorizon) => {
    if (next === horizon) return;
    hudAudio.playClick();
    setHorizon(next);
    setPeriodOffset(0);
  };

  const handleScopeChange = (next: ReviewScope) => {
    hudAudio.playClick();
    setScope(next);
    setShowScopeMenu(false);
  };

  /** Picking an option closes the list; focus returns to the trigger instead of <body>. */
  const handleScopeOptionSelect = (next: ReviewScope) => {
    handleScopeChange(next);
    scopeTriggerRef.current?.focus();
  };

  /** ArrowUp / ArrowDown (wrapping), Home and End move focus between the options. */
  const handleScopeListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const options = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')
    );
    if (options.length === 0) return;
    e.preventDefault();
    const current = options.findIndex((el) => el === document.activeElement);
    const last = options.length - 1;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
        ? last
        : e.key === "ArrowDown"
        ? current < 0 || current === last
          ? 0
          : current + 1
        : current <= 0
        ? last
        : current - 1;
    options[next].focus();
  };

  const handleDeleteLog = async (id: string) => {
    hudAudio.playClick();
    await deleteTimeLog(id);
  };

  const chartGridColsClass =
    horizon === "day"
      ? "grid-cols-6 gap-3 sm:gap-5"
      : horizon === "week"
      ? "grid-cols-7 gap-3 sm:gap-5"
      : horizon === "quarter"
      ? "grid-cols-3 gap-5 sm:gap-8"
      : horizon === "year"
      ? "grid-cols-12 gap-1.5 sm:gap-2.5"
      : report.buckets.length === 4
      ? "grid-cols-4 gap-4 sm:gap-6"
      : "grid-cols-5 gap-3 sm:gap-5";

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-10 sm:py-10 lg:px-16 lg:py-12">
      {/* ================================================================= */}
      {/* HEADER: Horizon Title + Scope Picker + Period Navigation          */}
      {/* ================================================================= */}
      <div className="mb-8 flex flex-col justify-between gap-5 sm:gap-6 lg:flex-row lg:items-end">
        <div>
          <h1 className="text-[clamp(1.625rem,2.2vw+1rem,2.25rem)] font-medium leading-tight tracking-tight text-white">
            {windowSpec.heading}
          </h1>
          <p className="mt-2 max-w-[65ch] text-sm text-neutral-400">
            {windowSpec.subtitle}
          </p>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2.5 sm:gap-3">
          {/* Quest Scope Filter Dropdown */}
          <div ref={scopeMenuRef} className="relative max-w-full">
            <button
              ref={scopeTriggerRef}
              type="button"
              onClick={() => setShowScopeMenu((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={showScopeMenu}
              aria-label={`Filter review scope: ${scopeTitle}`}
              className={`flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-[#111318] px-3.5 py-2 text-xs font-medium text-neutral-200 hover:border-white/25 ${PRESSABLE}`}
            >
              {scopeStyle ? (
                <span className={`h-2 w-2 shrink-0 rounded-full ${scopeStyle.bg}`} />
              ) : (
                <Filter className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              )}
              <span className="max-w-[160px] truncate">
                {effectiveScope === "ALL" ? "All Quests" : scopeTitle}
              </span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-hud-muted" />
            </button>

            {showScopeMenu && (
              <div
                ref={scopeListboxRef}
                role="listbox"
                aria-label="Quest filter options"
                onKeyDown={handleScopeListKeyDown}
                className="absolute left-0 sm:left-auto sm:right-0 z-30 mt-2 max-h-[min(22rem,70dvh)] w-[min(16rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-white/12 bg-[#141720] p-1 shadow-2xl"
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={effectiveScope === "ALL"}
                  tabIndex={effectiveScope === "ALL" ? 0 : -1}
                  onClick={() => handleScopeOptionSelect("ALL")}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
                    effectiveScope === "ALL"
                      ? "bg-white/10 font-medium text-white"
                      : "text-neutral-300 hover:bg-white/[0.05]"
                  } ${PRESSABLE}`}
                >
                  <span>All Quests</span>
                  <span className="text-[11px] text-hud-muted">Aggregate</span>
                </button>

                {(quests ?? []).map((q) => {
                  const st = accentStyle(q.accentColor);
                  const active = effectiveScope === q.id;
                  return (
                    <button
                      key={q.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      tabIndex={active ? 0 : -1}
                      onClick={() => handleScopeOptionSelect(q.id)}
                      className={`mt-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs ${
                        active
                          ? "bg-white/10 font-medium text-white"
                          : "text-neutral-300 hover:bg-white/[0.05]"
                      } ${PRESSABLE}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${st.bg}`} />
                        <span className="truncate">{q.title}</span>
                      </span>
                      {q.archived && (
                        <span className="shrink-0 text-[10px] text-hud-muted">Done</span>
                      )}
                    </button>
                  );
                })}

                <div className="my-1 border-t border-white/[0.06]" />
                <button
                  type="button"
                  role="option"
                  aria-selected={effectiveScope === "OTHER"}
                  tabIndex={effectiveScope === "OTHER" ? 0 : -1}
                  onClick={() => handleScopeOptionSelect("OTHER")}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs ${
                    effectiveScope === "OTHER"
                      ? "bg-white/10 font-medium text-white"
                      : "text-neutral-300 hover:bg-white/[0.05]"
                  } ${PRESSABLE}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-slate-500" />
                    <span>Other work</span>
                  </span>
                  <span className="text-[11px] text-hud-muted">Unassigned</span>
                </button>
              </div>
            )}
          </div>

          {effectiveScope !== "ALL" && (
            <button
              type="button"
              onClick={() => handleScopeChange("ALL")}
              aria-label="Clear quest filter"
              className={`flex items-center gap-1 rounded-full border border-white/15 bg-white/[0.06] px-2.5 py-2 text-xs text-neutral-300 hover:border-white/30 hover:text-white ${PRESSABLE}`}
            >
              <X className="h-3.5 w-3.5" />
              <span>Reset</span>
            </button>
          )}

          {/* Horizon Segmented Selector */}
          <div
            role="group"
            aria-label="Review timeframe"
            className="flex max-w-full flex-wrap items-center rounded-2xl sm:rounded-full border border-white/10 bg-[#111318] p-1"
          >
            {HORIZON_OPTIONS.map((opt) => {
              const active = horizon === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handleHorizonChange(opt.id)}
                  className={`rounded-full px-2.5 sm:px-3 py-1.5 text-xs font-medium ${
                    active
                      ? "bg-white/12 text-white"
                      : "text-hud-muted hover:text-neutral-200"
                  } ${PRESSABLE}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {/* Period Stepper */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => setPeriodOffset((w) => w - 1)}
              aria-label={windowSpec.prevLabel}
              title={windowSpec.prevLabel}
              className={`rounded-lg p-2 text-neutral-400 hover:bg-white/[0.05] hover:text-white ${PRESSABLE}`}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[96px] sm:min-w-[120px] text-center text-xs sm:text-sm text-neutral-200 tabular-nums">
              {windowSpec.rangeLabel}
            </span>
            <button
              type="button"
              onClick={() => setPeriodOffset((w) => Math.min(0, w + 1))}
              disabled={periodOffset === 0}
              aria-label={windowSpec.nextLabel}
              title={windowSpec.nextLabel}
              className={`rounded-lg p-2 text-neutral-400 enabled:hover:bg-white/[0.05] enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-30 ${PRESSABLE}`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => setPeriodOffset(0)}
              className={`sm:ml-1 flex items-center gap-2 rounded-full border border-white/10 bg-[#111318] px-3.5 sm:px-4 py-2 text-xs font-medium text-neutral-200 hover:border-white/25 ${PRESSABLE}`}
            >
              <Calendar className="h-3.5 w-3.5 text-neutral-400" />
              <span>{windowSpec.currentLabel}</span>
            </button>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* TOP ROW: 3 Large Hero KPI Cards                                   */}
      {/* ================================================================= */}
      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-4 sm:gap-6">
        {/* Card 1: QUEST HOURS */}
        <div className="cq-card rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            {effectiveScope === "OTHER" ? "Other Work Hours" : "Quest Hours"}
          </div>
          <div className="mt-4 flex flex-wrap items-baseline gap-2 tabular-nums">
            <span className={`text-4xl font-medium tracking-tight sm:text-5xl ${primaryTextClass}`}>
              {durationText(report.focusSeconds)}
            </span>
            {effectiveScope !== "OTHER" && (
              <span className="text-lg text-hud-muted">
                / {loading ? "–" : `${report.targetHours}h`}
              </span>
            )}
          </div>
          <div className="mt-4 text-sm text-hud-muted tabular-nums">
            {effectiveScope === "OTHER"
              ? "Maintenance & unassigned sessions"
              : `${loading ? "–" : `${report.targetPct}%`} of target`}
          </div>
        </div>

        {/* Card 2: DAILY AVERAGE */}
        <div className="cq-card rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            Daily Average
          </div>
          <div className="mt-4 text-4xl font-medium tracking-tight text-white tabular-nums sm:text-5xl">
            {durationText(report.dailyAverageSeconds)}
          </div>
          <div className="mt-4 text-sm text-hud-muted tabular-nums">
            {loading
              ? "– active days"
              : `${report.activeDaysCount} of ${windowSpec.elapsedDays} ${
                  windowSpec.elapsedDays === 1 ? "day" : "days"
                } active (${report.consistencyPct}%)`}
          </div>
        </div>

        {/* Card 3: QUEST WORK VS OTHER (or Share of Total Focus when scoped) */}
        <div className="cq-card rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
          <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
            {effectiveScope === "ALL" ? "Quest Work vs Other" : "Share of Total Focus"}
          </div>
          <div className="mt-4 flex items-baseline gap-1 tabular-nums">
            <span className="text-4xl font-medium tracking-tight text-white sm:text-5xl">
              {loading ? "–" : report.focusSharePct}
            </span>
            {!loading && <span className="text-xl text-hud-muted">%</span>}
          </div>
          <div className="mt-4 text-sm text-hud-muted tabular-nums">
            {loading
              ? "– focus split"
              : effectiveScope === "ALL"
              ? `${formatTelemetryDuration(report.questSeconds)} quest · ${formatTelemetryDuration(report.otherSeconds)} other`
              : `Of ${formatTelemetryDuration(report.grandTotalSeconds)} total logged`}
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* EXTENDED TELEMETRY STRIP: Tasks Completed, Bouts, Streak, Peak    */}
      {/* ================================================================= */}
      <div className="mb-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,11.5rem),1fr))] gap-4">
        <div
          data-testid="stat-tasks-completed"
          className="rounded-2xl border border-white/[0.08] bg-[#111318] p-5"
        >
          <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
            <span>Tasks Completed</span>
            <CheckCircle2 className="h-3.5 w-3.5 text-[#00ff9d]" />
          </div>
          <div className="mt-3 text-2xl font-medium text-white tabular-nums sm:text-3xl">
            {completedTasks === undefined ? "–" : report.completedTasksCount}
          </div>
          <div className="mt-1.5 text-xs text-hud-muted tabular-nums">
            {completedTasks === undefined
              ? "–"
              : `${report.stepTasksCompleted} ${
                  report.stepTasksCompleted === 1 ? "step" : "steps"
                } · ${report.habitTasksCompleted} ${
                  report.habitTasksCompleted === 1 ? "habit" : "habits"
                }`}
          </div>
        </div>

        <div
          data-testid="stat-focus-bouts"
          className="rounded-2xl border border-white/[0.08] bg-[#111318] p-5"
        >
          <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
            <span>Focus Sessions</span>
            <Clock className="h-3.5 w-3.5 text-[#00f0ff]" />
          </div>
          <div className="mt-3 text-2xl font-medium text-white tabular-nums sm:text-3xl">
            {loading ? "–" : report.sessionsCount}
          </div>
          <div className="mt-1.5 text-xs text-hud-muted tabular-nums">
            {loading
              ? "–"
              : report.sessionsCount > 0
              ? `Avg ${report.avgSessionMinutes}m · Max ${report.longestSessionMinutes}m`
              : "No sessions yet"}
          </div>
        </div>

        <div
          data-testid="stat-focus-streak"
          className="rounded-2xl border border-white/[0.08] bg-[#111318] p-5"
        >
          <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
            <span>Active Streak</span>
            <Flame className="h-3.5 w-3.5 text-[#ffb800]" />
          </div>
          <div className="mt-3 text-2xl font-medium text-white tabular-nums sm:text-3xl">
            {heatmapLogs === undefined ? "–" : `${heatmap.currentStreak}d`}
          </div>
          <div className="mt-1.5 text-xs text-hud-muted tabular-nums">
            {heatmapLogs === undefined
              ? "–"
              : `Best ${heatmap.longestStreak}d in last 26 wks`}
          </div>
        </div>

        <div
          data-testid="stat-peak-bucket"
          className="rounded-2xl border border-white/[0.08] bg-[#111318] p-5"
        >
          <div className="flex items-center justify-between text-xs font-medium uppercase tracking-[0.14em] text-neutral-400">
            <span>Peak Window</span>
            <TrendingUp className="h-3.5 w-3.5 text-[#ffb800]" />
          </div>
          <div className="mt-3 truncate text-2xl font-medium text-white tabular-nums sm:text-3xl">
            {loading ? "–" : report.peakBucket ? report.peakBucket.detailLabel : "—"}
          </div>
          <div className="mt-1.5 text-xs text-hud-muted tabular-nums">
            {loading
              ? "–"
              : report.peakBucket
              ? `${formatTelemetryDuration(report.peakBucket.seconds, { zeroAs: "0h", compactLarge: true })} · ${report.peakBucket.completedTasks} ${
                  report.peakBucket.completedTasks === 1 ? "task" : "tasks"
                }`
              : "No activity in period"}
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* MIDDLE ROW: 2-Column Split (Trend Bar Chart + By Quest Breakdown) */}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left (7 cols): Adaptive Horizon Bar Chart (Hours or Tasks) */}
        <div className="cq-card min-w-0 lg:col-span-7 flex flex-col justify-between rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
              {chartMetric === "hours" ? "Quest Hours" : "Completed Tasks"} ·{" "}
              {horizon === "day"
                ? "By Time Block"
                : horizon === "week"
                ? "Per Day"
                : horizon === "month"
                ? "By Week"
                : "Per Month"}
            </div>

            <div
              role="group"
              aria-label="Chart metric"
              className="flex items-center rounded-full border border-white/10 bg-[#0b0d12] p-0.5"
            >
              <button
                type="button"
                aria-pressed={chartMetric === "hours"}
                onClick={() => setChartMetric("hours")}
                className={`rounded-full px-3 py-1 text-[11px] font-medium ${
                  chartMetric === "hours"
                    ? "bg-white/12 text-white"
                    : "text-hud-muted hover:text-neutral-200"
                } ${PRESSABLE}`}
              >
                Hours
              </button>
              <button
                type="button"
                aria-pressed={chartMetric === "tasks"}
                onClick={() => setChartMetric("tasks")}
                className={`rounded-full px-3 py-1 text-[11px] font-medium ${
                  chartMetric === "tasks"
                    ? "bg-white/12 text-white"
                    : "text-hud-muted hover:text-neutral-200"
                } ${PRESSABLE}`}
              >
                Tasks
              </button>
            </div>
          </div>

          <div className={horizon === "year" ? "scroll-shadow-x mt-8 overflow-x-auto pb-1" : "mt-8"}>
            <div className={`grid ${horizon === "year" ? "min-w-[21rem] " : ""}${chartGridColsClass}`}>
            {report.buckets.map((bucket) => {
              const rawValue =
                chartMetric === "hours" ? bucket.seconds : bucket.completedTasks;
              const barPct =
                rawValue > 0
                  ? Math.max(8, Math.round((rawValue / maxBucketValue) * 100))
                  : 2;
              const valueLabel =
                chartMetric === "hours"
                  ? formatTelemetryDuration(bucket.seconds, {
                      zeroAs: "0h",
                      compactLarge: true,
                    })
                  : bucket.completedTasks >= 1000
                  ? `${(bucket.completedTasks / 1000).toFixed(1)}k`
                  : `${bucket.completedTasks}`;

              return (
                <div
                  key={bucket.key}
                  data-testid={horizon === "week" ? "review-day" : "review-bucket"}
                  data-date-key={bucket.dateKey}
                  className="flex min-w-0 flex-col items-center"
                >
                  <span
                    className={`mb-4 max-w-full truncate font-mono ${
                      horizon === "year" ? "text-[10px] sm:text-xs" : "text-xs"
                    } tabular-nums ${
                      bucket.isCurrent
                        ? `font-semibold ${primaryTextClass}`
                        : rawValue > 0
                        ? "text-neutral-300"
                        : "text-hud-muted"
                    }`}
                  >
                    {valueLabel}
                  </span>

                  <div className="flex h-56 w-full max-w-[44px] items-end justify-center">
                    <div
                      style={{ height: `${barPct}%` }}
                      className={`w-full rounded-t-md transition-all duration-500 ${
                        bucket.isCurrent
                          ? primaryBarClass
                          : rawValue > 0
                          ? "bg-[#3b3d46]"
                          : "bg-white/[0.06]"
                      }`}
                    />
                  </div>

                  <span
                    className={`mt-4 truncate text-xs ${
                      bucket.isCurrent
                        ? `font-medium ${primaryTextClass}`
                        : "text-hud-muted"
                    }`}
                  >
                    {bucket.label}
                  </span>
                </div>
              );
            })}
            </div>
          </div>
        </div>

        {/* Right (5 cols): HOURS & TASKS BY QUEST + QUEST WORK VS OTHER */}
        <div className="min-w-0 lg:col-span-5 flex flex-col gap-6">
          <div className="cq-card flex-1 rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
            <div className="mb-6 flex items-center justify-between gap-2">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
                Hours by Quest
              </div>
              {report.questBreakdown.length > 0 && (
                <span className="text-[11px] text-hud-muted">
                  Tasks &amp; hours · Click to filter
                </span>
              )}
            </div>

            <div className="space-y-4">
              {quests !== undefined && report.questBreakdown.length === 0 && (
                <p className="text-sm text-hud-muted">
                  No quests yet. Create one in Quests.
                </p>
              )}
              {report.questBreakdown.map(({ quest, seconds: qSeconds, completedTasks: qTasks }) => {
                const style = accentStyle(quest.accentColor);
                const isSelected = effectiveScope === quest.id;
                const widthPct =
                  qSeconds > 0
                    ? Math.max(8, Math.round((qSeconds / maxQuestSeconds) * 100))
                    : 0;

                return (
                  <button
                    key={quest.id}
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`Inspect quest ${quest.title}`}
                    onClick={() =>
                      handleScopeChange(isSelected ? "ALL" : quest.id)
                    }
                    className={`block w-full rounded-xl border p-3 text-left text-sm ${
                      isSelected
                        ? "border-white/25 bg-white/[0.05]"
                        : "border-transparent hover:border-white/10 hover:bg-white/[0.02]"
                    } ${PRESSABLE}`}
                  >
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
                        <span className="text-hud-muted">
                          {qTasks} {qTasks === 1 ? "task" : "tasks"} ·{" "}
                        </span>
                        <span>
                          {formatTelemetryDuration(qSeconds, {
                            zeroAs: "0h",
                            compactLarge: true,
                          })}
                        </span>
                      </span>
                    </div>
                    <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-white/[0.05]">
                      <div
                        className={`h-full rounded-full ${style.bg} transition-all duration-500`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Card: QUEST WORK VS OTHER */}
          <div className="cq-card rounded-2xl border border-white/[0.08] bg-[#111318] p-5 sm:p-7">
            <div className="mb-5 text-xs font-medium uppercase tracking-[0.16em] text-neutral-400">
              Quest Work vs Other
            </div>

            <div className="flex h-11 w-full overflow-hidden rounded-lg bg-[#1d1f26]">
              <div
                style={{
                  width: `${
                    report.grandTotalSeconds > 0
                      ? Math.round((report.questSeconds / report.grandTotalSeconds) * 100)
                      : 0
                  }%`,
                }}
                className="h-full bg-[#ffb800] transition-all duration-500"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-6 text-xs">
              <div className="flex items-center gap-2 text-neutral-200">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ffb800]" />
                <span>Quest work · {durationText(report.questSeconds)}</span>
              </div>
              <div className="flex items-center gap-2 text-hud-muted">
                <span className="h-2.5 w-2.5 rounded-full bg-[#2c2f3a]" />
                <span>
                  Other · {durationText(report.otherSeconds)} ({report.otherTasksCompleted}{" "}
                  {report.otherTasksCompleted === 1 ? "task" : "tasks"})
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* ACTIVITY HEATMAP (26 Weeks, Scoped to All Quests or Quest X)      */}
      {/* ================================================================= */}
      <ReviewHeatmapCard
        heatmap={heatmap}
        scopeTitle={scopeTitle}
        paletteAccent={
          selectedQuest
            ? selectedQuest.accentColor
            : effectiveScope === "OTHER"
            ? "slate"
            : "amber"
        }
      />

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
            : `View Session Log (${loading ? "–" : report.filteredLogs.length} sessions ${windowSpec.sessionUnitLabel}) ↓`}
        </button>

        {showSessionHistory && (
          <div className="mt-4 divide-y divide-white/[0.05] rounded-2xl border border-white/[0.08] bg-[#111318] px-4 sm:px-6 py-2">
            {periodLogs !== undefined && report.filteredLogs.length === 0 && (
              <p className="py-3.5 text-sm text-hud-muted">
                No sessions logged {windowSpec.sessionUnitLabel}.
              </p>
            )}
            {report.filteredLogs.slice(0, visibleLogLimit).map((log) => {
              const style = accentStyle(log.accentColorSnapshot);
              return (
                <div
                  key={log.id}
                  data-testid="session-row"
                  data-log-id={log.id}
                  className="group flex flex-wrap sm:flex-nowrap items-center justify-between gap-2 sm:gap-4 py-3.5 text-sm"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5 sm:gap-3">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.bg}`} />
                    <span className="shrink-0 font-mono text-xs tabular-nums text-hud-muted">
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
            {report.filteredLogs.length > visibleLogLimit && (
              <div className="py-3 text-center">
                <button
                  type="button"
                  data-testid="review-logs-show-more"
                  onClick={() =>
                    setVisibleLogLimit((cur) => cur + SESSION_LOG_PAGE_SIZE)
                  }
                  className={`rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-xs font-medium text-neutral-200 hover:border-white/25 hover:text-white ${PRESSABLE}`}
                >
                  Show more sessions ({report.filteredLogs.length - visibleLogLimit}{" "}
                  remaining)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
