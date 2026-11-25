package com.hunt.companion;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * This phone's notification Snoozes (ADR-0007): the shell's own file, not Hunt data and never
 * synced. Each record is {"key", "fireAt"} of the original reminder, "until" (when it fires
 * again) and "reminder" (the snoozed entry, so the shell can re-post it while Hunt is closed).
 * The page reads the {key, fireAt, until} part through the bridge and folds it into its next
 * Reminder Plan through HuntCore, which drops a snooze whose item was finished meanwhile.
 * One snooze per original reminder; ended ones are dropped on the next write. Every read and
 * write holds {@link HuntFiles#LOCK}. Plain Java, so it runs in the JDK probes.
 */
final class ReminderSnoozes {
    private static final String TAG = "HuntReminders";
    /** How long a Snooze waits (HuntCore's REMINDER_SNOOZE_MS). */
    static final long SNOOZE_MS = 10 * 60_000L;
    /** The most snoozes kept (the latest ends). */
    static final int MAX_SNOOZES = 64;

    private ReminderSnoozes() {
    }

    private static File file(File dir) {
        return new File(dir, HuntFiles.REMINDER_SNOOZES_FILE);
    }

    /**
     * Snoozes `reminder` (a snoozed one moves its original's snooze) until `now` + SNOOZE_MS.
     * False when the file could not be written. Any thread.
     */
    static boolean add(File dir, ReminderPlan.Entry reminder, long now) {
        synchronized (HuntFiles.LOCK) {
            List<ReminderPlan.Snooze> kept = new ArrayList<>();
            for (ReminderPlan.Snooze s : readLocked(dir)) {
                boolean ended = s.until < now - ReminderPlan.LATE_LIMIT_MS;
                if (!ended && !s.reminder.baseKey().equals(reminder.baseKey())) kept.add(s);
            }
            kept.add(0, new ReminderPlan.Snooze(reminder, now + SNOOZE_MS));
            JSONArray out = new JSONArray();
            for (int i = 0; i < kept.size() && i < MAX_SNOOZES; i++) out.put(recordOf(kept.get(i)));
            try {
                HuntFiles.writeText(file(dir), out.toString());
                return true;
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "Saving a snooze failed", e);
                return false;
            }
        }
    }

    /** Every stored snooze. A missing or unreadable file is none. Any thread. */
    static List<ReminderPlan.Snooze> read(File dir) {
        synchronized (HuntFiles.LOCK) {
            return readLocked(dir);
        }
    }

    /** Bridge: the snoozes as the page reads them, a JSON array of {key, fireAt, until}. */
    static String readJson(File dir) {
        JSONArray out = new JSONArray();
        try {
            for (ReminderPlan.Snooze s : read(dir)) {
                out.put(new JSONObject().put("key", s.reminder.baseKey()).put("fireAt", s.reminder.baseFireAt()).put("until", s.until));
            }
        } catch (JSONException e) {
            throw new IllegalStateException(e); // only put() with a null key throws
        }
        return out.toString();
    }

    private static JSONObject recordOf(ReminderPlan.Snooze s) {
        try {
            return new JSONObject().put("key", s.reminder.baseKey()).put("fireAt", s.reminder.baseFireAt())
                    .put("until", s.until).put("reminder", s.reminder.toJsonObject());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Caller holds LOCK. */
    private static List<ReminderPlan.Snooze> readLocked(File dir) {
        List<ReminderPlan.Snooze> out = new ArrayList<>();
        String text = HuntFiles.readText(file(dir));
        if (text.isEmpty()) return out;
        JSONArray list;
        try {
            list = new JSONArray(text);
        } catch (JSONException | RuntimeException e) {
            // Snoozes are a convenience: an unreadable file is none, and the next Snooze replaces it.
            Log.w(TAG, "The snooze file is unreadable; no snoozes", e);
            return out;
        }
        for (int i = 0; i < list.length(); i++) {
            JSONObject o = list.optJSONObject(i);
            if (o == null) continue;
            JSONObject r = o.optJSONObject("reminder");
            ReminderPlan.Entry reminder = r == null ? null : ReminderPlan.Entry.fromJson(r.toString());
            long until = o.optLong("until", 0L);
            if (reminder != null && until > 0) out.add(new ReminderPlan.Snooze(reminder, until));
        }
        return out;
    }
}
