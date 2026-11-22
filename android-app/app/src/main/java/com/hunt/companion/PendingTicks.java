package com.hunt.companion;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

/**
 * The Pending Tick queue (GLOSSARY.md, ADR-0006): Tasks ticked done on the Day Widget that Hunt
 * has not applied yet. The file is a JSON array of {"taskId", "dateKey", "tickedAt"} objects
 * (tickedAt in epoch ms). It is the only file the widget writes, and it only ever appends; the
 * phone page reads it on start, applies the ticks through HuntCore and acknowledges them through
 * the bridge, which removes exactly the acknowledged entries, so a tick that arrives meanwhile
 * survives. No Hunt rule lives here: the queue holds what was tapped, HuntCore decides.
 *
 * Every read-modify-write holds {@link HuntFiles#LOCK} and replaces the file atomically.
 */
final class PendingTicks {
    private static final String TAG = "HuntPendingTicks";
    /** A queue this long means Hunt has not started for a very long time; further taps are dropped. */
    static final int MAX_TICKS = 500;

    private PendingTicks() {
    }

    static File queueFile(File dir) {
        return new File(dir, HuntFiles.PENDING_TICKS_FILE);
    }

    /** Told when a tick has just been queued, so a running Hunt can apply it at once (#10). */
    interface Listener {
        /** Called on the appending thread, outside the lock; must only hand off (e.g. post). */
        void onTickQueued();
    }

    private static volatile Listener listener;

    /** MainActivity.onCreate: the live Activity listens; a newer Activity replaces an older one. */
    static synchronized void setListener(Listener l) {
        listener = l;
    }

    /** MainActivity.onDestroy: stops listening, unless a newer Activity already took over. */
    static synchronized void clearListener(Listener l) {
        if (listener == l) listener = null;
    }

    /** With no Activity listening this does nothing: the page drains the queue when it next starts. */
    private static void notifyTickQueued() {
        Listener l = listener;
        if (l == null) return;
        try {
            l.onTickQueued();
        } catch (RuntimeException e) {
            Log.w(TAG, "Telling Hunt about a queued tick failed; it applies the tick when it next starts", e);
        }
    }

    /**
     * Widget: queues a tick. A second tap on the same Task and day is not queued twice. Returns
     * false if the tick could not be queued (full or the write failed). Any thread. A newly queued
     * tick is announced to the listener (a running Hunt) once the file is written.
     */
    static boolean append(File dir, String taskId, String dateKey, long tickedAt) {
        if (taskId == null || taskId.isEmpty() || dateKey == null || dateKey.isEmpty()) return false;
        boolean queued;
        synchronized (HuntFiles.LOCK) {
            JSONArray queue = readQueue(dir);
            if (queue == null) return false; // kept as it is until the bridge sets it aside
            for (int i = 0; i < queue.length(); i++) {
                JSONObject t = queue.optJSONObject(i);
                if (t != null && taskId.equals(t.optString("taskId")) && dateKey.equals(t.optString("dateKey"))) {
                    return true;
                }
            }
            if (queue.length() >= MAX_TICKS) {
                Log.w(TAG, "Pending Tick queue is full; tick dropped");
                return false;
            }
            try {
                queue.put(new JSONObject().put("taskId", taskId).put("dateKey", dateKey).put("tickedAt", tickedAt));
                HuntFiles.writeText(queueFile(dir), queue.toString());
                queued = true;
            } catch (JSONException | IOException | RuntimeException e) {
                Log.w(TAG, "Queueing a tick failed", e);
                queued = false;
            }
        }
        if (queued) notifyTickQueued();
        return queued;
    }

    /**
     * Bridge: the queue as JSON array text, "[]" when empty. An unreadable queue is renamed aside
     * (kept for diagnosis, never overwritten), so the widget can queue new ticks again. Any thread.
     */
    static String read(File dir) {
        synchronized (HuntFiles.LOCK) {
            JSONArray queue = readQueue(dir);
            if (queue != null) return queue.toString();
            File aside = new File(dir, "hunt-pending-ticks-unreadable-" + System.currentTimeMillis() + ".json");
            boolean moved = queueFile(dir).renameTo(aside);
            Log.e(TAG, "Pending Tick queue " + HuntFiles.PENDING_TICKS_FILE + " is unreadable; "
                    + (moved ? "kept as " + aside.getName() : "it could not be moved aside"));
            return "[]";
        }
    }

    /** Widget: ids of the Tasks waiting in the queue, so the widget hides them right away. */
    static Set<String> queuedTaskIds(File dir) {
        Set<String> ids = new HashSet<>();
        synchronized (HuntFiles.LOCK) {
            JSONArray queue = readQueue(dir);
            for (int i = 0; queue != null && i < queue.length(); i++) {
                JSONObject t = queue.optJSONObject(i);
                if (t != null) ids.add(t.optString("taskId"));
            }
        }
        return ids;
    }

    /**
     * Bridge (write thread): removes the acknowledged ticks, matched on taskId, dateKey and
     * tickedAt, and keeps every other entry. Returns how many were removed.
     */
    static int ack(File dir, String ackedJson) {
        Set<String> acked = new HashSet<>();
        try {
            JSONArray list = new JSONArray(ackedJson);
            for (int i = 0; i < list.length(); i++) {
                JSONObject t = list.optJSONObject(i);
                if (t != null) acked.add(key(t));
            }
        } catch (JSONException e) {
            Log.w(TAG, "ackPendingTicks ignored: not a JSON array");
            return 0;
        }
        if (acked.isEmpty()) return 0;
        synchronized (HuntFiles.LOCK) {
            JSONArray queue = readQueue(dir);
            if (queue == null) return 0;
            JSONArray kept = new JSONArray();
            for (int i = 0; i < queue.length(); i++) {
                JSONObject t = queue.optJSONObject(i);
                if (t != null && !acked.contains(key(t))) kept.put(t);
            }
            int removed = queue.length() - kept.length();
            if (removed == 0) return 0;
            try {
                HuntFiles.writeText(queueFile(dir), kept.toString());
            } catch (IOException | RuntimeException e) {
                Log.w(TAG, "Clearing acknowledged ticks failed; Hunt skips them as already done next time", e);
                return 0;
            }
            return removed;
        }
    }

    private static String key(JSONObject t) {
        return t.optString("taskId") + "|" + t.optString("dateKey") + "|" + t.optLong("tickedAt");
    }

    /** Caller holds LOCK. A missing file is an empty queue; an unreadable one is null. */
    private static JSONArray readQueue(File dir) {
        String text = HuntFiles.readText(queueFile(dir));
        if (text.isEmpty()) return new JSONArray();
        try {
            return new JSONArray(text);
        } catch (JSONException e) {
            Log.w(TAG, "Unreadable Pending Tick queue " + HuntFiles.PENDING_TICKS_FILE, e);
            return null;
        }
    }
}
