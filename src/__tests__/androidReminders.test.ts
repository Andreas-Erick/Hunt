// @vitest-environment node
//
// Android reminder notifications (ADR-0007, #30). The page hands the shell a Reminder Plan built
// by HuntCore; the shell arms one exact alarm for the next reminder, posts each reminder once,
// and opens Hunt on the item when a notification is tapped. The plan and permission rules run
// on the JDK as the real classes; the rest is guarded at the source, as the widget shell is.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasJdk, JAVA_DIR, runJavaProbe } from "./helpers/javaProbe";

const MIN = 60_000;
const T0 = 1_800_000_000_000;

function entry(key: string, fireAt: number, extra: Record<string, unknown> = {}) {
  return { kind: "task", key, itemId: key, title: `Title ${key}`, dateKey: "2026-11-25", time: "09:00", fireAt, ...extra };
}

/** Parses `plan` with the real ReminderPlan, then runs `body` with `p` in scope. */
function planProbe(plan: unknown, body: string): string[] {
  return runJavaProbe({
    classes: ["ReminderPlan.java"],
    stubs: true,
    main: [`ReminderPlan p = ReminderPlan.parse(${JSON.stringify(JSON.stringify(plan))});`, body].join("\n"),
  });
}

const printDue = (firedThrough: number, now: number) =>
  `{ StringBuilder b = new StringBuilder(); for (ReminderPlan.Entry e : p.due(${firedThrough}L, ${now}L)) b.append(e.key).append(' '); System.out.println(b.toString().trim()); }`;

describe.skipIf(!hasJdk)("ReminderPlan, run on the JDK", () => {
  it("posts each reminder once: those due since the last post, never one already posted", () => {
    const plan = { version: 1, reminders: [entry("a", T0), entry("b", T0 + 5 * MIN), entry("c", T0 + 60 * MIN)] };
    expect(planProbe(plan, [printDue(0, T0 + 5 * MIN), printDue(T0 + 5 * MIN, T0 + 6 * MIN), printDue(T0 + 6 * MIN, T0 + 60 * MIN)].join("\n"))).toEqual([
      "a b",
      "",
      "c",
    ]);
  }, 60_000);

  it("drops a reminder missed by more than 10 minutes (the phone was off), as the desktop does", () => {
    const plan = { version: 1, reminders: [entry("old", T0), entry("fresh", T0 + 2 * MIN)] };
    expect(planProbe(plan, printDue(0, T0 + 11 * MIN))).toEqual(["fresh"]);
  }, 60_000);

  it("arms the next alarm for the earliest reminder still to come, and none when nothing is left", () => {
    const plan = { version: 1, reminders: [entry("c", T0 + 60 * MIN), entry("a", T0), entry("b", T0 + 5 * MIN)] };
    expect(planProbe(plan, [`System.out.println(p.nextAlarmAt(${T0}L));`, `System.out.println(p.nextAlarmAt(${T0 + 60 * MIN}L));`].join("\n"))).toEqual([
      String(T0 + 5 * MIN),
      "-1",
    ]);
  }, 60_000);

  it("reads a missing, unreadable or unknown-version plan as no reminders, and skips entries that are not reminders", () => {
    const lines = runJavaProbe({
      classes: ["ReminderPlan.java"],
      stubs: true,
      main: [
        'System.out.println(ReminderPlan.parse("").entries.size());',
        'System.out.println(ReminderPlan.parse("{not json").entries.size());',
        `System.out.println(ReminderPlan.parse(${JSON.stringify(JSON.stringify({ version: 2, reminders: [entry("a", T0)] }))}).entries.size());`,
        `ReminderPlan p = ReminderPlan.parse(${JSON.stringify(
          JSON.stringify({ version: 1, reminders: [entry("ok", T0), 5, entry("", T0), entry("nofire", T0, { fireAt: "soon" }), entry("noitem", T0, { itemId: "" })] }),
        )});`,
        'for (ReminderPlan.Entry e : p.entries) System.out.println(e.key + " " + e.kind + " " + e.itemId + " " + e.dateKey + " " + e.title);',
      ].join("\n"),
    });
    expect(lines).toEqual(["0", "0", "0", "ok task ok 2026-11-25 Title ok"]);
  }, 60_000);

  it("holds at most MAX_ENTRIES reminders, the earliest ones", () => {
    const reminders = Array.from({ length: 70 }, (_, i) => entry(`r${i}`, T0 + (70 - i) * MIN));
    const lines = planProbe({ version: 1, reminders }, 'System.out.println(p.entries.size() + " " + p.entries.get(0).key + " " + ReminderPlan.MAX_ENTRIES);');
    expect(lines).toEqual(["64 r69 64"]);
  }, 60_000);
});

