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
    /** Private preferences: {@link TickKeys#taskDay} -> tap time (epoch ms) for every window not yet queued. */
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
            String key = TickKeys.taskDay(taskId, dateKey);
            if (prefs.contains(key)) return false;
            if (!prefs.edit().putLong(key, tickedAt).commit()) {
                Log.w(TAG, "Opening an Undo window failed; the row stays open to tick again");
                return false;
            }
        }
        schedule(ctx);
        return true;
    }

    /** Undo: closes the window without queueing anything, as if the tick never happened. */
    static void undo(Context ctx, String taskId, String dateKey) {
        synchronized (LOCK) {
            prefs(ctx).edit().remove(TickKeys.taskDay(taskId, dateKey)).commit();
        }
        schedule(ctx);
    }

    /**
     * Appends every tick whose window has ended to the Pending Tick queue (tap order, original tap
     * time) and closes those windows. A tick the queue refuses (full, unreadable, a failed write)
     * keeps its window and is retried on the next call, so it is never dropped; the result counts
     * it as held back. Any thread.
     */
    static UndoWindow.Commit commitDue(Context ctx) {
        if (ctx == null) return new UndoWindow.Commit();
        final File dir = ctx.getFilesDir();
        UndoWindow.Commit result;
        synchronized (LOCK) {
            SharedPreferences prefs = prefs(ctx);
            // Appended before the window is removed: a crash in between appends it again, which
            // the queue ignores (one entry per Task and day).
            result = UndoWindow.commit(prefs.getAll(), System.currentTimeMillis(),
                    (taskId, dateKey, tickedAt) -> PendingTicks.append(dir, taskId, dateKey, tickedAt).closesWindow());
            if (result.heldBack > 0) {
                Log.w(TAG, result.heldBack + " ended Undo window(s) could not be queued yet; kept for the next try");
            }
            if (result.closed.isEmpty()) return result;
            SharedPreferences.Editor edit = prefs.edit();
            for (String key : result.closed) edit.remove(key);
            if (!edit.commit()) Log.w(TAG, "Closing queued Undo windows failed; the queue ignores the repeat");
        }
        schedule(ctx);
        return result;
    }

    /** Every window not yet queued ({@link TickKeys#taskDay} -> tap time). Any thread. */
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
