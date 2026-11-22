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
    WidgetLook look = WidgetLook.NEON;
    /** No snapshot yet, or the user has nothing in Hunt: "Open Hunt to get started". */
    boolean noData = true;
    /** The snapshot is from an earlier day than today: "Open Hunt to refresh". */
    boolean stale;
    /**
     * The day's rows, ready to draw (id, title, accent, tickable, focus, habit), without Tasks
     * waiting in the Pending Tick queue or whose Undo window ended but are not queued yet.
     */
    JSONArray rows = new JSONArray();
    /** Rows in their Undo window, drawn as "✓ Done · Undo". */
    Set<String> undoable = Collections.emptySet();
    /** Days after today that are shown (0 = today), within [0, lastOffset]. */
    int offset;
    /** The furthest day the next arrow can reach: today + 6, or less if the snapshot ends sooner. */
    int lastOffset;
    /** The selected local date. */
    LocalDate date = LocalDate.now();

    /** True when there is a list to draw (not the get-started or refresh message). */
    boolean hasList() {
        return !noData && !stale;
    }

    /**
     * Reads the snapshot and picks what to show `offset` days after the current local date,
     * clamped to what the snapshot covers. Stale when the snapshot has no entry for today.
     * Any thread.
     */
    static SelectedDay read(Context ctx, int offset) {
        SelectedDay day = new SelectedDay();
        WidgetSupport.Snapshot snap = WidgetSupport.readSnapshot(ctx);
        day.look = snap.look;
        day.noData = snap.noData;
        if (snap.json == null) return day;
        String todayKey = WidgetSupport.localDateKey();
        JSONArray days = snap.json.optJSONArray("days");
        int first = -1;
        for (int i = 0; days != null && i < days.length(); i++) {
            JSONObject d = days.optJSONObject(i);
            if (d != null && todayKey.equals(d.optString("dateKey"))) {
                first = i;
                break;
            }
        }
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
        Set<String> hidden = UndoWindow.hiddenTaskIds(PendingTicks.queuedTaskIds(ctx.getFilesDir()), held, dateKey, now);
        day.undoable = UndoWindow.openTaskIds(held, dateKey, now);
        JSONArray rows = entry.optJSONArray(DaySelection.viewFor(dateKey, todayKey));
        for (int i = 0; rows != null && i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && !hidden.contains(row.optString("id"))) day.rows.put(row);
        }
        return day;
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
