// @vitest-environment node
//
// Android notification actions (#32, ADR-0007): Done and +1 are queued as Pending Ticks (ADR-0006)
// for HuntCore to apply, never written as Hunt data; Snooze is stored in the shell's own file and
// re-fires 10 minutes later, standing in for the page until the page's next plan has judged it.
// The logic runs on the JDK as the real classes; the wiring is guarded at the source.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { hasJdk, JAVA_DIR, runJavaProbe } from "./helpers/javaProbe";

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const KEY = "task:t1:2026-11-25T09:00";

function entry(extra: Record<string, unknown> = {}) {
  return { kind: "task", key: KEY, itemId: "t1", title: "Call the bank", dateKey: "2026-11-25", time: "09:00", fireAt: T0, action: { tick: "done", taskId: "t1" }, ...extra };
}

const CLASSES = ["ReminderPlan.java", "ReminderSnoozes.java", "ReminderActions.java", "PendingTicks.java", "HuntFiles.java", "TickKeys.java"];

/** Runs `body` with `dir` (a fresh temp folder) and `plan` (the parsed plan) in scope. */
function probe(plan: unknown, body: string): string[] {
  return runJavaProbe({
    classes: CLASSES,
    stubs: true,
    imports: ["java.nio.file.Files", "java.nio.charset.StandardCharsets"],
    main: [
      'File dir = Files.createTempDirectory("hunt-reminders").toFile();',
      `ReminderPlan plan = ReminderPlan.parse(${JSON.stringify(JSON.stringify(plan))});`,
      body,
    ].join("\n"),
  });
}

const printFile = (name: string) =>
  `{ File f = new File(dir, "${name}"); System.out.println(f.exists() ? new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8) : "none"); }`;
/** An entry as a notification action's intent carries it, read back. */
const viaIntent = (i: number) => `ReminderPlan.Entry.fromJson(plan.entries.get(${i}).toJson())`;

