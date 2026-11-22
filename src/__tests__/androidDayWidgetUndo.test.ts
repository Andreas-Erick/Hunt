// @vitest-environment node
//
// Day Widget Undo (#9): a tick first shows "✓ Done · Undo" for 4 seconds and is appended to the
// Pending Tick queue only when that window ends; Undo leaves no trace. The window rules are plain
// Java (UndoWindow.java, TickKeys.java), so they run here on the JDK as the real code. The static
// guards keep only what a probe cannot show: ADR-0006's boundaries, no new permission, the
// non-exported intents and 48dp targets.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasJdk, JAVA_DIR, runJavaProbe } from "./helpers/javaProbe";

const MAIN = path.resolve(JAVA_DIR, "..", "..", "..", "..");
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

const runUndo = (main: string) => runJavaProbe({ classes: ["UndoWindow.java", "TickKeys.java"], main });

describe.skipIf(!hasJdk)("UndoWindow, run on the JDK", () => {
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
        'held.put(TickKeys.taskDay("t-b", "2026-11-22"), 12_000L);',
        'held.put(TickKeys.taskDay("t-a", "2026-11-22"), 10_000L);',
        'held.put(TickKeys.taskDay("t|odd", "2026-11-22"), 15_000L);',
        'held.put(TickKeys.taskDay("t-c", "2026-11-23"), 11_000L);',
        "List<String> due = UndoWindow.due(held, 16_500L);",
        'for (String k : due) System.out.println(TickKeys.taskIdOf(k) + " " + TickKeys.dateKeyOf(k));',
        'System.out.println(new TreeSet<>(UndoWindow.openTaskIds(held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeSet<>(UndoWindow.heldTaskIds(held, "2026-11-22")));',
        "System.out.println(UndoWindow.nextDeadline(held, 16_500L));",
        "System.out.println(UndoWindow.nextDeadline(new HashMap<String, Long>(), 16_500L));",
      ].join("\n"),
    );
    expect(lines).toEqual(["t-a 2026-11-22", "t-c 2026-11-23", "t-b 2026-11-22", "[t|odd]", "[t-a, t-b, t|odd]", "19000", "-1"]);
  }, 60_000);

  it("queues ended windows in tap order with the tap time, and keeps any tick the queue refused for the next try", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(TickKeys.taskDay("t-a", "2026-11-22"), 10_000L);',
        'held.put(TickKeys.taskDay("t-b", "2026-11-22"), 11_000L);',
        'held.put(TickKeys.taskDay("t-c", "2026-11-22"), 15_000L); // still open at 16 500',
        "List<String> offered = new ArrayList<>();",
        "UndoWindow.Commit c = UndoWindow.commit(held, 16_500L, (taskId, dateKey, tickedAt) -> {",
        '  offered.add(taskId + "@" + tickedAt);',
        '  return !taskId.equals("t-b"); // the queue refuses t-b (full, unreadable or a failed write)',
        "});",
        "System.out.println(offered);",
        'for (String k : c.closed) System.out.println("closed " + TickKeys.taskIdOf(k));',
        'System.out.println("heldBack " + c.heldBack);',
        "for (String k : c.closed) held.remove(k);",
        "// The refused tick is still there and is offered again, with its original tap time.",
        "offered.clear();",
        "UndoWindow.Commit again = UndoWindow.commit(held, 17_000L, (taskId, dateKey, tickedAt) -> { offered.add(taskId + \"@\" + tickedAt); return true; });",
        'System.out.println(offered + " heldBack " + again.heldBack);',
      ].join("\n"),
    );
    expect(lines).toEqual([
      "[t-a@10000, t-b@11000]",
      "closed t-a",
      "heldBack 1",
      "[t-b@11000] heldBack 0",
    ]);
  }, 60_000);

  it("the list hides queued Tasks and ended windows not yet queued, but keeps open windows for Undo", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(TickKeys.taskDay("t-open", "2026-11-22"), 15_000L);',
        'held.put(TickKeys.taskDay("t-ended", "2026-11-22"), 10_000L);',
        'held.put(TickKeys.taskDay("t-other-day", "2026-11-23"), 10_000L);',
        'Set<String> queued = new HashSet<>(Arrays.asList("t-queued"));',
        'System.out.println(new TreeSet<>(UndoWindow.hiddenTaskIds(queued, held, "2026-11-22", 16_500L)));',
      ].join("\n"),
    );
    expect(lines).toEqual(["[t-ended, t-queued]"]);
  }, 60_000);
});

