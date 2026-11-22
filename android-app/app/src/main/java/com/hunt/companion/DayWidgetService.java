package com.hunt.companion;

import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Rows of the Day Widget's list for its selected day, as {@link SelectedDay} reads them from the
 * Widget Snapshot (ADR-0006). It only draws and never writes anything. Taps go through the list's
 * template to {@link DayWidgetTapActivity}: a tickable row's marker ticks it, the row itself opens
 * Hunt, and a row in its Undo window (#9) draws as "✓ Done · Undo" in a row of the same height,
 * whose only target is Undo. The class name is part of the manifest contract.
 */
public class DayWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext(),
                intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID));
    }

    private static final class Rows implements RemoteViewsFactory {
        /** Row layouts per look: the task row and the Undo row. */
        private static final int ROW_KINDS = 2;
        private final Context ctx;
        private final int widgetId;
        private JSONArray rows = new JSONArray();
        private String dateKey = "";
        /** The selected day as last read: rows in their Undo window, look, whether rows can be ticked. */
        private SelectedDay day = new SelectedDay();

        Rows(Context ctx, int widgetId) {
            this.ctx = ctx;
            this.widgetId = widgetId;
        }

        @Override
        public void onCreate() {
        }

        /** Binder thread: after notifyAppWidgetViewDataChanged, re-reads the snapshot and the day. */
        @Override
        public void onDataSetChanged() {
            day = SelectedDay.read(ctx, DayNav.savedOffset(ctx, widgetId));
            dateKey = day.date.toString();
            rows = day.hasList() ? day.rows : new JSONArray();
        }

        @Override
        public void onDestroy() {
            rows = new JSONArray();
        }

        @Override
        public int getCount() {
            return rows.length();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            JSONObject row = rows.optJSONObject(position);
            if (row != null && day.undoable.contains(row.optString("id", ""))) return undoRow(row);
            WidgetLook look = day.snapshot.look;
            RemoteViews views = new RemoteViews(ctx.getPackageName(), look.dayRowLayout);
            if (row == null) return views;
            String title = row.optString("title", "");
            boolean focus = row.optBoolean("focus", false);
            int accent = ctx.getColor(look.questAccent(row.optString("accent", "slate")));

            views.setTextViewText(R.id.widget_row_title, title);
            views.setInt(R.id.widget_row_bar, "setColorFilter", accent);
            views.setViewVisibility(R.id.widget_row_ring, focus ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_row_focus_mark, focus ? View.VISIBLE : View.GONE);
            // Rows are recycled: set both looks of the card and tag every time.
            views.setInt(R.id.widget_row, "setBackgroundResource", focus ? look.focusRowBackground : look.rowBackground);

            int tag = focus ? R.string.day_widget_focus_tag
                    : row.optBoolean("habit", false) ? R.string.day_widget_habit_tag : 0;
            views.setViewVisibility(R.id.widget_row_tag, tag == 0 ? View.GONE : View.VISIBLE);
            if (tag != 0) {
                views.setTextViewText(R.id.widget_row_tag, ctx.getString(tag));
                views.setTextColor(R.id.widget_row_tag, ctx.getColor(focus ? look.accent : look.muted));
                views.setInt(R.id.widget_row_tag, "setBackgroundResource", focus ? look.focusTagBackground : look.tagBackground);
            }

            views.setContentDescription(R.id.widget_row,
                    ctx.getString(focus ? R.string.day_widget_row_focus : R.string.day_widget_row_open, title));
            // The row opens Hunt; a tickable row's 48dp marker box ticks it. The snapshot never marks
            // the Focus Task tickable (HuntCore's rule), so it has no tick target.
            views.setOnClickFillInIntent(R.id.widget_row, rowTap(DayWidgetTaps.ROW_OPEN, row));
            if (day.canTick(row)) {
                views.setOnClickFillInIntent(R.id.widget_row_tick, rowTap(DayWidgetTaps.ROW_TICK, row));
                views.setContentDescription(R.id.widget_row_tick, ctx.getString(R.string.day_widget_row_tick, title));
            }
            return views;
        }

        /**
         * A row in its Undo window: the Done mark, "Done · <title>" and a 48dp Undo target at the far end. Only
         * Undo is a target here, so a stray tap beside it neither opens Hunt nor ticks again.
         */
        private RemoteViews undoRow(JSONObject row) {
            RemoteViews views = new RemoteViews(ctx.getPackageName(), day.snapshot.look.dayUndoRowLayout);
            String title = row.optString("title", "");
            views.setTextViewText(R.id.widget_row_done_title, ctx.getString(R.string.day_widget_done_title, title));
            views.setContentDescription(R.id.widget_row_undo, ctx.getString(R.string.day_widget_row_undo, title));
            views.setOnClickFillInIntent(R.id.widget_row_undo, rowTap(DayWidgetTaps.ROW_UNDO, row));
            return views;
        }

        private Intent rowTap(String action, JSONObject row) {
            return new Intent()
                    .putExtra(DayWidgetTaps.EXTRA_ROW_ACTION, action)
                    .putExtra(DayWidgetTaps.EXTRA_TASK_ID, row.optString("id", ""))
                    .putExtra(DayWidgetTaps.EXTRA_DATE_KEY, dateKey);
        }

        @Override
        public RemoteViews getLoadingView() {
            return null; // the launcher's default loading row
        }

        @Override
        public int getViewTypeCount() {
            // Two row kinds (task, Undo) per look; a look change swaps them all.
            return WidgetLook.values().length * ROW_KINDS;
        }

        @Override
        public long getItemId(int position) {
            JSONObject row = rows.optJSONObject(position);
            return row == null ? position : row.optString("id", "").hashCode();
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