/** ReminderPermissions.nextStep for one situation: what "Allow" does next. */
function nextStep(s: { sdk: number; notifications: boolean; asked: boolean; rationale: boolean; exact: boolean }): string {
  return runJavaProbe({
    classes: ["ReminderPermissions.java"],
    main: `System.out.println(ReminderPermissions.nextStep(${s.sdk}, ${s.notifications}, ${s.asked}, ${s.rationale}, ${s.exact}));`,
  })[0];
}

describe.skipIf(!hasJdk)("ReminderPermissions, run on the JDK", () => {
  it("asks for notifications with the system dialog first, then sends the user to the exact-alarm setting", () => {
    expect(nextStep({ sdk: 34, notifications: false, asked: false, rationale: false, exact: false })).toBe("ASK_NOTIFICATIONS");
    expect(nextStep({ sdk: 34, notifications: false, asked: true, rationale: true, exact: false })).toBe("ASK_NOTIFICATIONS");
    expect(nextStep({ sdk: 34, notifications: true, asked: true, rationale: false, exact: false })).toBe("OPEN_EXACT_ALARM_SETTINGS");
    expect(nextStep({ sdk: 34, notifications: true, asked: true, rationale: false, exact: true })).toBe("NONE");
  }, 60_000);

  it("once Android stops showing the dialog (denied for good), opens Hunt's notification settings instead", () => {
    expect(nextStep({ sdk: 34, notifications: false, asked: true, rationale: false, exact: true })).toBe("OPEN_NOTIFICATION_SETTINGS");
    // Before Android 13 there is no runtime dialog: notifications turned off are turned on in settings.
    expect(nextStep({ sdk: 30, notifications: false, asked: false, rationale: false, exact: true })).toBe("OPEN_NOTIFICATION_SETTINGS");
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------------------------

const MAIN = path.resolve(JAVA_DIR, "..", "..", "..", "..");
const read = (file: string) => fs.readFileSync(file, "utf8");
const manifest = read(path.join(MAIN, "AndroidManifest.xml"));
const javaFiles = fs.readdirSync(JAVA_DIR).filter((f) => f.endsWith(".java"));
const source = (name: string) => read(path.join(JAVA_DIR, name)).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const reminderSources = javaFiles.filter((f) => /^Reminder/.test(f)).map((name) => ({ name, code: source(name) }));
const mainActivity = source("MainActivity.java");
const page = read(path.join(MAIN, "assets", "hunt-mobile.html"));

describe("Android reminder shell: source contract", () => {
  it("declares the notification, exact-alarm and boot permissions it needs", () => {
    const permissions = Array.from(manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g), (m) => m[1]);
    for (const p of ["android.permission.POST_NOTIFICATIONS", "android.permission.SCHEDULE_EXACT_ALARM", "android.permission.RECEIVE_BOOT_COMPLETED"]) {
      expect(permissions, p).toContain(p);
    }
    // USE_EXACT_ALARM is for alarm-clock apps and is granted without asking; Hunt asks.
    expect(permissions).not.toContain("android.permission.USE_EXACT_ALARM");
  });

  it("re-arms after a reboot, a clock or time zone change, an update and an exact-alarm grant, from a receiver no other app can call", () => {
    const receiver = /<receiver\b[^>]*android:name="\.ReminderAlarmReceiver"[^>]*>([\s\S]*?)<\/receiver>/.exec(manifest);
    expect(receiver, "ReminderAlarmReceiver").not.toBeNull();
    expect(receiver![0]).toMatch(/android:exported="false"/);
    for (const action of [
      "android.intent.action.BOOT_COMPLETED",
      "android.intent.action.TIME_SET",
      "android.intent.action.TIMEZONE_CHANGED",
      "android.intent.action.MY_PACKAGE_REPLACED",
      "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED",
    ]) {
      expect(receiver![1], action).toContain(`<action android:name="${action}" />`);
    }
  });

  it("schedules exact, wake-up alarms when allowed, and falls back to an inexact one only when not", () => {
    const all = reminderSources.map((f) => f.code).join("\n");
    expect(all).toMatch(/setExactAndAllowWhileIdle\(\s*AlarmManager\.RTC_WAKEUP/);
    expect(all).toMatch(/canScheduleExactAlarms\(\)/);
    expect(all).toMatch(/setAndAllowWhileIdle\(\s*AlarmManager\.RTC_WAKEUP/);
    expect(all).not.toMatch(/\.setRepeating\(|\.setInexactRepeating\(/);
    // The alarm and the tap are immutable PendingIntents with fixed request codes.
    expect(all).toMatch(/FLAG_IMMUTABLE/);
    expect(all).not.toMatch(/FLAG_MUTABLE/);
  });

  it("never writes Hunt data: no state file, no Pending Ticks, and only the bridge saves the plan", () => {
    expect(reminderSources.map((f) => f.name).sort()).toEqual([
      "ReminderAlarmReceiver.java",
      "ReminderPermissions.java",
      "ReminderPlan.java",
      "Reminders.java",
    ]);
    for (const { name, code } of reminderSources) {
      expect(code, name).not.toMatch(/hunt-mobile-state\.json|STATE_FILE|WIDGET_SNAPSHOT_FILE/);
      expect(code, name).not.toMatch(/PendingTicks\./);
      expect(code, name).not.toMatch(/\bwriteText\s*\(|FileOutputStream|startWrite|CoalescedWrite/);
    }
    // The plan file is written by MainActivity's bridge through a coalesced, atomic write.
    expect(read(path.join(JAVA_DIR, "HuntFiles.java"))).toMatch(/REMINDER_PLAN_FILE\s*=\s*"hunt-reminder-plan\.json"/);
    expect(mainActivity).toMatch(/reminderPlanWrite\.flushTo\(\s*file\(\s*HuntFiles\.REMINDER_PLAN_FILE\s*\)\s*\)/);
    for (const name of javaFiles.filter((f) => f !== "MainActivity.java" && f !== "HuntFiles.java")) {
      expect(source(name), name).not.toMatch(/REMINDER_PLAN_FILE[^;]*(writeText|flushTo)/);
    }
    // Every read of the plan file holds the shared lock.
    const reminders = source("Reminders.java");
    expect(reminders).toMatch(/synchronized\s*\(\s*HuntFiles\.LOCK\s*\)\s*\{[^}]*HuntFiles\.readText\(\s*new File\([^;]*HuntFiles\.REMINDER_PLAN_FILE/);
  });

  it("tapping a notification opens Hunt on the item: an explicit intent to MainActivity the page is told about", () => {
    const reminders = source("Reminders.java");
    expect(reminders).toMatch(/PendingIntent\.getActivity\(/);
    expect(reminders).toMatch(/new Intent\(\s*\w+\s*,\s*MainActivity\.class\s*\)/);
    expect(mainActivity).toMatch(/handleReminderIntent\(\s*getIntent\(\)\s*\)/);
    expect(mainActivity).toMatch(/handleReminderIntent\(\s*intent\s*\)/);
    expect(mainActivity).toMatch(/callJs\(\s*"__huntOpenReminder"/);
    expect(page).toMatch(/window\.__huntOpenReminder\s*=/);
  });

  it("the page hands over the plan HuntCore built after every save, and asks for permissions through the bridge", () => {
    expect(page).toMatch(/HuntCore\.reminderPlan\(/);
    expect(page).toMatch(/bridgeCall\("saveReminderPlan"/);
    expect(page).toMatch(/bridgeCall\("requestReminderPermissions"\)/);
    expect(page).toMatch(/bridgeCall\("getReminderPermissions"\)/);
  });
});
