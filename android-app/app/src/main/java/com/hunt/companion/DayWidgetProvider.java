package com.hunt.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
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
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.Set;

/**
 * Day Widget (GLOSSARY.md): draws one day's open Tasks from the Widget Snapshot the phone page
 * hands to the shell after every save (ADR-0006), and lets the user tick a Task done. A tick is
 * only appended to the Pending Tick queue ({@link PendingTicks}) and the Task hidden; Hunt applies
 * it through HuntCore on its next start. It never writes the state file or the snapshot and holds
 * no Hunt rule; which Tasks show, their order and whether they can be ticked all come from
 * HuntCore's buildWidgetSnapshot. Its only own state is each widget's selected day (prev and next arrows,
 * today to today + 6), kept in private preferences and valid only on the local date it was
 * chosen, so the widget is back on today after midnight.
 *
 * The class name is part of every placed widget: never rename it, or users lose their widgets
 * on update.
 *
 * Redraws: when the snapshot changes ({@link #refreshAll}), on every APPWIDGET_UPDATE (placing,
 * reboot, APK update), on time or time-zone changes, on an arrow tap, and just after local
 * midnight through an inexact alarm (no exact-alarm permission; a late alarm only means a
 * slightly late redraw).
 *
 * Undo (#9): a tick first opens a 4-second Undo window ({@link DayWidgetUndo}); the row draws as
 * "✓ Done · Undo" and the Pending Tick is appended only when the window ends. Every redraw first
 * appends what is due.
 *
 * Row taps reach {@link #onRowTap} through {@link DayWidgetTapActivity}, a no-UI trampoline: the
 * list's template is an activity PendingIntent, so opening Hunt is a launch the user started from
 * the launcher. A broadcast receiver starting an activity is a background activity launch
 * (blocked from Android 10 unless an exemption applies; from Android 14 a launcher no longer
 * lends its exemption to a PendingIntent it sends unless it opts in), so this class never calls
 * startActivity.
 */
public class DayWidgetProvider extends AppWidgetProvider {
    private static final String TAG = "HuntDayWidget";
    /** Explicit broadcast from the midnight alarm (never exported). */
    static final String ACTION_MIDNIGHT = "com.hunt.companion.action.DAY_WIDGET_MIDNIGHT";
    /** Explicit broadcast from the prev and next arrows (never exported); carries the widget id and target day. */
    static final String ACTION_NAV = "com.hunt.companion.action.DAY_WIDGET_NAV";
    private static final String EXTRA_DAY_OFFSET = "com.hunt.companion.extra.DAY_OFFSET";
    /** Explicit broadcast from the Undo backstop alarm (never exported): a window has ended. */
    static final String ACTION_UNDO_DUE = "com.hunt.companion.action.DAY_WIDGET_UNDO_DUE";
    /** Fill-in extras of a row tap: {@link #ROW_TICK}, {@link #ROW_UNDO} or {@link #ROW_OPEN}, plus the Task and day. */
    static final String EXTRA_ROW_ACTION = "rowAction";
    static final String EXTRA_TASK_ID = "taskId";
    static final String EXTRA_DATE_KEY = "dateKey";
    static final String ROW_TICK = "tick";
    static final String ROW_UNDO = "undo";
    static final String ROW_OPEN = "open";
    /** The next arrow stops at today + 6 (the snapshot's eighth day only covers the midnight rollover). */
    static final int MAX_DAY_OFFSET = 6;
    /** Private preferences holding each widget's selected day: "on_<id>" date key, "offset_<id>". */
    private static final String NAV_PREFS = "day_widget_nav";
    /** "Tue 24": the day label beyond Tomorrow (English, like every other widget string). */
    static final DateTimeFormatter SHORT_DAY = DateTimeFormatter.ofPattern("EEE d", Locale.ENGLISH);
    /** Minutes after local midnight the redraw is aimed at (clear of clock skew around 00:00). */
    private static final int MIDNIGHT_SLACK_MINUTES = 1;

