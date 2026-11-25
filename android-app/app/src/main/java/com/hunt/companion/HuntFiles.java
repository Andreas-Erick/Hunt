package com.hunt.companion;

import android.util.AtomicFile;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The shell's file primitives, shared by MainActivity and the widget code (same process).
 * Every read and write of an app file holds {@link #LOCK}; writes are atomic (AtomicFile:
 * write aside, fsync, rename), so a reader never sees half a file.
 */
final class HuntFiles {
    private static final String TAG = "HuntFiles";

    /** Guards every file read/write (state, snapshot, URL and token files). */
    static final Object LOCK = new Object();

    /** The Widget Snapshot (ADR-0006): written only by the bridge, read by the widgets. */
    static final String WIDGET_SNAPSHOT_FILE = "hunt-widget-snapshot.json";

    /** The Pending Tick queue (ADR-0006): appended by the widget, drained by the page. See PendingTicks. */
    static final String PENDING_TICKS_FILE = "hunt-pending-ticks.json";

    /** The Reminder Plan (ADR-0007): written only by the bridge, read by the reminder alarm. See Reminders. */
    static final String REMINDER_PLAN_FILE = "hunt-reminder-plan.json";

    /** This phone's notification Snoozes (ADR-0007): written only by ReminderSnoozes, read by the page. */
    static final String REMINDER_SNOOZES_FILE = "hunt-reminder-snoozes.json";

    private HuntFiles() {
    }

    /**
     * Reads a whole text file through AtomicFile (which also recovers an interrupted write and
     * reads the legacy plain files as-is). Returns "" if missing or unreadable. Caller holds LOCK.
     */
    static String readText(File f) {
        try {
            return readExisting(f);
        } catch (IOException e) {
            Log.w(TAG, "Reading " + f.getName() + " failed", e);
            return "";
        }
    }

    /**
     * Reads a whole text file like {@link #readText}, but tells a read error apart from a missing
     * file: "" only when the file does not exist, an IOException when it exists but could not be
     * read. For a file whose content must never be replaced unseen (the Pending Tick queue).
     * Caller holds LOCK.
     */
    static String readExisting(File f) throws IOException {
        try {
            return new String(new AtomicFile(f).readFully(), StandardCharsets.UTF_8).trim();
        } catch (FileNotFoundException e) {
            if (f.exists()) throw e; // there, but not readable: not the same as missing
            return "";
        } catch (RuntimeException e) {
            throw new IOException("Reading " + f.getName() + " failed", e);
        }
    }

    /**
     * A file written from the newest value handed to it (coalescing): any number of
     * {@link #set} calls lead to at most one write of the last value, and a value identical to
     * what the file already holds is never rewritten. Used for the state file and the Widget
     * Snapshot. Instances live in static fields, so they outlive an Activity.
     */
    static final class CoalescedWrite {
        /** Newest value not yet handed to a write. Writers take it with getAndSet(null). */
        private final AtomicReference<String> pending = new AtomicReference<>();
        /** What the file currently holds, to skip identical rewrites. Guarded by LOCK. */
        private String lastWritten;

        /** Any thread: records the newest value; schedule {@link #flushTo} to write it. */
        void set(String text) {
            pending.set(text);
        }

        /** Caller holds LOCK: what the file held when read, unless something was written since. */
        void knownOnDisk(String text) {
            if (lastWritten == null) lastWritten = text;
        }

        /**
         * Writes the newest pending value to `f` under LOCK. Taking the value inside the lock
         * means the write that runs last always carries the newest value (last write wins).
         * Returns true when the file was written. If the write fails the value stays pending
         * (unless something newer arrived) for the next flush, and the error is thrown.
         */
        boolean flushTo(File f) throws IOException {
            synchronized (LOCK) {
                String text = pending.getAndSet(null);
                if (text == null || text.equals(lastWritten)) return false;
                try {
                    writeText(f, text);
                    lastWritten = text;
                    return true;
                } catch (IOException | RuntimeException e) {
                    pending.compareAndSet(null, text);
                    throw e;
                }
            }
        }
    }

    /** Replaces a file atomically. Caller holds LOCK. */
    static void writeText(File f, String text) throws IOException {
        AtomicFile af = new AtomicFile(f);
        FileOutputStream out = af.startWrite();
        try {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            af.finishWrite(out);
        } catch (IOException | RuntimeException e) {
            af.failWrite(out); // the previous file content stays intact
            throw e;
        }
    }
}
