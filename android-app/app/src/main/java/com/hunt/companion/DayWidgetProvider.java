package com.hunt.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * Day Widget (GLOSSARY.md): draws today's open Tasks from the Widget Snapshot the phone page
 * hands to the shell after every save (ADR-0006). It only reads: it never writes the state file
 * or any other file, and holds no Hunt rule; which Tasks show, their order and the Focus flag all
 * come from HuntCore's buildWidgetSnapshot.
 *
 * The class name is part of every placed widget: never rename it, or users lose their widgets
 * on update.
 *
 * Redraws: when the snapshot changes ({@link #refreshAll}), on every APPWIDGET_UPDATE (placing,
 * reboot, APK update), on time or time-zone changes, and just after local midnight through an
 * inexact alarm (no exact-alarm permission; a late alarm only means a slightly late redraw).
 */
public class DayWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "HuntDayWidget";
    /** Explicit broadcast from the midnight alarm (never exported). */
    static final String ACTION_MIDNIGHT = "com.hunt.companion.action.DAY_WIDGET_MIDNIGHT";
    /** Minutes after local midnight the redraw is aimed at (clear of clock skew around 00:00). */
    private static final int MIDNIGHT_SLACK_MINUTES = 1;

    /** What the widget can show for the current local date. */
    static final class Today {
        /** "neon" or "dawn" (only Neon has layouts so far; anything else draws Neon). */
        String look = "neon";
        /** No snapshot yet, or the user has nothing in Hunt: "Open Hunt to get started". */
        boolean noData = true;
        /** The snapshot is from an earlier day than today: "Open Hunt to refresh". */
        boolean stale;
        /** Today's rows, ready to draw (id, title, accent, tickable, focus, habit). */
        JSONArray rows = new JSONArray();
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        drawAll(ctx, mgr, ids);
        armMidnightAlarm(ctx);
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

    /** Redraws every placed Day Widget from the snapshot file. Any thread; no-op when none is placed. */
    static void refreshAll(Context ctx) {
        if (ctx == null) return;
        try {
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, DayWidgetProvider.class));
            if (ids == null || ids.length == 0) return;
            drawAll(ctx, mgr, ids);
        } catch (RuntimeException e) {
            Log.w(TAG, "Day Widget refresh failed", e);
        }
    }

    private static void drawAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        Today today = readToday(ctx);
        for (int id : ids) mgr.updateAppWidget(id, draw(ctx, id, today));
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static RemoteViews draw(Context ctx, int widgetId, Today today) {
        if (today.noData || today.stale) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_day_message_neon);
            views.setTextViewText(R.id.widget_message,
                    ctx.getString(today.noData ? R.string.day_widget_get_started : R.string.day_widget_refresh));
            views.setOnClickPendingIntent(R.id.widget_message_root, openHunt(ctx));
            return views;
        }
        RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_day_neon);
        String label = ctx.getString(R.string.day_widget_today);
        views.setTextViewText(R.id.widget_header, label);
        views.setOnClickPendingIntent(R.id.widget_header, openHunt(ctx));
        views.setTextViewText(R.id.widget_empty, ctx.getString(R.string.day_widget_nothing_left, label));

        Intent service = new Intent(ctx, DayWidgetService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        // A distinct data URI per widget, so each gets its own list factory.
        service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, service);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);
        views.setPendingIntentTemplate(R.id.widget_list, openHuntTemplate(ctx));
        return views;
    }

    /** Opens Hunt (header, message body). Immutable. */
    private static PendingIntent openHunt(Context ctx) {
        return PendingIntent.getActivity(ctx, 0, launchIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Template for row taps; rows add an empty fill-in, so it must be mutable, and from targetSdk
     * 34 a mutable PendingIntent must wrap an explicit intent (it does: MainActivity).
     */
    private static PendingIntent openHuntTemplate(Context ctx) {
        int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        return PendingIntent.getActivity(ctx, 1, launchIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT | mutable);
    }

    private static Intent launchIntent(Context ctx) {
        return new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    private static PendingIntent midnightIntent(Context ctx) {
        Intent intent = new Intent(ctx, DayWidgetProvider.class).setAction(ACTION_MIDNIGHT);
        return PendingIntent.getBroadcast(ctx, 0, intent,
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

    /** The local date as the page keys it (YYYY-MM-DD). */
    static String localDateKey() {
        return LocalDate.now().toString();
    }

    /** Reads the snapshot file and picks what to show for the current local date. Any thread. */
    static Today readToday(Context ctx) {
        Today today = new Today();
        String text;
        synchronized (HuntFiles.LOCK) {
            text = HuntFiles.readText(new File(ctx.getFilesDir(), HuntFiles.WIDGET_SNAPSHOT_FILE));
        }
        if (text.isEmpty()) return today;
        try {
            JSONObject snap = new JSONObject(text);
            today.look = snap.optString("look", "neon");
            today.noData = snap.optBoolean("noData", false);
            String key = localDateKey();
            JSONArray days = snap.optJSONArray("days");
            today.stale = true;
            for (int i = 0; days != null && i < days.length(); i++) {
                JSONObject day = days.optJSONObject(i);
                if (day != null && key.equals(day.optString("dateKey"))) {
                    JSONArray rows = day.optJSONArray("today");
                    today.rows = rows == null ? new JSONArray() : rows;
                    today.stale = false;
                    break;
                }
            }
        } catch (JSONException e) {
            Log.w(TAG, "Unreadable widget snapshot; showing the get-started state until the next save", e);
            today.noData = true;
        }
        return today;
    }
}
