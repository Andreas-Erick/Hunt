package com.hunt.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.RemoteViews;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * What the Day and Stats Widgets share: reading the Widget Snapshot (ADR-0006), the "Open Hunt"
 * message both draw without usable data, opening Hunt, and the redraw triggers (the midnight
 * alarm and clock changes). Holds no Hunt rule.
 */
final class WidgetSupport {
    private static final String TAG = "HuntWidget";
    /** Minutes after local midnight the redraw is aimed at (clear of clock skew around 00:00). */
    private static final int MIDNIGHT_SLACK_MINUTES = 1;

    private WidgetSupport() {
    }

    /** The snapshot file as both widgets start from it. */
    static final class Snapshot {
        WidgetLook look = WidgetLook.NEON;
        /** No snapshot yet, an unreadable one, or the user has nothing in Hunt: "Open Hunt to get started". */
        boolean noData = true;
        /** The parsed snapshot; null when noData came from a missing or unreadable file. */
        JSONObject json;
    }

    /** Reads and parses the snapshot file. Any thread. */
    static Snapshot readSnapshot(Context ctx) {
        Snapshot snap = new Snapshot();
        String text;
        synchronized (HuntFiles.LOCK) {
            text = HuntFiles.readText(new File(ctx.getFilesDir(), HuntFiles.WIDGET_SNAPSHOT_FILE));
        }
        if (text.isEmpty()) return snap;
        try {
            snap.json = new JSONObject(text);
            snap.look = WidgetLook.of(snap.json.optString("look", "neon"));
            snap.noData = snap.json.optBoolean("noData", false);
        } catch (JSONException e) {
            // Only the bridge writes this file and it rewrites it after every save, so drawing the
            // get-started message until then loses nothing.
            Log.w(TAG, "Unreadable widget snapshot; showing the get-started state until the next save", e);
            snap.json = null;
        }
        return snap;
    }

    /** The local date as the page keys it (YYYY-MM-DD). */
    static String localDateKey() {
        return LocalDate.now().toString();
    }

    /** The whole widget as one message that opens Hunt: "Open Hunt to get started" or "to refresh". */
    static RemoteViews messageViews(Context ctx, WidgetLook look, boolean noData, int openRequest) {
        RemoteViews views = new RemoteViews(ctx.getPackageName(), look.messageLayout);
        views.setTextViewText(R.id.widget_message,
                ctx.getString(noData ? R.string.day_widget_get_started : R.string.day_widget_refresh));
        views.setOnClickPendingIntent(R.id.widget_message_root, openHunt(ctx, openRequest));
        return views;
    }

    /** Opens Hunt as the launcher icon does. */
    static Intent launchIntent(Context ctx) {
        return new Intent(ctx, MainActivity.class)
                .setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    /** Immutable PendingIntent that opens Hunt; each widget passes its own request code. */
    static PendingIntent openHunt(Context ctx, int request) {
        return PendingIntent.getActivity(ctx, request, launchIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Placed widgets of `provider`; empty when none is placed. */
    static int[] placedIds(Context ctx, Class<?> provider) {
        int[] ids = AppWidgetManager.getInstance(ctx).getAppWidgetIds(new ComponentName(ctx, provider));
        return ids == null ? new int[0] : ids;
    }

    /** A broadcast after which the day may have changed: redraw and re-arm the midnight alarm. */
    static boolean isClockChange(String action, String midnightAction) {
        return midnightAction.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
    }

    /** Explicit, immutable broadcast to `provider` (never exported) with the midnight action. */
    private static PendingIntent midnightIntent(Context ctx, Class<?> provider, String action, int request) {
        Intent intent = new Intent(ctx, provider).setAction(action);
        return PendingIntent.getBroadcast(ctx, request, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Inexact, non-waking alarm just after the next local midnight (replaces any earlier one). No
     * exact-alarm permission: a late alarm only means a slightly late redraw.
     */
    static void armMidnightAlarm(Context ctx, Class<?> provider, String action, int request) {
        AlarmManager alarms = ctx.getSystemService(AlarmManager.class);
        if (alarms == null) return;
        ZoneId zone = ZoneId.systemDefault();
        ZonedDateTime next = LocalDate.now(zone).plusDays(1).atStartOfDay(zone).plusMinutes(MIDNIGHT_SLACK_MINUTES);
        alarms.set(AlarmManager.RTC, next.toInstant().toEpochMilli(), midnightIntent(ctx, provider, action, request));
    }

    static void cancelMidnightAlarm(Context ctx, Class<?> provider, String action, int request) {
        AlarmManager alarms = ctx.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(midnightIntent(ctx, provider, action, request));
    }
}