describe("Day Widget Undo window (#9): boundaries", () => {
  const provider = code("DayWidgetProvider.java");
  const undo = code("DayWidgetUndo.java");
  const manifest = read(MAIN, "AndroidManifest.xml");

  it("the window rules are plain Java: no Android types, no files", () => {
    for (const file of ["UndoWindow.java", "TickKeys.java"]) {
      const rule = code(file);
      expect(rule, file).not.toMatch(/^import android\./m);
      expect(rule, file).not.toMatch(/\bFile\b|SharedPreferences|PendingTicks/);
    }
  });

  it("only the end of a window appends a Pending Tick (ADR-0006): a tap opens one, Undo leaves the queue alone", () => {
    const widgetFiles = fs.readdirSync(JAVA_DIR).filter((f) => f.endsWith(".java") && f !== "DayWidgetUndo.java");
    for (const file of widgetFiles) expect(code(file), file).not.toMatch(/PendingTicks\.append\(/);
    expect(undo.match(/PendingTicks\.append\(/g) ?? []).toHaveLength(1);
    expect(provider).toMatch(/DayWidgetUndo\.open\(/);
  });

  it("windows live in private preferences, and end on an inexact alarm: no exact-alarm or wake permission", () => {
    const prefs = [...undo.matchAll(/getSharedPreferences\(\s*(\w+)\s*,\s*([\w.]+)\s*\)/g)];
    expect(prefs.length).toBeGreaterThan(0);
    for (const [, , mode] of prefs) expect(mode).toBe("Context.MODE_PRIVATE");
    expect(undo).not.toMatch(/setExact|setAlarmClock|RTC_WAKEUP|setAndAllowWhileIdle/);
    expect(manifest).not.toMatch(/SCHEDULE_EXACT_ALARM|USE_EXACT_ALARM|WAKE_LOCK/);
    // The alarm is an explicit, immutable broadcast to the non-exported provider; nothing outside can send it.
    expect(undo).toMatch(/new Intent\(ctx, DayWidgetProvider\.class\)\s*\.setAction\(DayWidgetProvider\.ACTION_UNDO_DUE\)/);
    expect(undo).toMatch(/PendingIntent\.FLAG_IMMUTABLE/);
    expect(manifest).not.toContain("DAY_WIDGET_UNDO_DUE");
  });

  it("a window the timer missed is still ended by every redraw and by the page's queue read (ADR-0006)", () => {
    const refresh = /static\s+void\s+refreshAll\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(provider)?.[1] ?? "";
    expect(refresh).toMatch(/DayWidgetUndo\.commitDue\(/);
    expect(code("MainActivity.java")).toMatch(/DayWidgetUndo\.commitDue\(/);
  });

  it("a row in its window keeps the row height, with Undo a 48dp target at the far end", () => {
    for (const look of ["neon", "dawn"]) {
      const undoRow = read(RES, "layout", `widget_day_row_undo_${look}.xml`);
      const taskRow = read(RES, "layout", `widget_day_row_${look}.xml`);
      const rowRoot = /<LinearLayout\b[^>]*>/.exec(undoRow)?.[0] ?? "";
      expect(attr(rowRoot, "layout_height")).toBe(attr(/<LinearLayout\b[^>]*>/.exec(taskRow)?.[0] ?? "", "layout_height"));
      const target = tagOf(undoRow, "widget_row_undo");
      expect(dp(target, "minHeight"), look).toBeGreaterThanOrEqual(48);
      expect(dp(target, "minWidth"), look).toBeGreaterThanOrEqual(48);
      expect(attr(target, "contentDescription")).toBe("@string/day_widget_undo_label");
      // Undo sits at the end of its row; the next row's tick target sits at the start of its row.
      const ids = [...undoRow.matchAll(/android:id="@\+id\/(\w+)"/g)].map((m) => m[1]);
      expect(ids[ids.length - 1]).toBe("widget_row_undo");
    }
    expect(read(RES, "values", "strings.xml")).toMatch(/name="day_widget_done">✓ Done</);
  });
});

describe("Day Widget row taps go through a no-UI trampoline activity (background activity launch)", () => {
  const provider = code("DayWidgetProvider.java");
  const tap = code("DayWidgetTapActivity.java");
  const manifest = read(MAIN, "AndroidManifest.xml");
  const receivers = fs.readdirSync(JAVA_DIR).filter((f) => /Provider\.java$|Support\.java$|Undo\.java$/.test(f));

  it("the list's template is an activity PendingIntent to the trampoline; no receiver starts an activity", () => {
    const template = /PendingIntent\s+rowTemplate\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(provider)?.[1] ?? "";
    expect(template).toMatch(/new Intent\(ctx, DayWidgetTapActivity\.class\)/);
    expect(template).toMatch(/PendingIntent\.getActivity\(/);
    for (const file of receivers) expect(code(file), file).not.toMatch(/startActivity\(/);
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
    expect(onCreate).toMatch(/startActivity\(WidgetSupport\.launchIntent\(this\)\)/);
  });
});
