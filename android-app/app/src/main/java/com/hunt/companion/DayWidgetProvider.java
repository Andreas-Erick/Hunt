package com.hunt.companion;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.widget.RemoteViews;

/**
 * Day Widget (GLOSSARY.md): draws one day's open Tasks from the Widget Snapshot the phone page
 * hands to the shell after every save (ADR-0006), and lets the user tick a Task done. A tick is
 * only appended to the Pending Tick queue ({@link PendingTicks}) and the Task hidden; Hunt applies
 * it through HuntCore on its next start. It never writes the state file or the snapshot and holds
 * no Hunt rule; which Tasks show, their order and whether they can be ticked all come from
 * HuntCore's buildWidgetSnapshot ({@link SelectedDay}). Its only own state is each widget's
 * selected day ({@link DayNav}).
 *
 * The class name is part of every placed widget: never rename it, or users lose their widgets
 * on update.
 *
 * Redraws: when the snapshot changes ({@link #refreshAll}), on every APPWIDGET_UPDATE (placing,
 * reboot, APK update), on time or time-zone changes, on an arrow tap, and just after local
 * midnight through an inexact alarm.
 *
 * Undo (#9): a tick first opens a 4-second Undo window ({@link DayWidgetUndo}); the row draws as
 * "✓ Done · Undo" and the Pending Tick is appended only when the window ends. Every redraw first
 * appends what is due.
 *
 * Row taps reach {@link DayWidgetTaps} through {@link DayWidgetTapActivity}, a no-UI trampoline: the
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

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        DayWidgetUndo.commitDue(ctx);
        drawAll(ctx, mgr, ids);
        WidgetSupport.armMidnightAlarm(ctx, DayWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.DAY_MIDNIGHT);
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        super.onReceive(ctx, intent);
        String action = intent == null ? null : intent.getAction();
        if (ACTION_UNDO_DUE.equals(action)) {
            refreshAll(ctx); // appends the ticks whose window ended
        } else if (WidgetSupport.isClockChange(action, ACTION_MIDNIGHT)) {
            refreshAll(ctx);
            WidgetSupport.armMidnightAlarm(ctx, DayWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.DAY_MIDNIGHT);
        } else if (ACTION_NAV.equals(action)) {
            int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
            if (id == AppWidgetManager.INVALID_APPWIDGET_ID) return;
            int offset = DayNav.select(ctx, id, intent.getIntExtra(EXTRA_DAY_OFFSET, 0));
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            mgr.updateAppWidget(id, draw(ctx, id, SelectedDay.read(ctx, offset)));
            refreshServedList(mgr, new int[] {id});
        }
    }

    @Override
    public void onDeleted(Context ctx, int[] ids) {
        DayNav.forget(ctx, ids);
    }

    @Override
    public void onDisabled(Context ctx) {
        WidgetSupport.cancelMidnightAlarm(ctx, DayWidgetProvider.class, ACTION_MIDNIGHT, WidgetRequestCodes.DAY_MIDNIGHT);
        DayNav.clear(ctx);
    }

    /** Redraws every placed Day Widget from the snapshot file. Any thread; no-op when none is placed. */
    static void refreshAll(Context ctx) {
        if (ctx == null) return;
        try {
            DayWidgetUndo.commitDue(ctx); // first, so a late timer never draws an ended window
            int[] ids = WidgetSupport.placedIds(ctx, DayWidgetProvider.class);
            if (ids.length == 0) return;
            drawAll(ctx, AppWidgetManager.getInstance(ctx), ids);
        } catch (RuntimeException e) {
            Log.w(TAG, "Day Widget refresh failed", e);
        }
    }

    private static void drawAll(Context ctx, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) mgr.updateAppWidget(id, draw(ctx, id, SelectedDay.read(ctx, DayNav.savedOffset(ctx, id))));
        refreshServedList(mgr, ids);
    }

    /** Before API 31 the rows come from DayWidgetService, which re-reads them on this call; from 31 they ride in the update. */
    private static void refreshServedList(AppWidgetManager mgr, int[] ids) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) mgr.notifyAppWidgetViewDataChanged(ids, R.id.widget_list);
    }

    private static RemoteViews draw(Context ctx, int widgetId, SelectedDay day) {
        WidgetLook look = day.snapshot.look;
        if (!day.hasList()) return WidgetSupport.messageViews(ctx, day.snapshot, WidgetRequestCodes.DAY_OPEN_HUNT);
        RemoteViews views = new RemoteViews(ctx.getPackageName(), look.dayLayout);
        String label = DaySelection.headerLabel(day.offset, day.date);
        int open = day.openCount();
        String count = open > 0 ? ctx.getString(R.string.day_widget_left, open) : "";
        views.setImageViewBitmap(R.id.widget_header, WidgetDisplayText.dayTitle(ctx, look, label, count));
        views.setContentDescription(R.id.widget_header,
                ctx.getString(R.string.day_widget_header_open, open > 0 ? label + ", " + count : label));
        views.setOnClickPendingIntent(R.id.widget_header, WidgetSupport.openHunt(ctx, WidgetRequestCodes.DAY_OPEN_HUNT));
        views.setTextViewText(R.id.widget_empty,
                ctx.getString(R.string.day_widget_nothing_left, DaySelection.inSentence(day.offset, day.date)));
        arrow(ctx, views, look, R.id.widget_prev, widgetId, day.offset - 1, day.offset > 0);
        arrow(ctx, views, look, R.id.widget_next, widgetId, day.offset + 1, day.offset < day.lastOffset);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // The rows ride in this same update, so the header never lags the list
            // (DayWidgetService.items explains the deferred-update path this avoids).
            views.setRemoteAdapter(R.id.widget_list, DayWidgetService.items(ctx, widgetId, day));
        } else {
            Intent service = new Intent(ctx, DayWidgetService.class)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
            // A distinct data URI per widget, so each gets its own list factory.
            service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
            views.setRemoteAdapter(R.id.widget_list, service);
        }
        views.setEmptyView(R.id.widget_list, R.id.widget_empty);
        views.setPendingIntentTemplate(R.id.widget_list, rowTemplate(ctx));
        return views;
    }

    /**
     * The previous or next arrow. At an end it stays in place, so the label never shifts, but it is
     * dimmed, disabled and has no intent.
     */
    private static void arrow(Context ctx, RemoteViews views, WidgetLook look, int viewId, int widgetId, int target,
            boolean enabled) {
        views.setBoolean(viewId, "setEnabled", enabled);
        views.setInt(viewId, "setColorFilter", ctx.getColor(enabled ? look.text : look.dim));
        if (enabled) views.setOnClickPendingIntent(viewId, navIntent(ctx, widgetId, target));
    }

    /** Explicit, immutable broadcast to this provider that selects day `offset` on widget `widgetId`. */
    private static PendingIntent navIntent(Context ctx, int widgetId, int offset) {
        Intent intent = new Intent(ctx, DayWidgetProvider.class)
                .setAction(ACTION_NAV)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra(EXTRA_DAY_OFFSET, offset)
                // A distinct URI per widget and target, so each arrow keeps its own PendingIntent.
                .setData(Uri.parse("hunt-widget://day/" + widgetId + "/" + offset))
                // A tap the user is watching: deliver it now. Without this, Android 14+ queues a
                // broadcast to a cached (frozen) app behind its background work, and the header
                // redraw arrives seconds later or only when the app next runs.
                .addFlags(Intent.FLAG_RECEIVER_FOREGROUND);
        return PendingIntent.getBroadcast(ctx, WidgetRequestCodes.DAY_NAV, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Template for row taps: an explicit activity intent to the no-UI trampoline
     * {@link DayWidgetTapActivity}, which forwards to {@link DayWidgetTaps} and opens Hunt when asked.
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
        return PendingIntent.getActivity(ctx, WidgetRequestCodes.DAY_ROW_TEMPLATE, intent, PendingIntent.FLAG_UPDATE_CURRENT | mutable);
    }
}
