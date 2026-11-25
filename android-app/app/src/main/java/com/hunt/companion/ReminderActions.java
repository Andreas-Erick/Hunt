package com.hunt.companion;

import java.io.File;

/**
 * A reminder notification's actions (ADR-0007), as plain Java so the JDK probes run them. Done
 * and +1 append the Pending Tick the plan named (ADR-0006), which HuntCore applies when Hunt
 * next runs, or at once if it is running; nothing here writes Hunt data. Snooze stores the
 * reminder in the shell's own snooze file. {@link ReminderActionReceiver} wires them to the
 * notification and re-arms the alarm.
 */
final class ReminderActions {
    private ReminderActions() {
    }

    /**
     * Done or +1, tapped at `now`: queues the entry's tick for its day. REJECTED when the
     * notification offered no tick (or the entry is not a reminder). Any thread.
     */
    static PendingTicks.Queued tick(File dir, ReminderPlan.Entry entry, long now) {
        if (entry == null || entry.actionTick == null) return PendingTicks.Queued.REJECTED;
        String kind = TickKeys.PLUS_ONE.equals(entry.actionTick) ? TickKeys.PLUS_ONE : "";
        return PendingTicks.append(dir, entry.actionTaskId, entry.dateKey, now, kind);
    }

    /** Snooze, tapped at `now`: fires the reminder again 10 minutes on. False when not saved. Any thread. */
    static boolean snooze(File dir, ReminderPlan.Entry entry, long now) {
        return entry != null && ReminderSnoozes.add(dir, entry, now);
    }
}
