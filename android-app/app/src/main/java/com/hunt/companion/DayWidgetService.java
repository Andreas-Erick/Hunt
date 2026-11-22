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
 * Rows of the Day Widget's list for its selected day, drawn from the Widget Snapshot
 * (ADR-0006). Read-only: it reads the snapshot file and never writes anything. The class name is
 * part of the manifest contract.
 */
public class DayWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext(),
                intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID));
    }

    private static final class Rows implements RemoteViewsFactory {
        private final Context ctx;
        private final int widgetId;
        private JSONArray rows = new JSONArray();

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
            DayWidgetProvider.Today today =
                    DayWidgetProvider.readDay(ctx, DayWidgetProvider.savedOffset(ctx, widgetId));
            rows = today.noData || today.stale ? new JSONArray() : today.rows;
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
            RemoteViews views = new RemoteViews(ctx.getPackageName(), R.layout.widget_day_row_neon);
            if (row == null) return views;
            String title = row.optString("title", "");
            boolean focus = row.optBoolean("focus", false);
            int accent = ctx.getColor(accentColor(row.optString("accent", "slate")));

            views.setTextViewText(R.id.widget_row_title, title);
            views.setInt(R.id.widget_row_bar, "setColorFilter", accent);
            views.setInt(R.id.widget_row_ring, "setColorFilter", accent);
            views.setViewVisibility(R.id.widget_row_ring, focus ? View.GONE : View.VISIBLE);
            views.setViewVisibility(R.id.widget_row_focus_mark, focus ? View.VISIBLE : View.GONE);

            int tag = focus ? R.string.day_widget_focus_tag
                    : row.optBoolean("habit", false) ? R.string.day_widget_habit_tag : 0;
            views.setViewVisibility(R.id.widget_row_tag, tag == 0 ? View.GONE : View.VISIBLE);
            if (tag != 0) views.setTextViewText(R.id.widget_row_tag, ctx.getString(tag));

            views.setContentDescription(R.id.widget_row,
                    ctx.getString(focus ? R.string.day_widget_row_focus : R.string.day_widget_row_open, title));
            // Read-only widget: every row opens Hunt (the template on the list carries the intent).
            views.setOnClickFillInIntent(R.id.widget_row, new Intent());
            return views;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null; // the launcher's default loading row
        }

        @Override
        public int getViewTypeCount() {
            return 1;
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

        /** Quest accent key from the snapshot -> the Neon colour resource (slate for unknown keys). */
        private static int accentColor(String key) {
            switch (key) {
                case "cyan": return R.color.widget_neon_q_cyan;
                case "emerald": return R.color.widget_neon_q_emerald;
                case "amber": return R.color.widget_neon_q_amber;
                case "purple": return R.color.widget_neon_q_purple;
                case "rose": return R.color.widget_neon_q_rose;
                case "sky": return R.color.widget_neon_q_sky;
                case "orange": return R.color.widget_neon_q_orange;
                case "lime": return R.color.widget_neon_q_lime;
                default: return R.color.widget_neon_q_slate;
            }
        }
    }
}
