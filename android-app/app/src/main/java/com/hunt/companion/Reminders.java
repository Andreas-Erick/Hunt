package com.hunt.companion;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;

/**
 * Reminder notifications (ADR-0007). The page hands the bridge a Reminder Plan built by HuntCore
 * (MainActivity writes it to {@link HuntFiles#REMINDER_PLAN_FILE}); this posts the reminders that
 * are due, once each, and keeps one alarm armed for the next one, exact when Android allows it.
 * A tap opens Hunt on the item. Each notification offers the plan entry's Done or +1 and always
 * Snooze 10 min, handled by {@link ReminderActionReceiver}: Done and +1 go through the Pending
 * Tick queue, as widget ticks do (ADR-0006); a Snooze is stored by {@link ReminderSnoozes} and
 * posted again from {@link ReminderPlan#withSnoozes} until the page's next plan has judged it.
 * Nothing here decides what is due or writes Hunt data.
 *
 * <p>Habit reminders are plan entries of kind "habit": only their text differs, and the kind is
 * passed back to the page as it is.
 */
final class Reminders {
    private static final String TAG = "HuntReminders";

    /** The notification channel. Never rename it: the user's settings for it are kept by id. */
    static final String CHANNEL_ID = "reminders";
    /** The alarm's broadcast to {@link ReminderAlarmReceiver}. */
    static final String ACTION_ALARM = "com.hunt.companion.action.REMINDER_ALARM";
    /** A notification tap, to MainActivity, carrying the item to open. */
    static final String ACTION_OPEN = "com.hunt.companion.action.OPEN_REMINDER";
    static final String EXTRA_KIND = "com.hunt.companion.extra.REMINDER_KIND";
    static final String EXTRA_ITEM_ID = "com.hunt.companion.extra.REMINDER_ITEM_ID";
    static final String EXTRA_DATE_KEY = "com.hunt.companion.extra.REMINDER_DATE_KEY";
    /** A plan entry's kind for a Habit day (HuntCore's DueReminder.kind); anything else reads as a Task. */
    private static final String KIND_HABIT = "habit";
    /** A notification's Done or +1, and its Snooze, to {@link ReminderActionReceiver}. */
    static final String ACTION_TICK = "com.hunt.companion.action.REMINDER_TICK";
    static final String ACTION_SNOOZE = "com.hunt.companion.action.REMINDER_SNOOZE";
    /** The plan entry an action is for ({@link ReminderPlan.Entry#toJson}). */
    static final String EXTRA_ENTRY = "com.hunt.companion.extra.REMINDER_ENTRY";

    /**
     * PendingIntent request codes. NEVER change a value: an armed alarm and a posted notification
     * hold their PendingIntent by (component, action, data, request code). Each notification tap
     * differs by its data URI (the reminder key), so one code serves them all.
     */
    static final int REQUEST_ALARM = 40;
    static final int REQUEST_OPEN = 41;
    /** Every notification action; they differ by intent action and data URI (the reminder key). */
    static final int REQUEST_ACTION = 42;
    /** Notifications are told apart by tag (the reminder key) under this one id. */
    private static final int NOTIFICATION_ID = 1;

    /** The shell's own preferences: when reminders were last posted, and whether Hunt has asked. */
    private static final String PREFS = "hunt-reminders";
    private static final String PREF_FIRED_THROUGH = "firedThrough";
    private static final String PREF_ASKED_NOTIFICATIONS = "askedNotifications";

    private Reminders() {
    }

    /**
     * Any thread (the bridge's write thread, the receiver): posts the reminders due now and arms
     * the alarm for the next one. Serialised, so the alarm and a new plan never post one twice.
     */
    static synchronized void replan(Context ctx) {
        Context app = ctx.getApplicationContext();
        ReminderPlan plan = readPlan(app).withSnoozes(ReminderSnoozes.read(app.getFilesDir()));
        long now = System.currentTimeMillis();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long firedThrough = prefs.getLong(PREF_FIRED_THROUGH, 0L);
        boolean posted = false;
        for (ReminderPlan.Entry e : plan.due(firedThrough, now)) {
            post(app, e);
            posted = true;
        }
        if (posted) prefs.edit().putLong(PREF_FIRED_THROUGH, now).apply();
        arm(app, plan.nextAlarmAt(now));
    }

    /** The plan file, read under the shared lock. Missing or unreadable: no reminders. */
    private static ReminderPlan readPlan(Context app) {
        String json;
        synchronized (HuntFiles.LOCK) {
            json = HuntFiles.readText(new File(app.getFilesDir(), HuntFiles.REMINDER_PLAN_FILE));
        }
        return ReminderPlan.parse(json);
    }

