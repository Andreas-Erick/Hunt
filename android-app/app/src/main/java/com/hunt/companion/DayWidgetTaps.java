package com.hunt.companion;

import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/**
 * What a Day Widget row tap does (forwarded by {@link DayWidgetTapActivity}): tick a Task, undo a
 * tick, or ask to open Hunt. A tick opens an Undo window ({@link DayWidgetUndo}); the Pending Tick
 * is appended only when the window ends (ADR-0006). Only a row the snapshot marks tickable on
 * that day can be ticked (never the Focus Task), and none while the queue is unreadable
 * ({@link SelectedDay#canTick}). This class never starts an activity: the trampoline does.
 */
final class DayWidgetTaps {
    /** Fill-in extras of a row tap: {@link #ROW_TICK}, {@link #ROW_UNDO} or {@link #ROW_OPEN}, plus the Task and day. */
    static final String EXTRA_ROW_ACTION = "rowAction";
    static final String EXTRA_TASK_ID = "taskId";
    static final String EXTRA_DATE_KEY = "dateKey";
    static final String ROW_TICK = "tick";
    static final String ROW_UNDO = "undo";
    static final String ROW_OPEN = "open";

    /** What the trampoline does after a tap. */
    enum Result {
        /** Handled; nothing more to do. */
        DONE,
        /** Open Hunt. */
        OPEN_HUNT,
        /** Opening the Undo window could not be saved: the row stays open to tick again. Tell the user. */
        TICK_FAILED,
        /** Undo could not be saved: the tick may still reach Hunt. Tell the user. */
        UNDO_FAILED
    }

    private DayWidgetTaps() {
    }

    /** Handles one row tap. Every outcome redraws the widgets, so a stale list the tap came from is fixed. */
    static Result onRowTap(Context ctx, Intent intent) {
        if (intent == null) return Result.DONE;
        String action = intent.getStringExtra(EXTRA_ROW_ACTION);
        String taskId = intent.getStringExtra(EXTRA_TASK_ID);
        String dateKey = intent.getStringExtra(EXTRA_DATE_KEY);
        if (ROW_TICK.equals(action)) return tick(ctx, taskId, dateKey, System.currentTimeMillis());
        if (ROW_UNDO.equals(action)) {
            boolean undone = taskId == null || dateKey == null || DayWidgetUndo.undo(ctx, taskId, dateKey);
            DayWidgetProvider.refreshAll(ctx); // the row is back as it was
            return undone ? Result.DONE : Result.UNDO_FAILED;
        }
        return ROW_OPEN.equals(action) ? Result.OPEN_HUNT : Result.DONE;
    }

    /**
     * Ticks a Task done at {@code tickedAt}: opens its Undo window and redraws, which shows the row
     * as "✓ Done · Undo"; the Pending Tick is appended when the window ends, still with
     * {@code tickedAt}. The single entry point for a tick.
     */
    private static Result tick(Context ctx, String taskId, String dateKey, long tickedAt) {
        boolean opened = true;
        JSONObject row = taskId != null && dateKey != null ? tickableRow(ctx, taskId, dateKey) : null;
        if (row != null) {
            // The snapshot's Habit Kind decides what the tap means: one more on a Count row, a Slip on
            // an Avoid row, done otherwise.
            String kind = SelectedDay.tickKindOf(row);
            opened = DayWidgetUndo.open(ctx, taskId, dateKey, tickedAt, kind);
        }
        DayWidgetProvider.refreshAll(ctx); // draws the Undo row, or redraws a stale list the tap came from
        return opened ? Result.DONE : Result.TICK_FAILED;
    }

    /** The snapshot row `taskId` on `dateKey` when it offers a tick now, else null. */
    private static JSONObject tickableRow(Context ctx, String taskId, String dateKey) {
        long offset;
        try {
            offset = ChronoUnit.DAYS.between(LocalDate.parse(WidgetSupport.localDateKey()), LocalDate.parse(dateKey));
        } catch (RuntimeException e) {
            return null; // a malformed day from a stale list: nothing to tick
        }
        if (offset < 0 || offset > DaySelection.MAX_DAY_OFFSET) return null;
        SelectedDay day = SelectedDay.read(ctx, (int) offset);
        if (!day.hasList() || !dateKey.equals(day.date.toString())) return null;
        JSONObject row = day.row(taskId);
        return day.canTick(row) ? row : null;
    }
}
