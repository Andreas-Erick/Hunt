package com.hunt.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * The reminder alarm, and the broadcasts after which it must be armed again: a reboot (alarms do
 * not survive one), a clock or time zone change, an app update, and the exact-alarm grant being
 * given or taken. Each one posts what is due and re-arms ({@link Reminders#replan}). Not
 * exported: the system still delivers these broadcasts, and the alarm is an explicit intent.
 * Never rename the class: an armed alarm's PendingIntent names it.
 */
public class ReminderAlarmReceiver extends BroadcastReceiver {
    private static final String TAG = "HuntReminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        // A small file read and at most a few notifications: well inside a receiver's time.
        try {
            Reminders.replan(context);
        } catch (RuntimeException e) {
            Log.w(TAG, "Reminder alarm failed", e);
        }
    }
}
