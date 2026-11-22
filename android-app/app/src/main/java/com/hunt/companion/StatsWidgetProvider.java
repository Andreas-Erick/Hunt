package com.hunt.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * Stats Widget (GLOSSARY.md): each Quest's hours over the rolling last 7 days against its weekly
 * target, today's Quest focus time and Habit streaks, drawn from the Widget Snapshot's `stats`
 * entries (ADR-0006). It only reads: it never writes a file and holds no Hunt rule; the numbers
 * come from HuntCore's buildWidgetStats (the app's Quest progress and streak rules).
 *
 * The class name is part of every placed widget: never rename it, or users lose their widgets
 * on update.
 *
 * Size: it shows as many Quest and streak rows as the widget's height allows and counts the rest
 * as "+N more". Redraws: snapshot change ({@link #refreshAll}), APPWIDGET_UPDATE, resize, time or
 * time-zone change, and just after local midnight through an inexact alarm, when it switches to
 * the snapshot's entry for the new day.
 */
public class StatsWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "HuntStatsWidget";
    /** Explicit broadcast from the midnight alarm (never exported). */
    static final String ACTION_MIDNIGHT = "com.hunt.companion.action.STATS_WIDGET_MIDNIGHT";
    private static final int MIDNIGHT_SLACK_MINUTES = 1;
    private static final int OPEN_HUNT_REQUEST = 20;
    private static final int MIDNIGHT_REQUEST = 21;

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
        String look = "neon";
        /** No snapshot yet, or the user has nothing in Hunt: "Open Hunt to get started". */
        boolean noData = true;
        /** No stats entry for today (snapshot from an older day or app): "Open Hunt to refresh". */
        boolean stale;
        long focusSeconds;
        JSONArray quests = new JSONArray();
        JSONArray streaks = new JSONArray();
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        drawAll(ctx, mgr, ids);
        armMidnightAlarm(ctx);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle options) {
        mgr.updateAppWidget(id, draw(ctx, readStats(ctx), heightDp(options)));
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent == null ? null : intent.getAction();
        if (ACTION_MIDNIGHT.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            refreshAll(ctx);
            armMidnightAlarm(ctx);
        }
    }

    @Override
    public void onDisabled(Context ctx) {
        AlarmManager alarms = ctx.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(midnightIntent(ctx));
    }

    /** Redraws every placed Stats Widget from the snapshot file. Any thread; no-op when none is placed. */
    static void refreshAll(Context ctx) {
        if (ctx == null) return;
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, StatsWidgetProvider.class));
            if (ids == null || ids.length == 0) return;
            drawAll(ctx, mgr, ids);
        } catch (RuntimeException e) {
            Log.w(TAG, "Stats Widget refresh failed", e);
        }
    }

    private static void drawAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        Stats stats = readStats(ctx);
        for (int id : ids) mgr.updateAppWidget(id, draw(ctx, stats, heightDp(mgr.getAppWidgetOptions(id))));
    }

    private static int heightDp(Bundle options) {
        int h = options == null ? 0 : options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        return h > 0 ? h : DEFAULT_HEIGHT_DP;
    }

    private static RemoteViews draw(Context ctx, Stats stats, int heightDp) {
        if (stats.noData || stats.stale) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), WidgetLook.messageLayout(stats.look));
            views.setTextViewText(R.id.widget_message,
                    ctx.getString(stats.noData ? R.string.day_widget_get_started : R.string.day_widget_refresh));
            views.setOnClickPendingIntent(R.id.widget_message_root, openHunt(ctx));
            return views;
        }
        RemoteViews views = new RemoteViews(ctx.getPackageName(), WidgetLook.statsLayout(stats.look));
        String focus = StatsWidgetFit.formatFocus(stats.focusSeconds);
        views.setTextViewText(R.id.widget_stats_focus, focus);
        views.setContentDescription(R.id.widget_stats_root, ctx.getString(R.string.stats_widget_open, focus));
        views.setOnClickPendingIntent(R.id.widget_stats_root, openHunt(ctx));

        StatsWidgetFit fit = StatsWidgetFit.fit(heightDp, stats.quests.length(), stats.streaks.length());
        views.setViewVisibility(R.id.widget_stats_no_quests, stats.quests.length() == 0 ? View.VISIBLE : View.GONE);
        for (int i = 0; i < QUEST_ROWS.length; i++) {
            JSONObject q = i < fit.questRows ? stats.quests.optJSONObject(i) : null;
            views.setViewVisibility(QUEST_ROWS[i], q == null ? View.GONE : View.VISIBLE);
            if (q != null) drawQuest(ctx, views, i, q, stats.look);
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

    private static void drawQuest(Context ctx, RemoteViews views, int i, JSONObject q, String look) {
        boolean met = q.optBoolean("met", false);
        views.setInt(QUEST_DOTS[i], "setColorFilter", ctx.getColor(WidgetLook.questAccent(look, q.optString("accent"))));
        views.setTextViewText(QUEST_CODES[i], q.optString("code", ""));
        views.setProgressBar(QUEST_BARS[i], 100, Math.max(0, Math.min(100, q.optInt("pct", 0))), false);
        views.setTextViewText(QUEST_HOURS[i], StatsWidgetFit.formatHours(q.optLong("weekSeconds", 0), q.optDouble("targetHours", 0), met));
        views.setTextColor(QUEST_HOURS[i], ctx.getColor(met ? WidgetLook.success(look) : WidgetLook.text(look)));
    }

    private static void showMore(Context ctx, RemoteViews views, int id, int more) {
        views.setViewVisibility(id, more > 0 ? View.VISIBLE : View.GONE);
        if (more > 0) views.setTextViewText(id, ctx.getString(R.string.stats_widget_more, more));
    }

    /** Opens Hunt (the whole widget). Immutable. */
    private static PendingIntent openHunt(Context ctx) {
        Intent launch = new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(ctx, OPEN_HUNT_REQUEST, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent midnightIntent(Context ctx) {
        Intent intent = new Intent(ctx, StatsWidgetProvider.class).setAction(ACTION_MIDNIGHT);
        return PendingIntent.getBroadcast(ctx, MIDNIGHT_REQUEST, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Inexact, non-waking alarm just after the next local midnight (replaces any earlier one). */
    private static void armMidnightAlarm(Context ctx) {
        AlarmManager alarms = ctx.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        ZoneId zone = ZoneId.systemDefault();
        ZonedDateTime next = LocalDate.now(zone).plusDays(1).atStartOfDay(zone).plusMinutes(MIDNIGHT_SLACK_MINUTES);
        alarms.set(AlarmManager.RTC, next.toInstant().toEpochMilli(), midnightIntent(ctx));
    }

    /** Reads the snapshot file and picks the stats entry for the current local date. Any thread. */
    static Stats readStats(Context ctx) {
        Stats stats = new Stats();
        String text;
        synchronized (HuntFiles.LOCK) {
            text = HuntFiles.readText(new File(ctx.getFilesDir(), HuntFiles.WIDGET_SNAPSHOT_FILE));
        }
        if (text.isEmpty()) return stats;
        try {
            JSONObject snap = new JSONObject(text);
            stats.look = snap.optString("look", "neon");
            stats.noData = snap.optBoolean("noData", false);
            String key = LocalDate.now().toString();
            JSONArray entries = snap.optJSONArray("stats");
            stats.stale = true;
            for (int i = 0; entries != null && i < entries.length(); i++) {
                JSONObject entry = entries.optJSONObject(i);
                if (entry == null || !key.equals(entry.optString("dateKey"))) continue;
                stats.focusSeconds = entry.optLong("focusSeconds", 0);
                JSONArray quests = entry.optJSONArray("quests");
                JSONArray streaks = entry.optJSONArray("streaks");
                stats.quests = quests == null ? new JSONArray() : quests;
                stats.streaks = streaks == null ? new JSONArray() : streaks;
                stats.stale = false;
                break;
            }
        } catch (JSONException e) {
            Log.w(TAG, "Unreadable widget snapshot; showing the get-started state until the next save", e);
            stats.noData = true;
        }
        return stats;
    }
}