    /** What the widget can show for its selected day. */
    static final class Today {
        /** "neon" or "dawn" (WidgetLook draws anything else as Neon). */
        String look = "neon";
        /** No snapshot yet, or the user has nothing in Hunt: "Open Hunt to get started". */
        boolean noData = true;
        /** The snapshot is from an earlier day than today: "Open Hunt to refresh". */
        boolean stale;
        /** The selected day's rows, ready to draw (id, title, accent, tickable, focus, habit), queued ticks left out. */
        JSONArray rows = new JSONArray();
        /** Days after today that are shown (0 = today), within [0, lastOffset]. */
        int offset;
        /** The furthest day the next arrow can reach: today + 6, or less if the snapshot ends sooner. */
        int lastOffset;
        /** The selected local date. */
        LocalDate date = LocalDate.now();
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        DayWidgetUndo.commitDue(ctx);
        drawAll(ctx, mgr, ids);
        armMidnightAlarm(ctx);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent == null ? null : intent.getAction();
        if (ACTION_UNDO_DUE.equals(action)) {
            refreshAll(ctx); // appends the ticks whose window ended
        } else if (ACTION_MIDNIGHT.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            refreshAll(ctx);
            armMidnightAlarm(ctx);
        } else if (ACTION_NAV.equals(action)) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return;
            String todayKey = localDateKey();
            int offset = selectedOffset(todayKey, intent.getIntExtra(EXTRA_DAY_OFFSET, 0), todayKey);
            navPrefs(ctx).edit()
                    .putString("on_" + id, todayKey)
                    .putInt("offset_" + id, offset)
                    .apply();
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            mgr.updateAppWidget(id, draw(ctx, id, readDay(ctx, offset)));
            mgr.notifyAppWidgetViewDataChanged(id, R.id.widget_list);
        }
    }

    /**
     * A row was tapped (forwarded by {@link DayWidgetTapActivity}): tick the Task, undo a tick, or
     * ask to open Hunt. Returns true when the caller should open Hunt; this class never starts an
     * activity itself.
     */
    static boolean onRowTap(Context ctx, Intent intent) {
        if (intent == null) return false;
        String action = intent.getStringExtra(EXTRA_ROW_ACTION);
        String taskId = intent.getStringExtra(EXTRA_TASK_ID);
        String dateKey = intent.getStringExtra(EXTRA_DATE_KEY);
        if (ROW_TICK.equals(action)) {
            tick(ctx, taskId, dateKey, System.currentTimeMillis());
            return false;
        }
        if (ROW_UNDO.equals(action)) {
            if (taskId != null && dateKey != null) DayWidgetUndo.undo(ctx, taskId, dateKey);
            refreshAll(ctx); // the row is back as it was
            return false;
        }
        return ROW_OPEN.equals(action);
    }

    /**
     * Ticks a Task done at {@code tickedAt}: opens its Undo window and redraws, which shows the row
     * as "✓ Done · Undo"; the Pending Tick is appended when the window ends, still with
     * {@code tickedAt}. Only a row the snapshot marks tickable on that day can be ticked (never the
     * Focus Task). The single entry point for a tick.
     */
    static void tick(Context ctx, String taskId, String dateKey, long tickedAt) {
        if (taskId != null && dateKey != null && isTickable(ctx, taskId, dateKey)) {
            DayWidgetUndo.open(ctx, taskId, dateKey, tickedAt);
        }
        refreshAll(ctx); // draws the Undo row, or redraws a stale list the tap came from
    }

    private static boolean isTickable(Context ctx, String taskId, String dateKey) {
        long offset;
        try {
            offset = ChronoUnit.DAYS.between(LocalDate.parse(localDateKey()), LocalDate.parse(dateKey));
        } catch (RuntimeException e) {
            return false;
        }
        if (offset < 0 || offset > MAX_DAY_OFFSET) return false;
        Today day = readDay(ctx, (int) offset);
        if (day.noData || day.stale || !dateKey.equals(day.date.toString())) return false;
        for (int i = 0; i < day.rows.length(); i++) {
            JSONObject row = day.rows.optJSONObject(i);
            if (row != null && taskId.equals(row.optString("id"))) return row.optBoolean("tickable", false);
        }
        return false;
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        SharedPreferences.Editor edit = navPrefs(ctx).edit();
        for (int id : ids) edit.remove("on_" + id).remove("offset_" + id);
        edit.apply();
    }

    @Override
    public void onDisabled(Context ctx) {
        AlarmManager alarms = ctx.getSystemService(AlarmManager.class);
        if (alarms != null) alarms.cancel(midnightIntent(ctx));
        navPrefs(ctx).edit().clear().apply();
    }

    /** Redraws every placed Day Widget from the snapshot file. Any thread; no-op when none is placed. */
    static void refreshAll(Context ctx) {
        if (ctx == null) return;
        try {
            DayWidgetUndo.commitDue(ctx); // first, so a late timer never draws an ended window
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, DayWidgetProvider.class));
            if (ids == null || ids.length == 0) return;
            drawAll(ctx, mgr, ids);
        } catch (RuntimeException e) {
            Log.w(TAG, "Day Widget refresh failed", e);
        }
    }

    private static void drawAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, draw(ctx, id, readDay(ctx, savedOffset(ctx, id))));
        mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static RemoteViews draw(Context ctx, int widgetId, Today today) {
        if (today.noData || today.stale) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), WidgetLook.messageLayout(today.look));
            views.setTextViewText(R.id.widget_message,
                    ctx.getString(today.noData ? R.string.day_widget_get_started : R.string.day_widget_refresh));
            views.setOnClickPendingIntent(R.id.widget_message_root, openHunt(ctx));
            return views;
        }
        RemoteViews views = new RemoteViews(ctx.getPackageName(), WidgetLook.dayLayout(today.look));
        String label = today.offset == 0 ? ctx.getString(R.string.day_widget_today)
                : today.offset == 1 ? ctx.getString(R.string.day_widget_tomorrow)
                : shortDayLabel(today.date);
        views.setTextViewText(R.id.widget_header, label);
        views.setOnClickPendingIntent(R.id.widget_header, openHunt(ctx));
        views.setTextViewText(R.id.widget_empty, ctx.getString(R.string.day_widget_nothing_left, label));
        arrow(ctx, views, today.look, R.id.widget_prev, widgetId, today.offset - 1, today.offset > 0);
        arrow(ctx, views, today.look, R.id.widget_next, widgetId, today.offset + 1, today.offset < today.lastOffset);

        Intent service = new Intent(ctx, DayWidgetService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
        // A distinct data URI per widget, so each gets its own list factory.
        service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_list, service);
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);
        views.setPendingIntentTemplate(R.id.widget_list, rowTemplate(ctx));
        return views;
    }

    /**
     * The previous or next arrow. At an end it stays in place, so the label never shifts, but it is
     * dimmed, disabled and has no intent.
     */
    private static void arrow(Context ctx, RemoteViews views, String look, int viewId, int widgetId, int target,
            boolean enabled) {
        views.setBoolean(viewId, "setEnabled", enabled);
        views.setTextColor(viewId, ctx.getColor(enabled ? WidgetLook.text(look) : WidgetLook.dim(look)));
        if (enabled) views.setOnClickPendingIntent(viewId, navIntent(ctx, widgetId, target));
    }

    /** Explicit, immutable broadcast to this provider that selects day `offset` on widget `widgetId`. */
    private static PendingIntent navIntent(Context ctx, int widgetId, int offset) {
        Intent intent = new Intent(ctx, DayWidgetProvider.class)
                .setAction(ACTION_NAV)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra(EXTRA_DAY_OFFSET, offset)
                // A distinct URI per widget and target, so each arrow keeps its own PendingIntent.
                .setData(Uri.parse("hunt-widget://day/" + widgetId + "/" + offset));
        return PendingIntent.getBroadcast(ctx, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static SharedPreferences navPrefs(Context ctx) {
        return ctx.getSharedPreferences(NAV_PREFS, Context.MODE_PRIVATE);
    }

    /** The day offset widget `widgetId` shows now: its choice if made today, otherwise today. */
    static int savedOffset(Context ctx, int widgetId) {
        SharedPreferences prefs = navPrefs(ctx);
        return selectedOffset(prefs.getString("on_" + widgetId, null),
                prefs.getInt("offset_" + widgetId, 0), localDateKey());
    }

    /**
     * Pure: the selected day offset, clamped to [0, MAX_DAY_OFFSET]. A choice saved on another
     * local date than `todayKey` has expired, so the widget is back on today after midnight.
     */
    static int selectedOffset(String savedOn, int savedOffset, String todayKey) {
        if (savedOn == null || !savedOn.equals(todayKey)) return 0;
        return Math.max(0, Math.min(savedOffset, MAX_DAY_OFFSET));
    }

    /** Pure: the snapshot list to draw for `dateKey`; its today view only on the current date. */
    static String viewFor(String dateKey, String todayKey) {
        return dateKey.equals(todayKey) ? "today" : "future";
    }

    /** Pure: "Tue 24". */
    static String shortDayLabel(LocalDate day) {
        return SHORT_DAY.format(day);
    }

    /** Opens Hunt (header, message body). Immutable. */
    private static PendingIntent openHunt(Context ctx) {
        return PendingIntent.getActivity(ctx, 0, launchIntent(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Template for row taps: an explicit activity intent to the no-UI trampoline
     * {@link DayWidgetTapActivity}, which forwards to {@link #onRowTap} and opens Hunt when asked.
     * An activity PendingIntent the launcher sends on a widget tap is a user-started launch on
     * every API level; a receiver starting Hunt would be a background activity launch. Each row's
     * fill-in adds what was tapped (tick, undo or open, Task, day), so it must be mutable, and from
     * targetSdk 34 a mutable PendingIntent must wrap an explicit intent (it does).
     */
    private static PendingIntent rowTemplate(Context ctx) {
        int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
        Intent intent = new Intent(ctx, DayWidgetTapActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_NO_ANIMATION
                        | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        return PendingIntent.getActivity(ctx, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable);
    }

    /** Opens Hunt as the launcher icon does (header and message targets, the trampoline). */
    static Intent launchIntent(Context ctx) {
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

    /**
     * Reads the snapshot file and picks what to show `offset` days after the current local date,
     * clamped to what the snapshot covers, leaving out Tasks waiting in the Pending Tick queue (in
     * both the today and the future view). Stale when the snapshot has no entry for today.
     * Any thread.
     */
    static Today readDay(Context ctx, int offset) {
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
            int first = -1;
            for (int i = 0; days != null && i < days.length(); i++) {
                JSONObject day = days.optJSONObject(i);
                if (day != null && key.equals(day.optString("dateKey"))) {
                    first = i;
                    break;
                }
            }
            today.stale = first < 0;
            if (today.stale) return today;
            today.lastOffset = Math.min(MAX_DAY_OFFSET, days.length() - 1 - first);
            today.offset = Math.max(0, Math.min(offset, today.lastOffset));
            today.date = LocalDate.parse(key).plusDays(today.offset);
            String dateKey = today.date.toString();
            JSONObject day = days.optJSONObject(first + today.offset);
            // Days are consecutive; a gap or a mismatch just draws an empty day.
            if (day == null || !dateKey.equals(day.optString("dateKey"))) return today;
            today.rows = withoutQueued(day.optJSONArray(viewFor(dateKey, key)),
                    PendingTicks.queuedTaskIds(ctx.getFilesDir()));
        } catch (JSONException e) {
            Log.w(TAG, "Unreadable widget snapshot; showing the get-started state until the next save", e);
            today.noData = true;
        }
        return today;
    }

    /** The rows whose Task is not waiting in the Pending Tick queue. */
    private static JSONArray withoutQueued(JSONArray rows, Set<String> queued) {
        JSONArray kept = new JSONArray();
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && !queued.contains(row.optString("id"))) kept.put(row);
        }
        return kept;
    }
}