    /** Arms (or with `at` < 0 cancels) the one reminder alarm: exact when allowed, else inexact. */
    private static void arm(Context app, long at) {
        AlarmManager am = app.getSystemService(AlarmManager.class);
        if (am == null) return;
        Intent intent = new Intent(app, ReminderAlarmReceiver.class).setAction(ACTION_ALARM);
        PendingIntent alarm = PendingIntent.getBroadcast(app, REQUEST_ALARM, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (at < 0) {
            am.cancel(alarm);
            return;
        }
        if (exactAlarmsAllowed(app)) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm);
                return;
            } catch (SecurityException e) {
                Log.w(TAG, "Exact alarm refused; arming an inexact one", e);
            }
        }
        // Without the exact-alarm grant Android may deliver this some minutes late; the page says so.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarm);
    }

    /** Posts one reminder, tagged with its key so a repeat replaces it instead of stacking. */
    private static void post(Context app, ReminderPlan.Entry e) {
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        if (nm == null) return;
        ensureChannel(app, nm);
        int text = KIND_HABIT.equals(e.kind) ? R.string.reminder_habit_text : R.string.reminder_task_text;
        Notification.Builder b = new Notification.Builder(app, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher_monochrome)
                .setContentTitle(e.title)
                .setContentText(app.getString(text))
                .setWhen(e.fireAt)
                .setShowWhen(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(openIntent(app, e));
        if (e.actionTick != null) {
            int label = TickKeys.PLUS_ONE.equals(e.actionTick) ? R.string.reminder_action_plus_one : R.string.reminder_action_done;
            b.addAction(action(app, e, ACTION_TICK, label));
        }
        b.addAction(action(app, e, ACTION_SNOOZE, R.string.reminder_action_snooze));
        Notification n = b.build();
        try {
            nm.notify(e.key, NOTIFICATION_ID, n);
        } catch (RuntimeException ex) {
            // Notifications not allowed: nothing to show. The page explains why reminders don't arrive.
            Log.w(TAG, "Posting a reminder failed", ex);
        }
    }

    private static void ensureChannel(Context app, NotificationManager nm) {
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID,
                app.getString(R.string.reminder_channel_name), NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(app.getString(R.string.reminder_channel_description));
        nm.createNotificationChannel(channel);
    }

    /** The tap: an explicit, immutable intent to MainActivity naming the item. */
    private static PendingIntent openIntent(Context app, ReminderPlan.Entry e) {
        Intent open = new Intent(app, MainActivity.class)
                .setAction(ACTION_OPEN)
                .setData(Uri.fromParts("hunt-reminder", e.key, null))
                .putExtra(EXTRA_KIND, e.kind)
                .putExtra(EXTRA_ITEM_ID, e.itemId)
                .putExtra(EXTRA_DATE_KEY, e.dateKey)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return PendingIntent.getActivity(app, REQUEST_OPEN, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** One notification action: an explicit, immutable broadcast to the action receiver carrying the entry. */
    private static Notification.Action action(Context app, ReminderPlan.Entry e, String intentAction, int label) {
        Intent intent = new Intent(app, ReminderActionReceiver.class)
                .setAction(intentAction)
                .setData(Uri.fromParts("hunt-reminder", e.key, null))
                .putExtra(EXTRA_ENTRY, e.toJson());
        PendingIntent pi = PendingIntent.getBroadcast(app, REQUEST_ACTION, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Action.Builder(Icon.createWithResource(app, R.mipmap.ic_launcher_monochrome),
                app.getString(label), pi).build();
    }

    /** Removes the notification posted for `key`, once one of its actions has been handled. */
    static void cancel(Context ctx, String key) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.cancel(key, NOTIFICATION_ID);
    }

    /**
     * The item a notification tap names, as the page's __huntOpenReminder argument
     * ({kind, itemId, dateKey}), or null when the intent is not a reminder tap.
     */
    static JSONObject openTarget(Intent intent) {
        if (intent == null || !ACTION_OPEN.equals(intent.getAction())) return null;
        String itemId = intent.getStringExtra(EXTRA_ITEM_ID);
        if (itemId == null || itemId.isEmpty()) return null;
        JSONObject target = new JSONObject();
        try {
            target.put("kind", nonNull(intent.getStringExtra(EXTRA_KIND)));
            target.put("itemId", itemId);
            target.put("dateKey", nonNull(intent.getStringExtra(EXTRA_DATE_KEY)));
        } catch (JSONException ignored) {
            return null; // static keys: cannot happen
        }
        return target;
    }

    private static String nonNull(String s) {
        return s == null ? "" : s;
    }

    /** Notifications can be shown: granted (Android 13+), switched on, and the channel not muted. */
    static boolean notificationsAllowed(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled()) return false;
        NotificationChannel channel = nm.getNotificationChannel(CHANNEL_ID);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    /** Exact alarms may be set (always before Android 12). */
    static boolean exactAlarmsAllowed(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        return am != null && am.canScheduleExactAlarms();
    }

    /** The page's view of the two grants: {"notifications": bool, "exactAlarms": bool}. */
    static String permissionsJson(Context ctx) {
        JSONObject o = new JSONObject();
        try {
            o.put("notifications", notificationsAllowed(ctx));
            o.put("exactAlarms", exactAlarmsAllowed(ctx));
        } catch (JSONException ignored) {
            // static keys: cannot happen
        }
        return o.toString();
    }

    static boolean askedForNotifications(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(PREF_ASKED_NOTIFICATIONS, false);
    }

    static void markAskedForNotifications(Context ctx) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(PREF_ASKED_NOTIFICATIONS, true).apply();
    }
}
