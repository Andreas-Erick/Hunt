package com.hunt.companion;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Stats Widget (GLOSSARY.md): each Quest's hours over the rolling last 7 days against its weekly
 * target, today's Quest focus time and Habit streaks, drawn from the Widget Snapshot's `stats`
 * entries (ADR-0006). It only reads: it never writes a file and holds no Hunt rule; the numbers
 * come from HuntCore's buildWidgetStats (the app's Quest progress and streak rules).
 *
 * The class name is part of every placed widget: never rename it, or users lose their widgets
 * on update.
 *
 * Size: it shows as many Quest and streak rows as the widget's height in the current orientation
 * allows and counts the rest as "+N more". Redraws: snapshot change ({@link #refreshAll}),
 * APPWIDGET_UPDATE, resize, time or time-zone change, and just after local midnight through an
 * inexact alarm, when it switches to the snapshot's entry for the new day.
 */
public class StatsWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "HuntStatsWidget";
    /** Explicit broadcast from the midnight alarm (never exported). */
    static final String ACTION_MIDNIGHT = "com.hunt.companion.action.STATS_WIDGET_MIDNIGHT";

    /** Height assumed before the launcher reports one (the provider's minHeight). */
    private static final int DEFAULT_HEIGHT_DP = 110;

    private static final int[] QUEST_ROWS = {R.id.widget_stats_q0, R.id.widget_stats_q1, R.id.widget_stats_q2};
    private static final int[] QUEST_DOTS = {R.id.widget_stats_q0_dot, R.id.widget_stats_q1_dot, R.id.widget_stats_q2_dot};
    private static final int[] QUEST_CODES = {R.id.widget_stats_q0_code, R.id.widget_stats_q1_code, R.id.widget_stats_q2_code};
    private static final int[] QUEST_BARS = {R.id.widget_stats_q0_bar, R.id.widget_stats_q1_bar, R.id.widget_stats_q2_bar};
    private static final int[] QUEST_HOURS = {R.id.widget_stats_q0_hours, R.id.widget_stats_q1_hours, R.id.widget_stats_q2_hours};
    private static final int[] STREAK_ROWS = {
        R.id.widget_stats_s0, R.id.widget_stats_s1, R.id.widget_stats_s2, R.id.widget_stats_s3,
        R.id.widget_stats_s4, R.id.widget_stats_s5, R.id.widget_stats_s6, R.id.widget_stats_s7};
    private static final int[] STREAK_TITLES = {
        R.id.widget_stats_s0_title, R.id.widget_stats_s1_title, R.id.widget_stats_s2_title, R.id.widget_stats_s3_title,
        R.id.widget_stats_s4_title, R.id.widget_stats_s5_title, R.id.widget_stats_s6_title, R.id.widget_stats_s7_title};
    private static final int[] STREAK_DAYS = {
        R.id.widget_stats_s0_days, R.id.widget_stats_s1_days, R.id.widget_stats_s2_days, R.id.widget_stats_s3_days,
        R.id.widget_stats_s4_days, R.id.widget_stats_s5_days, R.id.widget_stats_s6_days, R.id.widget_stats_s7_days};

    /** What the widget can show for the current local date. */
    static final class Stats {
        /** The snapshot file: look, and noData ("Open Hunt to get started"). */
        WidgetSupport.Snapshot snapshot = new WidgetSupport.Snapshot();
        /** No stats entry for today (snapshot from an older day or app): "Open Hunt to refresh". */
        boolean stale;
        long focusSeconds;
        JSONArray quests = new JSONArray();
        JSONArray streaks = new JSONArray();
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        drawAll(ctx, mgr, ids);
        WidgetSupport.armMidnightAlarm(ctx, StatsWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.STATS_MIDNIGHT);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        mgr.updateAppWidget(id, draw(ctx, readStats(ctx), heightDp(ctx, options)));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent == null ? null : intent.getAction();
        if (WidgetSupport.isClockChange(action, ACTION_MIDNIGHT)) {
            refreshAll(ctx);
            WidgetSupport.armMidnightAlarm(ctx, StatsWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.STATS_MIDNIGHT);
        }
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetSupport.cancelMidnightAlarm(ctx, StatsWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.STATS_MIDNIGHT);
    }

    /** Redraws every placed Stats Widget from the snapshot file. Any thread; no-op when none is placed. */
    static void refreshAll(Context ctx) {
        if (ctx == null) return;
        try {
            int[] ids = WidgetSupport.placedIds(ctx, StatsWidgetProvider.class);
            if (ids.length == 0) return;
            drawAll(ctx, AppWidgetManager.getInstance(ctx), ids);
        } catch (RuntimeException e) {
            Log.w(TAG, "Stats Widget refresh failed", e);
        }
    }

    private static void drawAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        Stats stats = readStats(ctx);
        for (int id : ids) mgr.updateAppWidget(id, draw(ctx, stats, heightDp(ctx, mgr.getAppWidgetOptions(id))));
    }

    /** The widget's height in the current orientation ({@link StatsWidgetFit#heightDp}). */
    private static int heightDp(Context ctx, Bundle options) {
        int min = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        int max = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        boolean portrait = ctx.getResources().getConfiguration().orientation != Configuration.ORIENTATION_LANDSCAPE;
        return StatsWidgetFit.heightDp(min, max, portrait, DEFAULT_HEIGHT_DP);
    }

    private static RemoteViews draw(Context ctx, Stats stats, int heightDp) {
        WidgetLook look = stats.snapshot.look;
        if (stats.snapshot.noData || stats.stale) {
            return WidgetSupport.messageViews(ctx, stats.snapshot, WidgetRequestCodes.STATS_OPEN_HUNT);
        }
        RemoteViews views = new RemoteViews(ctx.getPackageName(), look.statsLayout);
        String focus = StatsWidgetFit.formatFocus(stats.focusSeconds);
        views.setTextViewText(R.id.widget_stats_focus, focus);
        views.setContentDescription(R.id.widget_stats_root, ctx.getString(R.string.stats_widget_open, focus));
        views.setOnClickPendingIntent(R.id.widget_stats_root, WidgetSupport.openHunt(ctx, WidgetRequestCodes.STATS_OPEN_HUNT));

        StatsWidgetFit fit = StatsWidgetFit.fit(heightDp, stats.quests.length(), stats.streaks.length());
        views.setViewVisibility(R.id.widget_stats_no_quests, stats.quests.length() == 0 ? View.VISIBLE : View.GONE);
        for (int i = 0; i < QUEST_ROWS.length; i++) {
            JSONObject q = i < fit.questRows ? stats.quests.optJSONObject(i) : null;
            views.setViewVisibility(QUEST_ROWS[i], q == null ? View.GONE : View.VISIBLE);
            if (q != null) drawQuest(ctx, views, i, q, look);
        }
        showMore(ctx, views, R.id.widget_stats_quests_more, fit.questsMore);

        views.setViewVisibility(R.id.widget_stats_streaks_header, stats.streaks.length() > 0 ? View.VISIBLE : View.GONE);
        for (int i = 0; i < STREAK_ROWS.length; i++) {
            JSONObject s = i < fit.streakRows ? stats.streaks.optJSONObject(i) : null;
            views.setViewVisibility(STREAK_ROWS[i], s == null ? View.GONE : View.VISIBLE);
            if (s == null) continue;
            views.setTextViewText(STREAK_TITLES[i], s.optString("title", ""));
            views.setTextViewText(STREAK_DAYS[i], Math.max(0, s.optInt("days", 0)) + "d");
        }
        showMore(ctx, views, R.id.widget_stats_streaks_more, fit.streaksMore);
        return views;
    }

    private static void drawQuest(Context ctx, RemoteViews views, int i, JSONObject q, WidgetLook look) {
        boolean met = q.optBoolean("met", false);
        views.setInt(QUEST_DOTS[i], "setColorFilter", ctx.getColor(look.questAccent(q.optString("accent"))));
        views.setTextViewText(QUEST_CODES[i], q.optString("code", ""));
        views.setProgressBar(QUEST_BARS[i], 100, Math.max(0, Math.min(100, q.optInt("pct", 0))), false);
        views.setTextViewText(QUEST_HOURS[i], StatsWidgetFit.formatHours(q.optLong("weekSeconds", 0), q.optDouble("targetHours", 0), met));
        views.setTextColor(QUEST_HOURS[i], ctx.getColor(met ? look.success : look.text));
    }

    private static void showMore(Context ctx, RemoteViews views, int id, int more) {
        views.setViewVisibility(id, more > 0 ? View.VISIBLE : View.GONE);
        if (more > 0) views.setTextViewText(id, ctx.getString(R.string.stats_widget_more, more));
    }

    /** Reads the snapshot file and picks the stats entry for the current local date. Any thread. */
    static Stats readStats(Context ctx) {
        Stats stats = new Stats();
        stats.snapshot = WidgetSupport.readSnapshot(ctx);
        JSONArray entries = stats.snapshot.entries(WidgetSupport.Snapshot.STATS);
        int at = WidgetSupport.Snapshot.indexOf(entries, WidgetSupport.localDateKey());
        stats.stale = at < 0;
        if (stats.stale) return stats;
        JSONObject entry = entries.optJSONObject(at);
        stats.focusSeconds = entry.optLong("focusSeconds", 0);
        JSONArray quests = entry.optJSONArray("quests");
        JSONArray streaks = entry.optJSONArray("streaks");
        stats.quests = quests == null ? new JSONArray() : quests;
        stats.streaks = streaks == null ? new JSONArray() : streaks;
        return stats;
    }
}
