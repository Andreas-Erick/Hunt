package com.hunt.companion;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Each Day Widget's selected day (the ‹ › arrows), the widget's only own state: kept in private
 * preferences with the local date it was chosen on, so it expires at midnight
 * ({@link DaySelection#selectedOffset}).
 */
final class DayNav {
    /** Private preferences holding each widget's selected day. */
    private static final String NAV_PREFS = "day_widget_nav";
    /** Key prefix: the local date key the choice was made on. */
    private static final String KEY_CHOSEN_ON = "on_";
    /** Key prefix: the chosen day offset. */
    private static final String KEY_OFFSET = "offset_";

    private DayNav() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(NAV_PREFS, Context.MODE_PRIVATE);
    }

    /** The day offset widget `widgetId` shows now: its choice if made today, otherwise today. */
    static int savedOffset(Context ctx, int widgetId) {
        SharedPreferences prefs = prefs(ctx);
        return DaySelection.selectedOffset(prefs.getString(KEY_CHOSEN_ON + widgetId, null),
                prefs.getInt(KEY_OFFSET + widgetId, 0), WidgetSupport.localDateKey());
    }

    /** Selects `offset` (clamped) on widget `widgetId` for today; returns the offset kept. */
    static int select(Context ctx, int widgetId, int offset) {
        String todayKey = WidgetSupport.localDateKey();
        int kept = DaySelection.selectedOffset(todayKey, offset, todayKey);
        prefs(ctx).edit()
                .putString(KEY_CHOSEN_ON + widgetId, todayKey)
                .putInt(KEY_OFFSET + widgetId, kept)
                .apply();
        return kept;
    }

    /** Removed widgets forget their day. */
    static void forget(Context ctx, int[] widgetIds) {
        SharedPreferences.Editor edit = prefs(ctx).edit();
        for (int id : widgetIds) edit.remove(KEY_CHOSEN_ON + id).remove(KEY_OFFSET + id);
        edit.apply();
    }

    /** The last widget is gone. */
    static void clear(Context ctx) {
        prefs(ctx).edit().clear().apply();
    }
}
