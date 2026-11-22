package com.hunt.companion;

import android.util.AtomicFile;
import android.util.Log;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

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

    private HuntFiles() {
    }

    /**
     * Reads a whole text file through AtomicFile (which also recovers an interrupted write and
     * reads the legacy plain files as-is). Returns "" if missing or unreadable. Caller holds LOCK.
     */
    static String readText(File f) {
        try {
            return new String(new AtomicFile(f).readFully(), StandardCharsets.UTF_8).trim();
        } catch (FileNotFoundException e) {
            return "";
        } catch (IOException | RuntimeException e) {
            Log.w(TAG, "Reading " + f.getName() + " failed", e);
            return "";
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