describe.skipIf(!hasJdk)("notification actions, run on the JDK", () => {
  it("Done queues a done Pending Tick for the Task the plan names, at the tap time, once per tap", () => {
    const lines = probe({ version: 1, reminders: [entry()], snoozes: [] }, [
      `System.out.println(ReminderActions.tick(dir, ${viaIntent(0)}, ${T0 + MIN}L));`,
      `System.out.println(ReminderActions.tick(dir, ${viaIntent(0)}, ${T0 + MIN}L));`,
      printFile("hunt-pending-ticks.json"),
    ].join("\n"));
    expect(lines.slice(0, 2)).toEqual(["ADDED", "ALREADY_QUEUED"]);
    expect(JSON.parse(lines[2])).toEqual([{ taskId: "t1", dateKey: "2026-11-25", tickedAt: T0 + MIN }]);
  }, 60_000);

  it("+1 on a Count Habit reminder queues a +1 for its day Task; a reminder without an action queues nothing", () => {
    const count = entry({ kind: "habit", key: "habit:h1:2026-11-25T09:00", itemId: "h1", action: { tick: "+1", taskId: "habtsk-2026-11-25-h1" } });
    const avoid = entry({ kind: "habit", key: "habit:h2:2026-11-25T21:00", itemId: "h2", action: undefined });
    const lines = probe({ version: 1, reminders: [count, avoid], snoozes: [] }, [
      `System.out.println(ReminderActions.tick(dir, ${viaIntent(0)}, ${T0 + MIN}L));`,
      `System.out.println(ReminderActions.tick(dir, ${viaIntent(1)}, ${T0 + 2 * MIN}L));`,
      printFile("hunt-pending-ticks.json"),
    ].join("\n"));
    expect(lines.slice(0, 2)).toEqual(["ADDED", "REJECTED"]);
    expect(JSON.parse(lines[2])).toEqual([{ taskId: "habtsk-2026-11-25-h1", dateKey: "2026-11-25", tickedAt: T0 + MIN, kind: "+1" }]);
  }, 60_000);

  it("Snooze stores the original reminder and its new time, 10 minutes on; snoozing again moves the same snooze", () => {
    const lines = probe({ version: 1, reminders: [entry()], snoozes: [] }, [
      `System.out.println(ReminderActions.snooze(dir, ${viaIntent(0)}, ${T0 + MIN}L));`,
      "ReminderPlan stood = plan.withSnoozes(ReminderSnoozes.read(dir));",
      "ReminderPlan.Entry again = ReminderPlan.Entry.fromJson(stood.entries.get(1).toJson());",
      `System.out.println(ReminderActions.snooze(dir, again, ${T0 + 12 * MIN}L));`,
      "System.out.println(ReminderSnoozes.readJson(dir));",
    ].join("\n"));
    expect(lines.slice(0, 2)).toEqual(["true", "true"]);
    expect(JSON.parse(lines[2])).toEqual([{ key: KEY, fireAt: T0, until: T0 + 22 * MIN }]);
  }, 60_000);

  it("re-fires a snooze the page has not planned yet as a stand-in, with the same actions; the page's plan rules once it has judged it", () => {
    const lines = probe({ version: 1, reminders: [entry()], snoozes: [] }, [
      `ReminderActions.snooze(dir, ${viaIntent(0)}, ${T0 + MIN}L);`,
      "ReminderPlan stood = plan.withSnoozes(ReminderSnoozes.read(dir));",
      "for (ReminderPlan.Entry e : stood.entries) System.out.println(e.key + \" \" + e.fireAt + \" \" + e.actionTick + \" \" + e.actionTaskId + \" \" + e.snoozeOfKey);",
      `System.out.println(stood.nextAlarmAt(${T0 + MIN}L));`,
      // The page planned after the snooze and dropped it (the Task was done): no stand-in.
      `ReminderPlan judged = ReminderPlan.parse(${JSON.stringify(JSON.stringify({ version: 1, reminders: [], snoozes: [{ key: KEY, fireAt: T0, until: T0 + 11 * MIN }] }))});`,
      "System.out.println(judged.withSnoozes(ReminderSnoozes.read(dir)).entries.size());",
    ].join("\n"));
    expect(lines).toEqual([
      `${KEY} ${T0} done t1 null`,
      `${KEY}~${T0 + 11 * MIN} ${T0 + 11 * MIN} done t1 ${KEY}`,
      String(T0 + 11 * MIN),
      "0",
    ]);
  }, 60_000);

  it("keeps the snooze file small: an ended snooze older than the late limit is dropped on the next snooze", () => {
    const other = entry({ key: "task:t2:2026-11-25T09:00", itemId: "t2" });
    const lines = probe({ version: 1, reminders: [entry(), other], snoozes: [] }, [
      `ReminderActions.snooze(dir, ${viaIntent(0)}, ${T0}L);`,
      `ReminderActions.snooze(dir, ${viaIntent(1)}, ${T0 + 30 * MIN}L);`,
      "System.out.println(ReminderSnoozes.readJson(dir));",
    ].join("\n"));
    expect(JSON.parse(lines[0]).map((s: { key: string }) => s.key)).toEqual(["task:t2:2026-11-25T09:00"]);
  }, 60_000);

  it("reads a missing or unreadable snooze file as no snoozes", () => {
    const lines = probe({ version: 1, reminders: [] }, [
      "System.out.println(ReminderSnoozes.readJson(dir));",
      'Files.write(new File(dir, "hunt-reminder-snoozes.json").toPath(), "{nope".getBytes(StandardCharsets.UTF_8));',
      "System.out.println(ReminderSnoozes.readJson(dir) + \" \" + ReminderSnoozes.read(dir).size());",
    ].join("\n"));
    expect(lines).toEqual(["[]", "[] 0"]);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------------------------

const MAIN = path.resolve(JAVA_DIR, "..", "..", "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
const source = (name: string) => strip(fs.readFileSync(path.join(JAVA_DIR, name), "utf8"));
const manifest = fs.readFileSync(path.join(MAIN, "AndroidManifest.xml"), "utf8");

describe("Android notification actions: source contract", () => {
  it("each notification offers the plan's Done or +1 and always Snooze, routed to a receiver no other app can call", () => {
    const reminders = source("Reminders.java");
    expect(reminders).toMatch(/new Notification\.Action\.Builder\(/);
    expect(reminders).toMatch(/\.addAction\(/);
    expect(reminders).toMatch(/PendingIntent\.getBroadcast\([^;]*\bREQUEST_ACTION\b/);
    expect(reminders).toMatch(/new Intent\(\s*\w+\s*,\s*ReminderActionReceiver\.class\s*\)/);
    const receiver = /<receiver\b[^>]*android:name="\.ReminderActionReceiver"[^>]*\/?>/.exec(manifest);
    expect(receiver, "ReminderActionReceiver").not.toBeNull();
    expect(receiver![0]).toMatch(/android:exported="false"/);
  });

  it("routes Done and +1 through the Pending Tick queue's append, and Snooze to the shell's own file", () => {
    const actions = source("ReminderActions.java");
    expect(actions).toMatch(/PendingTicks\.append\(/);
    expect(source("ReminderActionReceiver.java")).toMatch(/ReminderActions\.(tick|snooze)\(/);
    expect(source("ReminderSnoozes.java")).toMatch(/HuntFiles\.writeText\(\s*file\(\s*dir\s*\)/);
    expect(fs.readFileSync(path.join(JAVA_DIR, "HuntFiles.java"), "utf8")).toMatch(/REMINDER_SNOOZES_FILE\s*=\s*"hunt-reminder-snoozes\.json"/);
  });
});
