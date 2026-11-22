package com.hunt.companion;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Day Widget's Undo windows (#9): where they are kept and when they end. A tick opens a
 * window ({@link #open}) and the row draws as "✓ Done · Undo"; Undo ({@link #undo}) removes the
 * window and leaves no trace; when the window ends ({@link #commitDue}) the tick is appended to
 * the Pending Tick queue with its original tap time. The rule itself is {@link UndoWindow}.
 *
 * Surviving the process: each window is written synchronously to private preferences before
 * the tap returns, so a killed process loses no tick. The window's end is then noticed by the
 * first of: a main-thread timer (the usual case, on time), an inexact non-waking alarm to the
 * provider (no exact-alarm permission; it may come minutes late), any later widget redraw, and
 * the page's queue read (MainActivity), all of which call {@link #commitDue} first. A late
 * notice only delays the queue; the tap time is kept.
 */
final class DayWidgetUndo {
    private static final String TAG = "HuntDayWidgetUndo";
    /** Private preferences: "dateKey|taskId" -> tap time (epoch ms) for every window not yet queued. */
    static final String UNDO_PREFS = "day_widget_undo";
    /** Run the timer this long after the window ends (clear of rounding at the boundary). */
    private static final long SLACK_MS = 100;
    /** Guards every read-modify-write of the windows (taps on the main thread, the bridge on its own). */
    private static final Object LOCK = new Object();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** Token of the one pending timer, so rescheduling replaces it instead of piling up. */
    private static final Object TIMER = new Object();

    private DayWidgetUndo() {
    }

    /**
     * Opens a window for a tick tapped at {@code tickedAt}. A second tap on a Task already in its
     * window changes nothing. Returns false if nothing was opened.
     */
    static boolean open(Context ctx, String taskId, String dateKey, long tickedAt) {
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(ctx);
            String key = UndoWindow.key(taskId, dateKey);
            if (prefs.contains(key)) return false;
            if (!prefs.edit().putLong(key, tickedAt).commit()) {
                Log.w(TAG, "Opening an Undo window failed; tick dropped");
                return false;
            }
        }
        schedule(ctx);
        return true;
    }

    /** Undo: closes the window without queueing anything, as if the tick never happened. */
    static void undo(Context ctx, String taskId, String dateKey) {
        synchronized (LOCK) {
            prefs(ctx).edit().remove(UndoWindow.key(taskId, dateKey)).commit();
        }
        schedule(ctx);
    }

    /**
     * Appends every tick whose window has ended to the Pending Tick queue (tap order, original tap
     * time) and closes those windows. Returns true if any was appended. Any thread.
     */
    static boolean commitDue(Context ctx) {
        if (ctx == null) return false;
        File dir = ctx.getFilesDir();
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(ctx);
            Map<String, ?> held = prefs.getAll();
            List<String> due = UndoWindow.due(held, now);
            if (due.isEmpty()) return false;
            SharedPreferences.Editor edit = prefs.edit();
            for (String key : due) {
                Object value = held.get(key);
                long tickedAt = value instanceof Long ? (Long) value : now;
                // Appended before the window is removed: a crash in between appends it again,
                // which the queue ignores (one entry per Task and day).
                if (!PendingTicks.append(dir, UndoWindow.taskIdOf(key), UndoWindow.dateKeyOf(key), tickedAt)) {
                    Log.w(TAG, "Queueing a tick after its Undo window failed; tick dropped");
                }
                edit.remove(key);
            }
            edit.commit();
        }
        schedule(ctx);
        return true;
    }

    /** Every window not yet queued ("dateKey|taskId" -> tap time). Any thread. */
    static Map<String, ?> held(Context ctx) {
        synchronized (LOCK) {
            Map<String, ?> all = prefs(ctx).getAll();
            return all == null ? Collections.<String, Object>emptyMap() : all;
        }
    }

    /** Tasks of `dateKey` still in their window at `now`. */
    static Set<String> openTaskIds(Context ctx, String dateKey, long now) {
        return UndoWindow.openTaskIds(held(ctx), dateKey, now);
    }

    /**
     * Arms the timer and the backstop alarm for the earliest window still open, or cancels both
     * when none is. The timer redraws the widgets, which commits what is due first.
     */
    private static void schedule(Context ctx) {
        final Context app = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
        long now = System.currentTimeMillis();
        long next = UndoWindow.nextDeadline(held(app), now);
        MAIN.removeCallbacksAndMessages(TIMER);
        AlarmManager alarms = app.getSystemService(AlarmManager.class);
        if (next < 0) {
            if (alarms != null) alarms.cancel(dueIntent(app));
            return;
        }
        long delay = Math.max(0, next - now) + SLACK_MS;
        MAIN.postAtTime(() -> DayWidgetProvider.refreshAll(app), TIMER, SystemClock.uptimeMillis() + delay);
        if (alarms != null) alarms.set(AlarmManager.RTC, next + SLACK_MS, dueIntent(app));
    }

    /** Explicit, immutable broadcast to the non-exported provider: an Undo window has ended. */
    private static PendingIntent dueIntent(Context ctx) {
        Intent intent = new Intent(ctx, DayWidgetProvider.class).setAction(DayWidgetProvider.ACTION_UNDO_DUE);
        return PendingIntent.getBroadcast(ctx, 2, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(UNDO_PREFS, Context.MODE_PRIVATE);
    }
}
