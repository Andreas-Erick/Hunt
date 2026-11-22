// @vitest-environment node
//
// Day Widget Undo (#9): a tick first shows "✓ Done · Undo" for 4 seconds and is appended to the
// Pending Tick queue only when that window ends; Undo leaves no trace. The window rule is plain
// Java (UndoWindow.java, no Android imports), so it runs here on the JDK as the real code. The
// static guards read the manifest, layouts and sources (the Java cannot run under vitest).
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const MAIN = path.resolve(__dirname, "..", "..", "android-app", "app", "src", "main");
const JAVA_DIR = path.join(MAIN, "java", "com", "hunt", "companion");
const RES = path.join(MAIN, "res");
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");
/** Java with block and line comments removed (good enough for these sources: no "//" in literals). */
const code = (file: string): string =>
  read(JAVA_DIR, file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");
const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`android:${name}="([^"]*)"`).exec(xml)?.[1];
const tagOf = (xml: string, id: string): string =>
  new RegExp(`<\\w+\\b[^>]*android:id="@\\+id/${id}"[^>]*>`).exec(xml)?.[0] ?? "";
const dp = (tag: string, name: string): number => Number(/^(\d+)dp$/.exec(attr(tag, name) ?? "")?.[1] ?? 0);

const javaExe = ((): string | null => {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const homes = [
    process.env.JAVA_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr"),
    "C:/Program Files/Android/Android Studio/jbr",
  ];
  const found = homes.flatMap((home) => (home ? [path.join(home, "bin", exe)] : [])).filter((p) => fs.existsSync(p));
  return [...found, "java"].find((java) => spawnSync(java, ["--version"]).status === 0) ?? null;
})();

/** Runs `main` (Java statements printing lines) against UndoWindow; returns the lines. */
function runUndo(main: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-undo-"));
  try {
    const source = read(JAVA_DIR, "UndoWindow.java").replace(/^package [\w.]+;/m, "");
    const imports = source.match(/^import [\w.]+;$/gm) ?? [];
    const rule = source.replace(/^import [\w.]+;$/gm, "");
    const file = path.join(dir, "UndoProbe.java");
    const probe =
      `${imports.join("\n")}\nimport java.util.*;\npublic class UndoProbe {\n` +
      `  public static void main(String[] a) {\n${main}\n  }\n}\n${rule}`;
    fs.writeFileSync(file, probe, "utf8");
    const r = spawnSync(javaExe ?? "java", ["-Dfile.encoding=UTF-8", file], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim().split(/\r?\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!javaExe)("UndoWindow, run on the JDK", () => {
  it("holds a tick for 4 seconds after the tap, then it is due (a clock set back never holds it forever)", () => {
    // [tickedAt, now] -> due?
    const cases: Array<[number, number, string]> = [
      [10_000, 10_000, "false"],
      [10_000, 13_999, "false"],
      [10_000, 14_000, "true"],
      [10_000, 60_000, "true"],
      [10_000, 9_000, "false"], // clock nudged back a second: still in the window
      [10_000, 5_000, "true"], // clock set back further than the window: let it go
    ];
    const main = cases.map(([t, now]) => `System.out.println(UndoWindow.isDue(${t}L, ${now}L));`).join("\n");
    expect(runUndo(main)).toEqual(cases.map((c) => c[2]));
  }, 60_000);

  it("keeps a separate window per Task and day: due ones in tap order, open ones per day, next deadline", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(UndoWindow.key("t-b", "2026-11-22"), 12_000L);',
        'held.put(UndoWindow.key("t-a", "2026-11-22"), 10_000L);',
        'held.put(UndoWindow.key("t|odd", "2026-11-22"), 15_000L);',
        'held.put(UndoWindow.key("t-c", "2026-11-23"), 11_000L);',
        "List<String> due = UndoWindow.due(held, 16_500L);",
        "for (String k : due) System.out.println(UndoWindow.taskIdOf(k) + \" \" + UndoWindow.dateKeyOf(k));",
        'System.out.println(new TreeSet<>(UndoWindow.openTaskIds(held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeSet<>(UndoWindow.heldTaskIds(held, "2026-11-22")));',
        "System.out.println(UndoWindow.nextDeadline(held, 16_500L));",
        "System.out.println(UndoWindow.nextDeadline(new HashMap<String, Long>(), 16_500L));",
      ].join("\n"),
    );
    expect(lines).toEqual([
      "t-a 2026-11-22",
      "t-c 2026-11-23",
      "t-b 2026-11-22",
      "[t|odd]",
      "[t-a, t-b, t|odd]",
      "19000",
      "-1",
    ]);
  }, 60_000);
});

