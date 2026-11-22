package android.util;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.Set;

/**
 * Test fake of android.util.AtomicFile, file-backed like the real one: a missing file reads as
 * FileNotFoundException, a write goes to a side file and is renamed over the base on finish.
 * {@link #FAIL_READS} names files whose read fails with an IOException (a flaky disk), and
 * {@link #FAIL_WRITES} files whose write fails ({@link #FAIL_WRITE_PREFIXES}: by name prefix).
 */
public class AtomicFile {
    public static final Set<String> FAIL_READS = new HashSet<>();
    public static final Set<String> FAIL_WRITES = new HashSet<>();
    public static final Set<String> FAIL_WRITE_PREFIXES = new HashSet<>();
    private final File base;
    private final File next;

    public AtomicFile(File base) {
        this.base = base;
        this.next = new File(base.getPath() + ".new");
    }

    public byte[] readFully() throws IOException {
        if (FAIL_READS.contains(base.getName())) throw new IOException("simulated read error");
        try (FileInputStream in = new FileInputStream(base)) {
            return in.readAllBytes();
        }
    }

    public FileOutputStream startWrite() throws IOException {
        if (FAIL_WRITES.contains(base.getName())) throw new IOException("simulated write error");
        for (String prefix : FAIL_WRITE_PREFIXES) {
            if (base.getName().startsWith(prefix)) throw new IOException("simulated write error");
        }
        return new FileOutputStream(next);
    }

    public void finishWrite(FileOutputStream out) throws IOException {
        out.close();
        Files.move(next.toPath(), base.toPath(), StandardCopyOption.REPLACE_EXISTING);
    }

    public void failWrite(FileOutputStream out) {
        try {
            out.close();
        } catch (IOException ignored) {
            // best effort, like the real one
        }
        next.delete();
    }
}
