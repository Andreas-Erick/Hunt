package com.hunt.companion;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Day Widget's Undo window (#9) as a plain rule: a tick shows "✓ Done · Undo" for
 * {@link #WINDOW_MS} after the tap, is then hidden, and becomes a Pending Tick only once
 * {@link #LATE_UNDO_MS} more has passed, so an Undo already on its way still lands. Each
 * Task and day has its own window, keyed {@link TickKeys#taskDay} with the tap time (epoch ms)
 * as the value. Plain Java, no Android types and no I/O (DayWidgetUndo stores and schedules), so the
 * test suite runs it on the JDK.
 */
final class UndoWindow {
    /** How long a ticked row offers Undo ("✓ Done · Undo"). */
    static final long WINDOW_MS = 4000;
    /**
     * How long after the row stops offering Undo the tick is still held before it is queued. An
     * Undo tapped just before {@link #WINDOW_MS} reaches the widget 100-300 ms later (launcher,
     * PendingIntent, trampoline); it must still find the window open rather than lose to the timer.
     */
    static final long LATE_UNDO_MS = 1500;

    private UndoWindow() {
    }

    /**
     * Whether a tick tapped at {@code tickedAt} has left its window at {@code now}. A clock set
     * back further than the window lets it go rather than holding it until the clock catches up.
     */
    static boolean isDue(long tickedAt, long now) {
        long age = now - tickedAt;
        return age >= WINDOW_MS || age < -WINDOW_MS;
    }

    /** Whether that tick is due for the queue: its window and LATE_UNDO_MS after it have passed. */
    static boolean isQueueDue(long tickedAt, long now) {
        long age = now - tickedAt;
        return age >= WINDOW_MS + LATE_UNDO_MS || age < -WINDOW_MS;
    }

    /** Keys due for the queue ({@link #isQueueDue}), in tap order (oldest first). Values that are not a Long are due. */
    static List<String> due(Map<String, ?> held, long now) {
        List<String> due = new ArrayList<>();
        for (Map.Entry<String, ?> e : held.entrySet()) {
            Object v = e.getValue();
            if (!(v instanceof Long) || isQueueDue((Long) v, now)) due.add(e.getKey());
        }
        Collections.sort(due, (a, b) -> Long.compare(tickedAt(held, a), tickedAt(held, b)));
        return due;
    }

    /** Appends one ended window's tick to the Pending Tick queue. */
    interface Queue {
        /**
         * True when the tick is settled (queued, or never queueable) and its window may close.
         * {@code kind} is the window's tick kind ({@link TickKeys#kindOf}): "" for done, "+1".
         */
        boolean settle(String taskId, String dateKey, long tickedAt, String kind);
    }

    /** What {@link #commit} did: the windows to close, and how many ended ones it had to keep. */
    static final class Commit {
        final List<String> closed = new ArrayList<>();
        int heldBack;
    }

    /**
     * Hands every window that has ended at `now` to `queue`, in tap order with its original tap
     * time. Only a settled tick closes its window; one the queue refused (full, unreadable, a
     * failed write) stays held, still hidden, and is offered again on the next commit, so no tick
     * is ever lost.
     */
    static Commit commit(Map<String, ?> held, long now, Queue queue) {
        Commit result = new Commit();
        for (String key : due(held, now)) {
            Object v = held.get(key);
            long tickedAt = v instanceof Long ? (Long) v : now;
            if (queue.settle(TickKeys.taskIdOf(key), TickKeys.dateKeyOf(key), tickedAt, TickKeys.kindOf(key))) {
                result.closed.add(key);
            }
            else result.heldBack++;
        }
        return result;
    }

    /**
     * Tasks of `dateKey` the Day Widget's list leaves out: those waiting in the Pending Tick
     * queue for that day, and those whose window has ended but are not queued yet. Both are
     * keyed {@link TickKeys#taskDay}, so a tick hides its Task only on the day it was for. Tasks
     * still in their window stay listed (drawn as "✓ Done · Undo"). An Avoid row's Slip hides it
     * as a done tick does. A Count row's +1 never hides it: `queuedKeys` holds no +1 ticks, and
     * +1 windows are counted instead ({@link #pendingPlus}).
     */
    static Set<String> hiddenTaskIds(Set<String> queuedKeys, Map<String, ?> held, String dateKey, long now) {
        Set<String> hidden = new HashSet<>();
        for (String k : held.keySet()) {
            if (dateKey.equals(TickKeys.dateKeyOf(k)) && !TickKeys.PLUS_ONE.equals(TickKeys.kindOf(k))) {
                hidden.add(TickKeys.taskIdOf(k));
            }
        }
        hidden.removeAll(openTaskIds(held, dateKey, now));
        hidden.addAll(taskIdsOn(queuedKeys, dateKey));
        return hidden;
    }

    /**
     * Count rows of `dateKey` -> the +1s on their way that the snapshot's progress does not hold
     * yet: queued ones (`queuedPlus`, {@link TickKeys#taskDay} -> count) and ended windows not
     * queued yet. A +1 still in its window is drawn as "+1 · Undo" and not counted.
     */
    static Map<String, Integer> pendingPlus(Map<String, Integer> queuedPlus, Map<String, ?> held, String dateKey, long now) {
        Map<String, Integer> pending = new HashMap<>();
        for (Map.Entry<String, Integer> e : queuedPlus.entrySet()) {
            if (dateKey.equals(TickKeys.dateKeyOf(e.getKey()))) pending.merge(TickKeys.taskIdOf(e.getKey()), e.getValue(), Integer::sum);
        }
        for (Map.Entry<String, ?> e : held.entrySet()) {
            String k = e.getKey();
            Object v = e.getValue();
            boolean ended = !(v instanceof Long) || isDue((Long) v, now);
            if (ended && dateKey.equals(TickKeys.dateKeyOf(k)) && TickKeys.PLUS_ONE.equals(TickKeys.kindOf(k))) {
                pending.merge(TickKeys.taskIdOf(k), 1, Integer::sum);
            }
        }
        return pending;
    }

    /**
     * Count rows of `dateKey` with a +1 window not yet queued. Such a row offers no tick until
     * it is queued: its window key is taken, so a second tap would be lost.
     */
    static Set<String> heldPlusTaskIds(Map<String, ?> held, String dateKey) {
        Set<String> ids = new HashSet<>();
        for (String k : held.keySet()) {
            if (dateKey.equals(TickKeys.dateKeyOf(k)) && TickKeys.PLUS_ONE.equals(TickKeys.kindOf(k))) ids.add(TickKeys.taskIdOf(k));
        }
        return ids;
    }

    /** Tasks of `dateKey` still in their window: drawn as "✓ Done · Undo". */
    static Set<String> openTaskIds(Map<String, ?> held, String dateKey, long now) {
        Set<String> open = new HashSet<>();
        for (Map.Entry<String, ?> e : held.entrySet()) {
            Object v = e.getValue();
            if (dateKey.equals(TickKeys.dateKeyOf(e.getKey())) && v instanceof Long && !isDue((Long) v, now)) {
                open.add(TickKeys.taskIdOf(e.getKey()));
            }
        }
        return open;
    }

    /** Every Task of `dateKey` with a window, open or ended but not yet queued. */
    static Set<String> heldTaskIds(Map<String, ?> held, String dateKey) {
        return taskIdsOn(held.keySet(), dateKey);
    }

    /** The Tasks among {@link TickKeys#taskDay} keys that are for `dateKey`. */
    private static Set<String> taskIdsOn(Set<String> taskDayKeys, String dateKey) {
        Set<String> ids = new HashSet<>();
        for (String k : taskDayKeys) {
            if (dateKey.equals(TickKeys.dateKeyOf(k))) ids.add(TickKeys.taskIdOf(k));
        }
        return ids;
    }

    /**
     * The next moment (epoch ms) a held tick changes: its row stops offering Undo, or it becomes
     * due for the queue. -1 when nothing is held that is not already due.
     */
    static long nextDeadline(Map<String, ?> held, long now) {
        long next = -1;
        for (Object v : held.values()) {
            if (!(v instanceof Long) || isQueueDue((Long) v, now)) continue;
            long tickedAt = (Long) v;
            long end = isDue(tickedAt, now) ? tickedAt + WINDOW_MS + LATE_UNDO_MS : tickedAt + WINDOW_MS;
            if (next < 0 || end < next) next = end;
        }
        return next;
    }

    private static long tickedAt(Map<String, ?> held, String key) {
        Object v = held.get(key);
        return v instanceof Long ? (Long) v : Long.MIN_VALUE;
    }
}
