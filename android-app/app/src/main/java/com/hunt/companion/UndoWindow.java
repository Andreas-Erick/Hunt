package com.hunt.companion;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Day Widget's Undo window (#9) as a plain rule: a tick is held for {@link #WINDOW_MS} after
 * the tap, showing "✓ Done · Undo", and becomes a Pending Tick only when its window ends. Each
 * Task and day has its own window, keyed "dateKey|taskId" with the tap time (epoch ms) as the
 * value. Plain Java, no Android types and no I/O (DayWidgetUndo stores and schedules), so the
 * test suite runs it on the JDK.
 */
final class UndoWindow {
    /** How long a ticked row offers Undo before the tick is queued. */
    static final long WINDOW_MS = 4000;

    private UndoWindow() {
    }

    /** The window's key; the date key (YYYY-MM-DD) never holds '|', the Task id may. */
    static String key(String taskId, String dateKey) {
        return dateKey + "|" + taskId;
    }

    static String dateKeyOf(String key) {
        int bar = key.indexOf('|');
        return bar < 0 ? "" : key.substring(0, bar);
    }

    static String taskIdOf(String key) {
        int bar = key.indexOf('|');
        return bar < 0 ? key : key.substring(bar + 1);
    }

    /**
     * Whether a tick tapped at {@code tickedAt} has left its window at {@code now}. A clock set
     * back further than the window lets it go rather than holding it until the clock catches up.
     */
    static boolean isDue(long tickedAt, long now) {
        long age = now - tickedAt;
        return age >= WINDOW_MS || age < -WINDOW_MS;
    }

    /** Keys whose window has ended, in tap order (oldest first). Values that are not a Long are due. */
    static List<String> due(Map<String, ?> held, long now) {
        List<String> due = new ArrayList<>();
        for (Map.Entry<String, ?> e : held.entrySet()) {
            Object v = e.getValue();
            if (!(v instanceof Long) || isDue((Long) v, now)) due.add(e.getKey());
        }
        Collections.sort(due, (a, b) -> Long.compare(tickedAt(held, a), tickedAt(held, b)));
        return due;
    }

    /** Tasks of `dateKey` still in their window: drawn as "✓ Done · Undo". */
    static Set<String> openTaskIds(Map<String, ?> held, String dateKey, long now) {
        Set<String> open = new HashSet<>();
        for (Map.Entry<String, ?> e : held.entrySet()) {
            Object v = e.getValue();
            if (dateKey.equals(dateKeyOf(e.getKey())) && v instanceof Long && !isDue((Long) v, now)) {
                open.add(taskIdOf(e.getKey()));
            }
        }
        return open;
    }

    /** Every Task of `dateKey` with a window, open or ended but not yet queued. */
    static Set<String> heldTaskIds(Map<String, ?> held, String dateKey) {
        Set<String> ids = new HashSet<>();
        for (String k : held.keySet()) {
            if (dateKey.equals(dateKeyOf(k))) ids.add(taskIdOf(k));
        }
        return ids;
    }

    /** When the earliest window still open at `now` ends (epoch ms), or -1 if none is. */
    static long nextDeadline(Map<String, ?> held, long now) {
        long next = -1;
        for (Object v : held.values()) {
            if (!(v instanceof Long) || isDue((Long) v, now)) continue;
            long end = (Long) v + WINDOW_MS;
            if (next < 0 || end < next) next = end;
        }
        return next;
    }

    private static long tickedAt(Map<String, ?> held, String key) {
        Object v = held.get(key);
        return v instanceof Long ? (Long) v : Long.MIN_VALUE;
    }
}