describe("Day Widget Undo window (#9)", () => {
  const provider = code("DayWidgetProvider.java");
  const undo = code("DayWidgetUndo.java");
  const service = code("DayWidgetService.java");
  const undoRow = read(RES, "layout", "widget_day_row_undo_neon.xml");
  const taskRow = read(RES, "layout", "widget_day_row_neon.xml");
  const manifest = read(MAIN, "AndroidManifest.xml");

  it("the window rule is plain Java: no Android types, no files", () => {
    const rule = code("UndoWindow.java");
    expect(rule).not.toMatch(/^import android\./m);
    expect(rule).not.toMatch(/\bFile\b|SharedPreferences|PendingTicks/);
  });

  it("a tick opens a window instead of queueing; only the window's end appends the Pending Tick", () => {
    const tick = /static\s+void\s+tick\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(provider)?.[1] ?? "";
    expect(tick).toMatch(/DayWidgetUndo\.open\(/);
    expect(tick).not.toMatch(/PendingTicks\.append/);
    expect(provider).not.toMatch(/PendingTicks\.append/);
    const appends = undo.match(/PendingTicks\.append\(/g) ?? [];
    expect(appends).toHaveLength(1);
    // The append carries the original tap time, stored when the window opened.
    expect(undo).toMatch(/PendingTicks\.append\([^;]*tickedAt\)/);
  });

  it("the window survives the process: private preferences written synchronously, plus a timer and an inexact alarm", () => {
    const prefs = [...undo.matchAll(/getSharedPreferences\(\s*(\w+)\s*,\s*([\w.]+)\s*\)/g)];
    expect(prefs.length).toBeGreaterThan(0);
    for (const [, name, mode] of prefs) {
      expect(name).toBe("UNDO_PREFS");
      expect(mode).toBe("Context.MODE_PRIVATE");
    }
    expect(undo).toMatch(/\.commit\(\)/);
    expect(undo).not.toMatch(/\.apply\(\)/);
    // One main-thread timer, replaced on every reschedule (a token, not a pile of callbacks).
    expect(undo).toMatch(/removeCallbacksAndMessages\(TIMER\)/);
    expect(undo).toMatch(/postAtTime\([^;]*TIMER/);
    expect(undo).toMatch(/alarms\.set\(AlarmManager\.RTC,/);
    expect(undo).not.toMatch(/setExact|setAlarmClock|RTC_WAKEUP|setAndAllowWhileIdle/);
    // The alarm is an explicit, immutable broadcast to the non-exported provider.
    expect(undo).toMatch(/new Intent\(ctx, DayWidgetProvider\.class\)\s*\.setAction\(DayWidgetProvider\.ACTION_UNDO_DUE\)/);
    expect(undo).toMatch(/PendingIntent\.FLAG_IMMUTABLE/);
    expect(provider).toMatch(/ACTION_UNDO_DUE\.equals\(action\)/);
    expect(manifest).not.toContain("DAY_WIDGET_UNDO_DUE");
  });

  it("every redraw first appends what is due, so a late timer only delays the queue, never loses a tick", () => {
    const refresh = /static\s+void\s+refreshAll\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(provider)?.[1] ?? "";
    expect(refresh).toMatch(/DayWidgetUndo\.commitDue\(/);
    expect(provider).toMatch(/public\s+void\s+onUpdate\([^)]*\)\s*\{[^}]*DayWidgetUndo\.commitDue\(/);
    // The page's drain also closes windows that ended while the process was gone.
    expect(code("MainActivity.java")).toMatch(/DayWidgetUndo\.commitDue\(/);
  });

  it("Undo removes the window and nothing else", () => {
    const body = /static\s+void\s+undo\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(undo)?.[1] ?? "";
    expect(body).toMatch(/\.remove\(/);
    expect(body).not.toMatch(/PendingTicks/);
  });

  it("a row in its window draws as '✓ Done · Undo' at the same height, Undo a 48dp target at the far end", () => {
    expect(service).toMatch(/R\.layout\.widget_day_row_undo_neon/);
    expect(service).toMatch(/getViewTypeCount\(\)\s*\{\s*return\s+2;/);
    expect(service).toMatch(/setOnClickFillInIntent\(\s*R\.id\.widget_row_undo\s*,\s*rowTap\(DayWidgetProvider\.ROW_UNDO/);
    const rowRoot = /<LinearLayout\b[^>]*>/.exec(undoRow)?.[0] ?? "";
    expect(attr(rowRoot, "layout_height")).toBe(attr(/<LinearLayout\b[^>]*>/.exec(taskRow)?.[0] ?? "", "layout_height"));
    const target = tagOf(undoRow, "widget_row_undo");
    expect(dp(target, "minHeight")).toBeGreaterThanOrEqual(48);
    expect(dp(target, "minWidth")).toBeGreaterThanOrEqual(48);
    expect(attr(target, "contentDescription")).toBe("@string/day_widget_undo_label");
    // Undo sits at the end of its row; the next row's tick target sits at the start of its row.
    const ids = [...undoRow.matchAll(/android:id="@\+id\/(\w+)"/g)].map((m) => m[1]);
    expect(ids[ids.length - 1]).toBe("widget_row_undo");
    expect(ids.indexOf("widget_row_done")).toBeGreaterThan(0);
    expect(read(RES, "values", "strings.xml")).toMatch(/name="day_widget_done">\u2713 Done</);
  });
});

describe("Day Widget row taps go through a no-UI trampoline activity (background activity launch)", () => {
  const provider = code("DayWidgetProvider.java");
  const tap = code("DayWidgetTapActivity.java");
  const manifest = read(MAIN, "AndroidManifest.xml");

  it("the list's template is an activity PendingIntent to the trampoline, never a broadcast that starts an activity", () => {
    const template = /PendingIntent\s+rowTemplate\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(provider)?.[1] ?? "";
    expect(template).toMatch(/new Intent\(ctx, DayWidgetTapActivity\.class\)/);
    expect(template).toMatch(/PendingIntent\.getActivity\(/);
    expect(provider).not.toMatch(/startActivity\(/);
    expect(code("StatsWidgetProvider.java")).not.toMatch(/startActivity\(/);
  });

  it("the trampoline is not exported, shows nothing, leaves no trace in Recents and finishes at once", () => {
    const activity = /<activity\b[^>]*android:name="\.DayWidgetTapActivity"[^>]*>/.exec(manifest)?.[0] ?? "";
    expect(activity, "DayWidgetTapActivity in the manifest").not.toBe("");
    expect(attr(activity, "exported")).toBe("false");
    expect(attr(activity, "theme")).toBe("@android:style/Theme.NoDisplay");
    expect(attr(activity, "excludeFromRecents")).toBe("true");
    expect(attr(activity, "noHistory")).toBe("true");
    expect(attr(activity, "taskAffinity")).toBe("");
    expect(/<activity\b[^>]*android:name="\.DayWidgetTapActivity"[^>]*\/>/.test(manifest), "no intent filter").toBe(true);
    const onCreate = /void\s+onCreate\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(tap)?.[1] ?? "";
    expect(onCreate).toMatch(/finish\(\)/);
    expect(onCreate).toMatch(/DayWidgetProvider\.onRowTap\(/);
    // Opening Hunt happens here, from the foreground trampoline, never from a receiver.
    expect(onCreate).toMatch(/startActivity\(DayWidgetProvider\.launchIntent\(this\)\)/);
  });
});
