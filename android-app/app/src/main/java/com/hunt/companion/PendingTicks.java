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
    /** A queue this long means Hunt has not started for a very long time; further ticks wait in their Undo window. */
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

    /** What became of a tick handed to {@link #append}. */
    enum Queued {
        /** Written to the queue. */
        ADDED,
        /** The queue already holds this Task and day. */
        ALREADY_QUEUED,
        /** No Task or day: it can never be queued. */
        REJECTED,
        /** The queue holds {@link #MAX_TICKS} ticks; it frees up when Hunt next drains it. */
        FULL,
        /** The queue file could not be read or parsed; it is left as it is (see {@link #read}). */
        UNREADABLE,
        /** Writing the queue failed. */
        WRITE_FAILED;

        /** True when the tick is settled and its Undo window may close; otherwise keep it and retry. */
        boolean closesWindow() {
            return this == ADDED || this == ALREADY_QUEUED || this == REJECTED;
        }
    }

    /**
     * Widget: queues a tick. A second tap on the same Task and day is not queued twice. A queue
     * that cannot be read is never written over. Any thread. A newly queued tick is announced to
     * the listener (a running Hunt) once the file is written.
     */
    static Queued append(File dir, String taskId, String dateKey, long tickedAt) {
        if (taskId == null || taskId.isEmpty() || dateKey == null || dateKey.isEmpty()) return Queued.REJECTED;
        Queued result;
        synchronized (HuntFiles.LOCK) {
            result = appendLocked(dir, taskId, dateKey, tickedAt);
        }
        if (result == Queued.ADDED) notifyTickQueued();
        return result;
    }

    private static Queued appendLocked(File dir, String taskId, String dateKey, long tickedAt) {
        JSONArray queue;
        try {
            queue = readQueue(dir);
        } catch (IOException | JSONException e) {
            Log.w(TAG, "Pending Tick queue " + HuntFiles.PENDING_TICKS_FILE + " is unreadable; the tick waits", e);
            return Queued.UNREADABLE;
        }
        String wanted = TickKeys.taskDay(taskId, dateKey);
        for (int i = 0; i < queue.length(); i++) {
            JSONObject t = queue.optJSONObject(i);
            if (t != null && wanted.equals(TickKeys.taskDay(t.optString("taskId"), t.optString("dateKey")))) {
                return Queued.ALREADY_QUEUED;
            }
        }
        if (queue.length() >= MAX_TICKS) {
            Log.w(TAG, "Pending Tick queue is full; the tick waits until Hunt drains it");
            return Queued.FULL;
        }
        try {
            queue.put(new JSONObject().put("taskId", taskId).put("dateKey", dateKey).put("tickedAt", tickedAt));
            HuntFiles.writeText(queueFile(dir), queue.toString());
            return Queued.ADDED;
        } catch (JSONException | IOException | RuntimeException e) {
            Log.w(TAG, "Queueing a tick failed; the tick waits", e);
            return Queued.WRITE_FAILED;
        }
    }

    /**
     * Bridge: what the page drains, as JSON object text: {"ticks": [...]}, plus "heldBack": n
     * when n ended Undo windows could not be queued yet (they are kept and retried), and
     * "unreadable": "corrupt" or "read-error" when the queue could not be read. A corrupt queue
     * is renamed aside (named in "keptAs"; kept for recovery, never overwritten) so the widget can
     * queue again; a read error leaves the file in place for the next read. Any thread.
     */
    static String read(File dir, int heldBack) {
        JSONObject out = new JSONObject();
        try {
            JSONArray ticks = new JSONArray();
            synchronized (HuntFiles.LOCK) {
                try {
                    ticks = readQueue(dir);
                } catch (JSONException e) {
                    out.put("unreadable", "corrupt");
                    File aside = new File(dir, "hunt-pending-ticks-unreadable-" + System.currentTimeMillis() + ".json");
                    boolean moved = queueFile(dir).renameTo(aside);
                    if (moved) out.put("keptAs", aside.getName());
                    Log.e(TAG, "Pending Tick queue " + HuntFiles.PENDING_TICKS_FILE + " is unreadable; "
                            + (moved ? "kept as " + aside.getName() : "it could not be moved aside"), e);
                } catch (IOException e) {
                    out.put("unreadable", "read-error");
                    Log.e(TAG, "Reading the Pending Tick queue " + HuntFiles.PENDING_TICKS_FILE + " failed; left in place", e);
                }
            }
            out.put("ticks", ticks);
            if (heldBack > 0) out.put("heldBack", heldBack);
        } catch (JSONException e) {
            throw new IllegalStateException(e); // only put() with a null key throws
        }
        return out.toString();
    }

    /** Widget: ids of the Tasks waiting in the queue, so the widget hides them right away. */
    static Set<String> queuedTaskIds(File dir) {
        Set<String> ids = new HashSet<>();
        synchronized (HuntFiles.LOCK) {
            JSONArray queue;
            try {
                queue = readQueue(dir);
            } catch (IOException | JSONException e) {
                return ids; // nothing hidden; the page reports the unreadable queue when it reads it
            }
            for (int i = 0; i < queue.length(); i++) {
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
            JSONArray queue;
            try {
                queue = readQueue(dir);
            } catch (IOException | JSONException e) {
                Log.w(TAG, "ackPendingTicks skipped: the queue is unreadable and is never written over", e);
                return 0;
            }
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
        return TickKeys.ack(t.optString("taskId"), t.optString("dateKey"), t.optLong("tickedAt"));
    }

    /** Caller holds LOCK. A missing file is an empty queue; one that cannot be read or parsed throws. */
    private static JSONArray readQueue(File dir) throws IOException, JSONException {
        String text = HuntFiles.readExisting(queueFile(dir));
        return text.isEmpty() ? new JSONArray() : new JSONArray(text);
    }
}
