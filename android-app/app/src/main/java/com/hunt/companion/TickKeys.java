package com.hunt.companion;

/**
 * Identity keys of a Day Widget tick, in one place. A tick names a Task on a day: one Undo
 * window and one queued Pending Tick per Task and day ({@link #taskDay}). An acknowledgement
 * also matches the tap time ({@link #ack}), so a tick queued again after the page read the
 * queue survives the ack. The phone page keys its own not-yet-removed acks the same way
 * (pendingTickKey in hunt-mobile.html). Plain Java, so the test suite runs it on the JDK.
 */
final class TickKeys {
    private TickKeys() {
    }

    /** "dateKey|taskId". The date key (YYYY-MM-DD) never holds '|', the Task id may. */
    static String taskDay(String taskId, String dateKey) {
        return dateKey + "|" + taskId;
    }

    static String dateKeyOf(String taskDayKey) {
        int bar = taskDayKey.indexOf('|');
        return bar < 0 ? "" : taskDayKey.substring(0, bar);
    }

    static String taskIdOf(String taskDayKey) {
        int bar = taskDayKey.indexOf('|');
        return bar < 0 ? taskDayKey : taskDayKey.substring(bar + 1);
    }

    /** "taskId|dateKey|tickedAt": one queued entry exactly as the page read it. */
    static String ack(String taskId, String dateKey, long tickedAt) {
        return taskId + "|" + dateKey + "|" + tickedAt;
    }
}
