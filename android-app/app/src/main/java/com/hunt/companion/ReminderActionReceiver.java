package com.hunt.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.Toast;

/**
 * A reminder notification's Done, +1 and Snooze (ADR-0007), with Hunt open or closed. Done and
 * +1 queue the Pending Tick the plan named ({@link ReminderActions#tick}), which Hunt applies
 * through HuntCore when it next runs, or at once if it is running; the Day Widget redraws so the
 * row hides as a widget tick's would. Snooze stores the reminder ({@link ReminderActions#snooze})
 * and re-arms, so it is posted again in 10 minutes. A handled action removes the notification;
 * one that could not be saved leaves it in place and says so. Not exported. Never rename the
 * class: a posted notification's actions name it.
 */
public class ReminderActionReceiver extends BroadcastReceiver {
    private static final String TAG = "HuntReminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        // A small file read and write: well inside a receiver's time.
        try {
            handle(context.getApplicationContext(), intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "Reminder action failed", e);
        }
    }

    private static void handle(Context app, Intent intent) {
        if (intent == null) return;
        ReminderPlan.Entry entry = ReminderPlan.Entry.fromJson(intent.getStringExtra(Reminders.EXTRA_ENTRY));
        if (entry == null) return;
        long now = System.currentTimeMillis();
        boolean handled;
        if (Reminders.ACTION_TICK.equals(intent.getAction())) {
            PendingTicks.Queued queued = ReminderActions.tick(app.getFilesDir(), entry, now);
            handled = queued.closesWindow();
            if (queued == PendingTicks.Queued.ADDED) DayWidgetProvider.refreshAll(app);
        } else if (Reminders.ACTION_SNOOZE.equals(intent.getAction())) {
            handled = ReminderActions.snooze(app.getFilesDir(), entry, now);
            if (handled) Reminders.replan(app);
        } else {
            return;
        }
        if (handled) {
            Reminders.cancel(app, entry.key);
        } else {
            Toast.makeText(app, R.string.reminder_action_failed, Toast.LENGTH_SHORT).show();
        }
    }
}
