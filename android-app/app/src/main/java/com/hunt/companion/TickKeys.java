package com.hunt.companion;

/**
 * Identity keys of a Day Widget tick, in one place. A tick names a Task on a day: one Undo
 * window and one queued Pending Tick per Task and day ({@link #taskDay}). A Count Habit row's
 * tap is a "+1" ({@link #PLUS_ONE}) rather than a done tick: its window key carries that kind,
 * so the queue gets it with the tick, and the queue holds one entry per tap. An acknowledgement
 * also matches the tap time ({@link #ack}), so a tick queued again after the page read the
 * queue survives the ack. The phone page keys its own not-yet-removed acks the same way
 * (pendingTickKey in hunt-mobile.html). Plain Java, so the test suite runs it on the JDK.
 */
final class TickKeys {
    /** The kind of a Count Habit row's tick: one more (the snapshot row's habitKind is "count"). */
    static final String PLUS_ONE = "+1";

    private TickKeys() {
    }

    /** "dateKey|taskId". The date key (YYYY-MM-DD) never holds '|' or '#', the Task id may. */
    static String taskDay(String taskId, String dateKey) {
        return dateKey + "|" + taskId;
    }

    /**
     * A window key of the given tick kind: {@link #taskDay} for a done tick (kind ""), else
     * "dateKey#kind|taskId". {@link #dateKeyOf}, {@link #taskIdOf} and {@link #kindOf} read both.
     */
    static String taskDay(String taskId, String dateKey, String kind) {
        return kind == null || kind.isEmpty() ? taskDay(taskId, dateKey) : dateKey + "#" + kind + "|" + taskId;
    }

    static String dateKeyOf(String taskDayKey) {
        int bar = taskDayKey.indexOf('|');
        if (bar < 0) return "";
        String head = taskDayKey.substring(0, bar);
        int hash = head.indexOf('#');
        return hash < 0 ? head : head.substring(0, hash);
    }

    static String taskIdOf(String taskDayKey) {
        int bar = taskDayKey.indexOf('|');
        return bar < 0 ? taskDayKey : taskDayKey.substring(bar + 1);
    }

    /** The tick kind of a window key: "" for a done tick, {@link #PLUS_ONE} for a Count +1. */
    static String kindOf(String taskDayKey) {
        int bar = taskDayKey.indexOf('|');
        String head = bar < 0 ? "" : taskDayKey.substring(0, bar);
        int hash = head.indexOf('#');
        return hash < 0 ? "" : head.substring(hash + 1);
    }

    /** "taskId|dateKey|tickedAt": one queued entry exactly as the page read it. */
    static String ack(String taskId, String dateKey, long tickedAt) {
        return taskId + "|" + dateKey + "|" + tickedAt;
    }
}
