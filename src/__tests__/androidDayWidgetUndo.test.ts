// @vitest-environment node
//
// Day Widget Undo (#9): a tick first shows "✓ Done · Undo" for 4 seconds and is appended to the
// Pending Tick queue only 1.5 seconds after that window ends; Undo leaves no trace. The window rules are plain
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
    // t-b (tapped 4.5 s ago) no longer offers Undo but a late Undo could still arrive, so it is not due yet;
    // the next change is t-b becoming due (12 000 + 4 000 + 1 500), before t|odd's row ends at 19 000.
    expect(lines).toEqual(["t-a 2026-11-22", "t-c 2026-11-23", "[t|odd]", "[t-a, t-b, t|odd]", "17500", "-1"]);
  }, 60_000);

  it("an Undo that reaches the widget just after the row stopped offering it still finds the tick held", () => {
    // Undo tapped at 3.9 s arrives at 4.1-4.3 s (launcher, PendingIntent, trampoline). The row is
    // already hidden, but the tick is queued only LATE_UNDO_MS later, so that Undo still lands.
    const cases: Array<[number, number, string]> = [
      [10_000, 14_100, "true false"], // row no longer offers Undo, tick not queued
      [10_000, 15_499, "true false"],
      [10_000, 15_500, "true true"], // LATE_UNDO_MS over: queued
      [10_000, 5_000, "true true"], // clock set back further than the window: let it go
    ];
    const main = cases
      .map(([t, now]) => `System.out.println(UndoWindow.isDue(${t}L, ${now}L) + " " + UndoWindow.isQueueDue(${t}L, ${now}L));`)
      .join("\n");
    expect(runUndo(main)).toEqual(cases.map((c) => c[2]));
    const held = [
      "Map<String, Long> held = new HashMap<>();",
      'held.put(TickKeys.taskDay("t-late", "2026-11-22"), 10_000L);',
      'System.out.println(new TreeSet<>(UndoWindow.hiddenTaskIds(new HashSet<String>(), held, "2026-11-22", 14_200L)));',
      "System.out.println(UndoWindow.due(held, 14_200L).isEmpty());",
    ].join("\n");
    expect(runUndo(held)).toEqual(["[t-late]", "true"]);
  }, 60_000);

  it("queues ended windows in tap order with the tap time, and keeps any tick the queue refused for the next try", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(TickKeys.taskDay("t-a", "2026-11-22"), 10_000L);',
        'held.put(TickKeys.taskDay("t-b", "2026-11-22"), 11_000L);',
        'held.put(TickKeys.taskDay("t-c", "2026-11-22"), 15_000L); // still open at 16 500',
        "List<String> offered = new ArrayList<>();",
        "UndoWindow.Commit c = UndoWindow.commit(held, 16_500L, (taskId, dateKey, tickedAt, kind) -> {",
        '  offered.add(taskId + "@" + tickedAt);',
        '  return !taskId.equals("t-b"); // the queue refuses t-b (full, unreadable or a failed write)',
        "});",
        "System.out.println(offered);",
        'for (String k : c.closed) System.out.println("closed " + TickKeys.taskIdOf(k));',
        'System.out.println("heldBack " + c.heldBack);',
        "for (String k : c.closed) held.remove(k);",
        "// The refused tick is still there and is offered again, with its original tap time.",
        "offered.clear();",
        "UndoWindow.Commit again = UndoWindow.commit(held, 17_000L, (taskId, dateKey, tickedAt, kind) -> { offered.add(taskId + \"@\" + tickedAt); return true; });",
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

  it("the list hides the day's queued Tasks and ended windows not yet queued, but keeps open windows for Undo", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(TickKeys.taskDay("t-open", "2026-11-22"), 15_000L);',
        'held.put(TickKeys.taskDay("t-ended", "2026-11-22"), 10_000L);',
        'held.put(TickKeys.taskDay("t-other-day", "2026-11-23"), 10_000L);',
        'Set<String> queued = new HashSet<>(Arrays.asList(TickKeys.taskDay("t-queued", "2026-11-22"), TickKeys.taskDay("t-queued-tomorrow", "2026-11-23")));',
        'System.out.println(new TreeSet<>(UndoWindow.hiddenTaskIds(queued, held, "2026-11-22", 16_500L)));',
      ].join("\n"),
    );
    expect(lines).toEqual(["[t-ended, t-queued]"]);
  }, 60_000);

  it("a Count Habit row's +1 has its own window kind, which the queue gets with the tick", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'String plus = TickKeys.taskDay("t|jog", "2026-11-22", TickKeys.PLUS_ONE);',
        "held.put(plus, 10_000L);",
        'held.put(TickKeys.taskDay("t-done", "2026-11-22"), 11_000L);',
        'System.out.println(TickKeys.taskIdOf(plus) + " " + TickKeys.dateKeyOf(plus) + " [" + TickKeys.kindOf(plus) + "]");',
        'System.out.println("[" + TickKeys.kindOf(TickKeys.taskDay("t-done", "2026-11-22")) + "]");',
        "List<String> offered = new ArrayList<>();",
        'UndoWindow.commit(held, 17_000L, (taskId, dateKey, tickedAt, kind) -> { offered.add(taskId + "@" + tickedAt + "[" + kind + "]"); return true; });',
        "System.out.println(offered);",
      ].join("\n"),
    );
    expect(lines).toEqual(["t|jog 2026-11-22 [+1]", "[]", "[t|jog@10000[+1], t-done@11000[]]"]);
  }, 60_000);

  it("an Avoid Habit row's Slip has its own window kind and, once ended, hides its row like a done tick", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'String slip = TickKeys.taskDay("t|dry", "2026-11-22", TickKeys.SLIP);',
        "held.put(slip, 10_000L); // ended, not queued yet",
        'held.put(TickKeys.taskDay("t-sober", "2026-11-22", TickKeys.SLIP), 15_000L); // still open: "Slip · Undo"',
        'System.out.println(TickKeys.taskIdOf(slip) + " " + TickKeys.dateKeyOf(slip) + " [" + TickKeys.kindOf(slip) + "]");',
        'System.out.println(new TreeSet<>(UndoWindow.hiddenTaskIds(new HashSet<String>(), held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeSet<>(UndoWindow.openTaskIds(held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeMap<>(UndoWindow.pendingPlus(new HashMap<String, Integer>(), held, "2026-11-22", 16_500L)));',
        "List<String> offered = new ArrayList<>();",
        'UndoWindow.commit(held, 17_000L, (taskId, dateKey, tickedAt, kind) -> { offered.add(taskId + "[" + kind + "]"); return true; });',
        "System.out.println(offered);",
      ].join("\n"),
    );
    expect(lines).toEqual(["t|dry 2026-11-22 [slip]", "[t|dry]", "[t-sober]", "{}", "[t|dry[slip]]"]);
  }, 60_000);

  it("a +1 never hides its Count row: queued and ended +1s are counted for the row to show instead", () => {
    const lines = runUndo(
      [
        "Map<String, Long> held = new HashMap<>();",
        'held.put(TickKeys.taskDay("t-jog", "2026-11-22", TickKeys.PLUS_ONE), 10_000L); // ended, not queued yet',
        'held.put(TickKeys.taskDay("t-read", "2026-11-22", TickKeys.PLUS_ONE), 15_000L); // still open: "+1 · Undo"',
        "Map<String, Integer> queuedPlus = new HashMap<>();",
        'queuedPlus.put(TickKeys.taskDay("t-jog", "2026-11-22"), 2);',
        'queuedPlus.put(TickKeys.taskDay("t-jog", "2026-11-23"), 5);',
        'System.out.println(new TreeSet<>(UndoWindow.hiddenTaskIds(new HashSet<String>(), held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeSet<>(UndoWindow.openTaskIds(held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeMap<>(UndoWindow.pendingPlus(queuedPlus, held, "2026-11-22", 16_500L)));',
        'System.out.println(new TreeSet<>(UndoWindow.heldPlusTaskIds(held, "2026-11-22")));',
      ].join("\n"),
    );
    expect(lines).toEqual(["[]", "[t-read]", "{t-jog=3}", "[t-jog, t-read]"]);
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
    expect(code("DayWidgetTaps.java")).toMatch(/DayWidgetUndo\.open\(/);
  });

  it("windows live in private preferences, and end on an inexact alarm: no exact alarm or wake lock", () => {
    const prefs = [...undo.matchAll(/getSharedPreferences\(\s*(\w+)\s*,\s*([\w.]+)\s*\)/g)];
    expect(prefs.length).toBeGreaterThan(0);
    for (const [, , mode] of prefs) expect(mode).toBe("Context.MODE_PRIVATE");
    expect(undo).not.toMatch(/setExact|setAlarmClock|RTC_WAKEUP|setAndAllowWhileIdle/);
    // SCHEDULE_EXACT_ALARM is declared for reminders only (ADR-0007); the Undo window never uses it.
    expect(manifest).not.toMatch(/USE_EXACT_ALARM|WAKE_LOCK/);
    // The alarm is an explicit, immutable broadcast to the non-exported provider; nothing outside can send it.
    expect(undo).toMatch(/new Intent\(ctx, DayWidgetProvider\.class\)\s*\.setAction\(DayWidgetProvider\.ACTION_UNDO_DUE\)/);
    expect(undo).toMatch(/PendingIntent\.FLAG_IMMUTABLE/);
    expect(manifest).not.toContain("DAY_WIDGET_UNDO_DUE");
  });

  it("an Undo whose write fails is never queued by this process, retried, and reported to the user", () => {
    // Context-bound, so not runnable on the JDK: the guard pins the shape CODING_STANDARDS asks for.
    const undoBody = /static\s+boolean\s+undo\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(undo)?.[1] ?? "";
    expect(undoBody).toMatch(/saved\s*=\s*prefs\.edit\(\)\.remove\(key\)\.commit\(\)/);
    expect(undoBody).toMatch(/UNDONE\.add\(key\)/);
    expect(undoBody).toMatch(/return saved;/);
    // An Undo that finds its tick already queued is reported, never a silent success; a second
    // tap on an Undo that worked is not.
    expect(undoBody).toMatch(/if\s*\(!prefs\.contains\(key\)\s*&&\s*!UNDONE\.contains\(key\)\)\s*\{[\s\S]*?RECENTLY_UNDONE\.containsKey\(key\)[\s\S]*?return false;/);
    const commitDue = /static\s+UndoWindow\.Commit\s+commitDue\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(undo)?.[1] ?? "";
    expect(commitDue).toMatch(/retryUndone\(prefs\)/);
    expect(commitDue).toMatch(/UndoWindow\.commit\(withoutUndone\(/);
    const taps = code("DayWidgetTaps.java");
    expect(taps).toMatch(/Result\.UNDO_FAILED/);
    const tap = code("DayWidgetTapActivity.java");
    expect(tap).toMatch(/Result\.UNDO_FAILED\)\s*tell\(R\.string\.day_widget_undo_failed\)/);
    expect(tap).toMatch(/Result\.TICK_FAILED\)\s*tell\(R\.string\.day_widget_tap_failed\)/);
    // A crash in the tap is reported the same way, not only logged.
    expect(tap).toMatch(/catch\s*\(RuntimeException e\)\s*\{[^}]*result\s*=\s*DayWidgetTaps\.Result\.TICK_FAILED;/);
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
      // The Done mark (a drawn tick, not a glyph) sits where the row's ring was.
      expect(undoRow).toMatch(new RegExp(`android:background="@drawable/widget_done_${look}"`));
    }
    expect(read(RES, "values", "strings.xml")).toMatch(/name="day_widget_done">Done</);
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
    expect(onCreate).toMatch(/DayWidgetTaps\.onRowTap\(/);
    // Opening Hunt happens here, from the foreground trampoline, never from a receiver.
    expect(onCreate).toMatch(/startActivity\(WidgetSupport\.launchIntent\(this\)\)/);
  });
});
