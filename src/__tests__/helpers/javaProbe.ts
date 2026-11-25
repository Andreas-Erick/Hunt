// Runs the Android shell's own Java classes on a JDK, so widget rules are tested as the real code
// rather than as a port. The classes are compiled unchanged (package com.hunt.companion) next to a
// probe whose `main` prints one result per line. Classes that touch android.util or org.json run
// against the small fakes in fixtures/javaStubs (a file-backed AtomicFile, a no-op Log and a
// minimal org.json); classes that need Context or RemoteViews cannot run here.
//
// Tests that use it are skipped when no JDK 11+ is found (Android Studio bundles one).
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { expect } from "vitest";

export const JAVA_DIR = path.resolve(__dirname, "..", "..", "..", "android-app", "app", "src", "main", "java", "com", "hunt", "companion");
const STUBS_DIR = path.resolve(__dirname, "..", "fixtures", "javaStubs");

function findJdkTool(tool: "java" | "javac"): string | null {
  const exe = process.platform === "win32" ? `${tool}.exe` : tool;
  const homes = [
    process.env.JAVA_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr"),
    "C:/Program Files/Android/Android Studio/jbr",
  ];
  const found = homes.flatMap((home) => (home ? [path.join(home, "bin", exe)] : [])).filter((p) => fs.existsSync(p));
  return [...found, tool].find((t) => spawnSync(t, ["-version"]).status === 0) ?? null;
}

const javaExe = findJdkTool("java");
const javacExe = javaExe ? findJdkTool("javac") : null;
/** True when probes can run; use with describe.skipIf(!hasJdk). */
export const hasJdk = Boolean(javaExe && javacExe);
// Without a JDK the Java suites skip, which is fine on a laptop. On CI it would hide untested
// Android code behind a green run, so fail loudly instead.
if (process.env.CI && !hasJdk) {
  throw new Error("CI has no JDK 11+ (java and javac): the Android Java suites would silently skip.");
}

function listJava(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listJava(p) : e.name.endsWith(".java") ? [p] : [];
  });
}

export interface ProbeOptions {
  /** Shell classes to compile, by file name in JAVA_DIR (e.g. "UndoWindow.java"). */
  classes: string[];
  /** Java statements for `main(String[] a) throws Exception`; print one result per line. */
  main: string;
  /** Extra imports for the probe (java.util.* and java.io.* are always there). */
  imports?: string[];
  /** Compile against fixtures/javaStubs (android.util.Log, android.util.AtomicFile, org.json). */
  stubs?: boolean;
}

/** Compiles the classes with a probe in their package, runs it, and returns its output lines. */
export function runJavaProbe({ classes, main, imports = [], stubs = false }: ProbeOptions): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-java-probe-"));
  try {
    const pkg = path.join(dir, "src", "com", "hunt", "companion");
    fs.mkdirSync(pkg, { recursive: true });
    const sources = classes.map((name) => {
      const to = path.join(pkg, name);
      fs.copyFileSync(path.join(JAVA_DIR, name), to);
      return to;
    });
    const probe = path.join(pkg, "Probe.java");
    fs.writeFileSync(
      probe,
      [
        "package com.hunt.companion;",
        "import java.io.*;",
        "import java.util.*;",
        ...imports.map((i) => `import ${i};`),
        "public class Probe {",
        "  public static void main(String[] a) throws Exception {",
        main,
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const all = [...sources, probe, ...(stubs ? listJava(STUBS_DIR) : [])];
    const out = path.join(dir, "out");
    const c = spawnSync(javacExe ?? "javac", ["-encoding", "UTF-8", "-nowarn", "-d", out, ...all], { encoding: "utf8" });
    expect(c.status, c.stderr || c.stdout).toBe(0);
    const r = spawnSync(javaExe ?? "java", ["-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-cp", out, "com.hunt.companion.Probe"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
