// @vitest-environment node
//
// Static guards for the Stats Widget (GLOSSARY.md, ADR-0006). The Java code cannot run under
// vitest, so these read the manifest, provider XML, layouts and sources. The Day Widget's own
// guards (48dp targets for every widget click id, no file writes) live in androidShell.test.ts.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasJdk, runJavaProbe } from "./helpers/javaProbe";

const MAIN = path.resolve(__dirname, "..", "..", "android-app", "app", "src", "main");
const JAVA_DIR = path.join(MAIN, "java", "com", "hunt", "companion");
const RES = path.join(MAIN, "res");
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");
/** Java with block and line comments removed (good enough for these sources: no "//" in literals). */
const code = (file: string): string =>
  read(JAVA_DIR, file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

const manifest = read(MAIN, "AndroidManifest.xml");
const info = read(RES, "xml", "stats_widget_info.xml");
const provider = code("StatsWidgetProvider.java");
/** What both widgets share: the snapshot read, the "Open Hunt" message and the midnight alarm. */
const support = code("WidgetSupport.java");
const layout = read(RES, "layout", "widget_stats_neon.xml");
const strings = read(RES, "values", "strings.xml");
const attr = (xml: string, name: string): string | undefined =>
  new RegExp(`android:${name}="([^"]*)"`).exec(xml)?.[1];
const tagOf = (xml: string, id: string): string =>
  new RegExp(`<\\w+\\b[^>]*android:id="@\\+id/${id}"[^>]*>`).exec(xml)?.[0] ?? "";

describe("Stats Widget (ADR-0006)", () => {
  it("declares a second widget receiver, not exported, with its provider XML", () => {
    const receiver = /<receiver\b[^>]*android:name="\.StatsWidgetProvider"[^>]*>([\s\S]*?)<\/receiver>/.exec(manifest);
    expect(receiver, "StatsWidgetProvider receiver").not.toBeNull();
    expect(receiver![0]).toMatch(/android:exported="false"/);
    for (const action of [
      "android.appwidget.action.APPWIDGET_UPDATE",
      "android.intent.action.TIME_SET",
      "android.intent.action.TIMEZONE_CHANGED",
      "android.intent.action.MY_PACKAGE_REPLACED",
    ]) {
      expect(receiver![1]).toContain(`<action android:name="${action}" />`);
    }
    expect(receiver![1]).toMatch(
      /<meta-data\s+android:name="android\.appwidget\.provider"\s+android:resource="@xml\/stats_widget_info"/,
    );
  });

  it("is resizable both ways, never wakes the phone on a timer, and defaults to 3x2", () => {
    expect(attr(info, "resizeMode")).toBe("horizontal|vertical");
    expect(attr(info, "updatePeriodMillis")).toBe("0");
    expect(attr(info, "targetCellWidth")).toBe("3");
    expect(attr(info, "targetCellHeight")).toBe("2");
    const dp = (name: string) => Number(/^(\d+)dp$/.exec(attr(info, name) ?? "")?.[1]);
    expect(dp("minResizeWidth")).toBeLessThanOrEqual(dp("minWidth"));
    expect(dp("minResizeHeight")).toBeLessThanOrEqual(dp("minHeight"));
    expect(attr(info, "description")).toBe("@string/stats_widget_description");
  });

  it("redraws when resized, when the snapshot changes and just after midnight (inexact alarm)", () => {
    expect(provider).toMatch(/public\s+void\s+onAppWidgetOptionsChanged\(/);
    expect(provider).toMatch(/OPTION_APPWIDGET_MIN_HEIGHT/);
    expect(provider).toMatch(/OPTION_APPWIDGET_MAX_HEIGHT/);
    expect(provider).toMatch(/WidgetSupport\.armMidnightAlarm\(ctx, StatsWidgetProvider\.class/);
    expect(support).toMatch(/alarms\.set\(AlarmManager\.RTC,/);
    for (const src of [provider, support]) expect(src).not.toMatch(/setExact|setAlarmClock|RTC_WAKEUP/);
    const main = code("MainActivity.java");
    expect(main).toMatch(/StatsWidgetProvider\.refreshAll\(appContext\)/);
  });

  it("only reads: never writes a file or the state", () => {
    expect(provider).not.toMatch(/hunt-mobile-state\.json|STATE_FILE/);
    expect(provider).not.toMatch(/\bwriteText\s*\(|FileOutputStream|startWrite/);
    expect(support).not.toMatch(/\bwriteText\s*\(|FileOutputStream|startWrite/);
    expect(provider).toMatch(/WidgetSupport\.readSnapshot\(/);
    expect(support).toMatch(/HuntFiles\.WIDGET_SNAPSHOT_FILE/);
  });

  it("has copy for every state: no data, stale, no Quests and hidden streaks", () => {
    expect(strings).toMatch(/name="stats_widget_no_quests">Set up a Quest in Hunt</);
    expect(strings).toMatch(/name="stats_widget_more">\+%1\$d more</);
    expect(provider).toMatch(/WidgetSupport\.messageViews\(/);
    expect(support).toMatch(/R\.string\.day_widget_get_started/);
    expect(support).toMatch(/R\.string\.day_widget_refresh/);
    expect(attr(tagOf(layout, "widget_stats_no_quests"), "text")).toBe("@string/stats_widget_no_quests");
    expect(provider).toMatch(/R\.id\.widget_stats_no_quests/);
    expect(provider).toMatch(/R\.string\.stats_widget_more/);
  });

  it("draws progress bars, tabular figures and one-line ellipsized names", () => {
    const bars = layout.match(/<ProgressBar\b[^>]*>/g) ?? [];
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const bar of bars) expect(bar).toMatch(/android:progressDrawable="@drawable\/widget_progress_neon"/);
    const numberIds = [...layout.matchAll(/android:id="@\+id\/(widget_stats_(?:focus|q\d_hours|s\d_days))"/g)].map((m) => m[1]);
    expect(numberIds).toContain("widget_stats_focus");
    for (const id of numberIds) expect(attr(tagOf(layout, id), "fontFamily"), id).toBe("monospace");
    const names = [...layout.matchAll(/android:id="@\+id\/(widget_stats_(?:q\d_code|s\d_title))"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const id of names) {
      const tag = tagOf(layout, id);
      expect(attr(tag, "maxLines"), id).toBe("1");
      expect(attr(tag, "ellipsize"), id).toBe("end");
    }
  });

  it("uses look-neutral view ids, so a Dawn layout can reuse them", () => {
    const ids = [...layout.matchAll(/android:id="@\+id\/([\w]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).not.toMatch(/neon|dawn/);
  });

  it("build-apk.sh refuses an APK without the Stats Widget resources", () => {
    const script = read(MAIN, "..", "..", "..", "build-apk.sh");
    const list = /for e in ([^;]*); do\s*\n\s*grep -qx "\$e" <<<"\$ENTRIES"/.exec(script)?.[1] ?? "";
    for (const entry of ["res/xml/stats_widget_info.xml", "res/layout/widget_stats_neon.xml"]) {
      expect(list.split(/\s+/), entry).toContain(entry);
    }
  });
});

// StatsWidgetFit is plain Java (no Android imports), so its row budget and number formats run
// here on the JDK as the real code. Skipped when no JDK 11+ is found (Android Studio bundles one).
const runFit = (main: string) => runJavaProbe({ classes: ["StatsWidgetFit.java"], main });

describe.skipIf(!hasJdk)("StatsWidgetFit, run on the JDK", () => {
  it("shows more streaks at larger sizes and counts the rest as +N more", () => {
    // [height dp, quests, streaks] -> "questRows questsMore streakRows streaksMore"
    const cases: Array<[number, number, number, string]> = [
      [110, 3, 5, "1 2 0 5"], // 2x2 minimum: one Quest row, every streak behind "+5 more"
      [180, 3, 5, "3 0 1 4"],
      [280, 3, 5, "3 0 5 0"], // tall: every streak fits
      [280, 3, 12, "3 0 6 6"],
      [600, 3, 12, "3 0 8 4"], // never more rows than the layout holds
      [600, 5, 0, "3 2 0 0"], // more Quests than rows: "+2 more" under them
      [180, 0, 6, "0 0 4 2"], // no Quests: the "Set up a Quest" line takes one row
      [180, 2, 0, "2 0 0 0"],
    ];
    const main = cases
      .map(
        ([h, q, s]) =>
          `    { StatsWidgetFit f = StatsWidgetFit.fit(${h}, ${q}, ${s}); ` +
          `System.out.println(f.questRows + " " + f.questsMore + " " + f.streakRows + " " + f.streaksMore); }`,
      )
      .join("\n");
    expect(runFit(main)).toEqual(cases.map((c) => c[3]));
  }, 60_000);

  it("fits rows to the portrait height in portrait and the landscape height in landscape", () => {
    // Launchers report a widget's size as min height (landscape) and max height (portrait).
    // [minHeight, maxHeight, portrait] -> height dp used
    const cases: Array<[number, number, boolean, string]> = [
      [110, 250, true, "250"], // portrait: the taller size, so streak rows fill the widget
      [110, 250, false, "110"], // landscape: the shorter size, so nothing is clipped
      [0, 0, true, "110"], // no size reported yet: the provider's default
      [180, 0, true, "180"], // a launcher that reports only one height
      [0, 200, false, "200"],
    ];
    const main = cases
      .map(([min, max, portrait]) => `System.out.println(StatsWidgetFit.heightDp(${min}, ${max}, ${portrait}, 110));`)
      .join("\n");
    expect(runFit(main)).toEqual(cases.map((c) => c[3]));
    // A portrait widget 250dp tall shows all 5 streaks; sized by its landscape height it showed none.
    expect(runFit("{ StatsWidgetFit f = StatsWidgetFit.fit(StatsWidgetFit.heightDp(110, 250, true, 110), 3, 5); System.out.println(f.streakRows + \" \" + f.streaksMore); }")).toEqual(["5 0"]);
  }, 60_000);

  it("formats focus time and Quest hours in fixed-width figures", () => {
    const lines = runFit(
      [
        "System.out.println(StatsWidgetFit.formatFocus(0));",
        "System.out.println(StatsWidgetFit.formatFocus(2700));",
        "System.out.println(StatsWidgetFit.formatFocus(7500));",
        "System.out.println(StatsWidgetFit.formatHours(19800, 8, false));",
        "System.out.println(StatsWidgetFit.formatHours(36000, 6, true));",
        "System.out.println(StatsWidgetFit.formatHours(5400, 7.5, false));",
        "System.out.println(StatsWidgetFit.formatHours(0, 0, false));",
      ].join("\n"),
    );
    expect(lines).toEqual(["0m", "45m", "2h 05m", "5.5 / 8h", "10.0 / 6h \u2713", "1.5 / 7.5h", "0.0h"]);
  }, 60_000);
});
