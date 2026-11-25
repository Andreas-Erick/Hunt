package com.hunt.companion;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.LocalDate;
import java.util.Collections;
import java.util.Map;
import java.util.Set;

/**
 * What a Day Widget can show for its selected day, read from the Widget Snapshot (ADR-0006).
 * The rows, their order and whether each can be ticked come from HuntCore's buildWidgetSnapshot;
 * the only thing decided here is which rows to leave out while a tick is on its way: the one
 * place that hides rows ({@link UndoWindow#hiddenTaskIds}).
 */
final class SelectedDay {
    /** The snapshot file: look, and noData ("Open Hunt to get started"). */
    WidgetSupport.Snapshot snapshot = new WidgetSupport.Snapshot();
    /** The snapshot is from an earlier day than today: "Open Hunt to refresh". */
    boolean stale;
    /**
     * The day's rows, ready to draw (id, title, accent, tickable, focus, habit, habitKind,
     * progress), without Tasks
     * waiting in the Pending Tick queue or whose Undo window ended but are not queued yet.
     */
    JSONArray rows = new JSONArray();
    /** Rows in their Undo window, drawn as "✓ Done · Undo" (a Count row: "+1 · Undo"). */
    Set<String> undoable = Collections.emptySet();
    /** Count rows -> +1s on their way that the snapshot's progress does not include yet. */
    Map<String, Integer> pendingPlus = Collections.emptyMap();
    /** Count rows with a +1 window not queued yet: they offer no tick until it is. */
    Set<String> heldPlus = Collections.emptySet();
    /**
     * The Pending Tick queue could not be read, so which Tasks are already queued is unknown: no
     * row offers a tick until a read succeeds (ADR-0006).
     */
    boolean ticksPaused;
    /** Days after today that are shown (0 = today), within [0, lastOffset]. */
    int offset;
    /** The furthest day the next arrow can reach: today + 6, or less if the snapshot ends sooner. */
    int lastOffset;
    /** The selected local date. */
    LocalDate date = LocalDate.now();

    /** True when there is a list to draw (not the get-started or refresh message). */
    boolean hasList() {
        return !snapshot.noData && !stale;
    }

    /**
     * Reads the snapshot and picks what to show `offset` days after the current local date,
     * clamped to what the snapshot covers. Stale when the snapshot has no entry for today.
     * Any thread.
     */
    static SelectedDay read(Context ctx, int offset) {
        SelectedDay day = new SelectedDay();
        day.snapshot = WidgetSupport.readSnapshot(ctx);
        String todayKey = WidgetSupport.localDateKey();
        JSONArray days = day.snapshot.entries(WidgetSupport.Snapshot.DAYS);
        int first = WidgetSupport.Snapshot.indexOf(days, todayKey);
        day.stale = first < 0;
        if (day.stale) return day;
        day.lastOffset = Math.min(DaySelection.MAX_DAY_OFFSET, days.length() - 1 - first);
        day.offset = Math.max(0, Math.min(offset, day.lastOffset));
        day.date = LocalDate.parse(todayKey).plusDays(day.offset);
        String dateKey = day.date.toString();
        JSONObject entry = days.optJSONObject(first + day.offset);
        // Days are consecutive; a gap or a mismatch just draws an empty day.
        if (entry == null || !dateKey.equals(entry.optString("dateKey"))) return day;

        long now = System.currentTimeMillis();
        Map<String, ?> held = DayWidgetUndo.held(ctx);
        PendingTicks.Listing queued = PendingTicks.queued(ctx.getFilesDir());
        day.ticksPaused = !queued.readable;
        Set<String> hidden = UndoWindow.hiddenTaskIds(queued.keys, held, dateKey, now);
        day.undoable = UndoWindow.openTaskIds(held, dateKey, now);
        day.pendingPlus = UndoWindow.pendingPlus(queued.plusCounts, held, dateKey, now);
        day.heldPlus = UndoWindow.heldPlusTaskIds(held, dateKey);
        JSONArray rows = entry.optJSONArray(DaySelection.viewFor(dateKey, todayKey).key);
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && !hidden.contains(row.optString("id"))) day.rows.put(row);
        }
        return day;
    }

    /** Rows still open: the listed rows minus those drawn as "✓ Done · Undo". */
    int openCount() {
        int open = 0;
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && !undoable.contains(row.optString("id"))) open++;
        }
        return open;
    }

    /**
     * Whether `row` offers a tick now: the snapshot marks it tickable and the queue is readable,
     * and a Count row has no +1 still waiting for the queue.
     */
    boolean canTick(JSONObject row) {
        if (row == null || ticksPaused || !row.optBoolean("tickable", false)) return false;
        return !(isCountRow(row) && heldPlus.contains(row.optString("id")));
    }

    /** A Count Habit row (snapshot habitKind "count"): its tick is a +1. */
    static boolean isCountRow(JSONObject row) {
        return row != null && "count".equals(row.optString("habitKind"));
    }

    /**
     * A Count row's progress as the snapshot drew it ("2 / 3 miles"), with the +1s on their way
     * after it ("2 / 3 miles +1"); "" for any other row. Java adds no Hunt rule: the count of
     * waiting +1s is shown as it is, and Hunt folds them into the total when it applies them.
     */
    String progressOf(JSONObject row) {
        if (!isCountRow(row)) return "";
        String progress = row.optString("progress", "");
        Integer waiting = pendingPlus.get(row.optString("id"));
        return waiting == null || waiting <= 0 ? progress : progress + " +" + waiting;
    }

    /** The row for `taskId`, or null when it is not listed. */
    JSONObject row(String taskId) {
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && taskId.equals(row.optString("id"))) return row;
        }
        return null;
    }
}
