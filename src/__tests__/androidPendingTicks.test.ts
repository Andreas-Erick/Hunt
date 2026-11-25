// @vitest-environment node
//
// The Pending Tick queue file (ADR-0006), run on the JDK as the real PendingTicks.java against a
// file-backed AtomicFile fake. A tick must never be lost silently: a queue that cannot be read is
// never written over, a failed or refused append tells the caller so it can keep the tick and
// retry, and the bridge's read tells the page when the queue was unreadable or set aside.
import { describe, expect, it } from "vitest";
import { hasJdk, runJavaProbe } from "./helpers/javaProbe";

const QUEUE = "hunt-pending-ticks.json";

/** Runs `body` with `dir` (a fresh temp folder) and `queue` (its queue file) in scope. */
function probe(body: string): string[] {
  return runJavaProbe({
    classes: ["PendingTicks.java", "HuntFiles.java", "TickKeys.java"],
    stubs: true,
    imports: ["java.nio.file.Files", "java.nio.charset.StandardCharsets", "android.util.AtomicFile"],
    main: [
      'File dir = Files.createTempDirectory("hunt-queue").toFile();',
      `File queue = new File(dir, "${QUEUE}");`,
      body,
    ].join("\n"),
  });
}

const write = (text: string) => `Files.write(queue.toPath(), ${JSON.stringify(text)}.getBytes(StandardCharsets.UTF_8));`;
const printFile = "System.out.println(new String(Files.readAllBytes(queue.toPath()), StandardCharsets.UTF_8));";
const append = (taskId: string, at: number) =>
  `{ PendingTicks.Queued r = PendingTicks.append(dir, "${taskId}", "2026-11-22", ${at}L); System.out.println(r + " " + r.closesWindow()); }`;

describe.skipIf(!hasJdk)("PendingTicks, run on the JDK", () => {
  it("appends a tick once per Task and day; a missing file is an empty queue", () => {
    expect(probe([append("t-1", 1000), append("t-1", 2000), append("t-2", 3000), printFile].join("\n"))).toEqual([
      "ADDED true",
      "ALREADY_QUEUED true",
      "ADDED true",
      '[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":1000},{"taskId":"t-2","dateKey":"2026-11-22","tickedAt":3000}]',
    ]);
  }, 60_000);

  it("queues each +1 on a Count Habit row (one per tap), with its kind, and lists them apart from done ticks", () => {
    const plus = (taskId: string, at: number) =>
      `{ PendingTicks.Queued r = PendingTicks.append(dir, "${taskId}", "2026-11-22", ${at}L, TickKeys.PLUS_ONE); System.out.println(r); }`;
    const lines = probe(
      [
        plus("t-jog", 1000),
        plus("t-jog", 2000),
        plus("t-jog", 2000), // the same tap again (a crash between queueing and closing its window)
        append("t-done", 3000),
        printFile,
        "PendingTicks.Listing l = PendingTicks.queued(dir);",
        "System.out.println(new TreeSet<>(l.keys) + \" \" + new TreeMap<>(l.plusCounts));",
      ].join("\n"),
    );
    expect(lines.slice(0, 4)).toEqual(["ADDED", "ADDED", "ALREADY_QUEUED", "ADDED true"]);
    expect(JSON.parse(lines[4])).toEqual([
      { taskId: "t-jog", dateKey: "2026-11-22", tickedAt: 1000, kind: "+1" },
      { taskId: "t-jog", dateKey: "2026-11-22", tickedAt: 2000, kind: "+1" },
      { taskId: "t-done", dateKey: "2026-11-22", tickedAt: 3000 },
    ]);
    expect(lines[5]).toBe("[2026-11-22|t-done] {2026-11-22|t-jog=2}");
  }, 60_000);

  it("queues a Slip on an Avoid Habit row once per Task and day, with its kind, hiding the row like a done tick", () => {
    const slip = (taskId: string, at: number) =>
      `{ PendingTicks.Queued r = PendingTicks.append(dir, "${taskId}", "2026-11-22", ${at}L, TickKeys.SLIP); System.out.println(r); }`;
    const lines = probe(
      [
        slip("t-dry", 1000),
        slip("t-dry", 2000), // one Slip already decides the day
        printFile,
        "PendingTicks.Listing l = PendingTicks.queued(dir);",
        "System.out.println(new TreeSet<>(l.keys) + \" \" + new TreeMap<>(l.plusCounts));",
      ].join("\n"),
    );
    expect(lines.slice(0, 2)).toEqual(["ADDED", "ALREADY_QUEUED"]);
    expect(JSON.parse(lines[2])).toEqual([{ taskId: "t-dry", dateKey: "2026-11-22", tickedAt: 1000, kind: "slip" }]);
    expect(lines[3]).toBe("[2026-11-22|t-dry] {}");
  }, 60_000);

  it("never writes over a queue it could not parse, and says the tick is still pending", () => {
    expect(probe([write("{not json"), append("t-1", 1000), printFile].join("\n"))).toEqual([
      "UNREADABLE false",
      "{not json",
    ]);
  }, 60_000);

  it("never writes over a queue whose read failed (a read error is not an empty queue)", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-0","dateKey":"2026-11-22","tickedAt":5}]'),
        `AtomicFile.FAIL_READS.add("${QUEUE}");`,
        append("t-1", 1000),
        `AtomicFile.FAIL_READS.clear();`,
        printFile,
      ].join("\n"),
    );
    expect(lines).toEqual(["UNREADABLE false", '[{"taskId":"t-0","dateKey":"2026-11-22","tickedAt":5}]']);
  }, 60_000);

  it("refuses a tick when the queue is full or the write fails, without closing its window", () => {
    const lines = probe(
      [
        "StringBuilder b = new StringBuilder(\"[\");",
        "for (int i = 0; i < PendingTicks.MAX_TICKS; i++) b.append(i == 0 ? \"\" : \",\").append(\"{\\\"taskId\\\":\\\"f\" + i + \"\\\",\\\"dateKey\\\":\\\"2026-11-22\\\",\\\"tickedAt\\\":1}\");",
        "Files.write(queue.toPath(), b.append(\"]\").toString().getBytes(StandardCharsets.UTF_8));",
        append("t-1", 1000),
        "queue.delete();",
        `AtomicFile.FAIL_WRITES.add("${QUEUE}");`,
        append("t-1", 1000),
        "System.out.println(queue.exists());",
      ].join("\n"),
    );
    expect(lines).toEqual(["FULL false", "WRITE_FAILED false", "false"]);
  }, 60_000);

  it("the bridge's read hands the page the ticks and the Undo windows held back", () => {
    const lines = probe(
      [write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7}]'), "System.out.println(PendingTicks.read(dir, 2));", "System.out.println(PendingTicks.read(dir, 0));"].join("\n"),
    );
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { ticks: [{ taskId: "t-1", dateKey: "2026-11-22", tickedAt: 7 }], heldBack: 2 },
      { ticks: [{ taskId: "t-1", dateKey: "2026-11-22", tickedAt: 7 }] },
    ]);
  }, 60_000);

  it("the bridge's read sets a corrupt queue aside, says where it was kept, and the widget can queue again", () => {
    const lines = probe(
      [
        write("{not json"),
        "System.out.println(PendingTicks.read(dir, 0));",
        "System.out.println(queue.exists());",
        "for (File f : dir.listFiles()) if (f.getName().startsWith(\"hunt-pending-ticks-unreadable-\")) System.out.println(\"kept \" + new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));",
        append("t-1", 1000),
      ].join("\n"),
    );
    const envelope = JSON.parse(lines[0]);
    expect(envelope.ticks).toEqual([]);
    expect(envelope.unreadable).toBe("corrupt");
    expect(envelope.keptAs).toMatch(/^hunt-pending-ticks-unreadable-\d+\.json$/);
    expect(lines.slice(1)).toEqual(["false", "kept {not json", "ADDED true"]);
  }, 60_000);

  it("the bridge's read leaves a queue it could not read where it is and reports the read error", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7}]'),
        `AtomicFile.FAIL_READS.add("${QUEUE}");`,
        "System.out.println(PendingTicks.read(dir, 0));",
        `AtomicFile.FAIL_READS.clear();`,
        printFile,
      ].join("\n"),
    );
    expect(JSON.parse(lines[0])).toEqual({ ticks: [], unreadable: "read-error" });
    expect(lines[1]).toBe('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7}]');
  }, 60_000);

  it("acknowledging removes exactly the given ticks and never rewrites an unreadable queue", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7},{"taskId":"t-2","dateKey":"2026-11-22","tickedAt":8}]'),
        'System.out.println(PendingTicks.ack(dir, "[{\\"taskId\\":\\"t-1\\",\\"dateKey\\":\\"2026-11-22\\",\\"tickedAt\\":7},{\\"taskId\\":\\"t-2\\",\\"dateKey\\":\\"2026-11-22\\",\\"tickedAt\\":9}]"));',
        printFile,
        write("{not json"),
        'System.out.println(PendingTicks.ack(dir, "[{\\"taskId\\":\\"t-2\\",\\"dateKey\\":\\"2026-11-22\\",\\"tickedAt\\":8}]"));',
        printFile,
      ].join("\n"),
    );
    expect(lines).toEqual(["1", '[{"taskId":"t-2","dateKey":"2026-11-22","tickedAt":8}]', "0", "{not json"]);
  }, 60_000);

  it("the widget learns which Task and day each queued tick is for, so a Task stays hidden only on its day", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7},{"taskId":"t-2","dateKey":"2026-11-23","tickedAt":8},5]'),
        "PendingTicks.Listing l = PendingTicks.queued(dir);",
        'System.out.println(l.readable + " " + new TreeSet<>(l.keys));',
      ].join("\n"),
    );
    expect(lines).toEqual(["true [2026-11-22|t-1, 2026-11-23|t-2]"]);
  }, 60_000);

  it("a queue the widget cannot read says so, rather than looking empty", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7}]'),
        `AtomicFile.FAIL_READS.add("${QUEUE}");`,
        "PendingTicks.Listing l = PendingTicks.queued(dir);",
        'System.out.println(l.readable + " " + l.keys);',
        `AtomicFile.FAIL_READS.clear();`,
        write("{not json"),
        "l = PendingTicks.queued(dir);",
        'System.out.println(l.readable + " " + l.keys);',
      ].join("\n"),
    );
    expect(lines).toEqual(["false []", "false []"]);
  }, 60_000);

  it("the bridge's read sets entries that are not ticks aside, keeps every tick, and the queue stays clean", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7},5,"x",null,{"taskId":"t-2","dateKey":"2026-11-22","tickedAt":8}]'),
        "System.out.println(PendingTicks.read(dir, 0));",
        printFile,
        'for (File f : dir.listFiles()) if (f.getName().startsWith("hunt-pending-ticks-malformed-")) System.out.println("kept " + new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));',
        "System.out.println(PendingTicks.read(dir, 0));",
      ].join("\n"),
    );
    const ticks = [
      { taskId: "t-1", dateKey: "2026-11-22", tickedAt: 7 },
      { taskId: "t-2", dateKey: "2026-11-22", tickedAt: 8 },
    ];
    const first = JSON.parse(lines[0]);
    expect(first.ticks).toEqual(ticks);
    expect(first.unreadable).toBe("malformed");
    expect(first.keptAs).toMatch(/^hunt-pending-ticks-malformed-\d+\.json$/);
    expect(JSON.parse(lines[1])).toEqual(ticks);
    expect(lines[2]).toBe('kept [5,"x",null]');
    expect(JSON.parse(lines[3])).toEqual({ ticks });
  }, 60_000);

  it("the bridge's read leaves the queue as it is when the malformed entries cannot be set aside", () => {
    const lines = probe(
      [
        write('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7},5]'),
        'AtomicFile.FAIL_WRITE_PREFIXES.add("hunt-pending-ticks-malformed-");',
        "System.out.println(PendingTicks.read(dir, 0));",
        printFile,
      ].join("\n"),
    );
    expect(JSON.parse(lines[0])).toEqual({ ticks: [{ taskId: "t-1", dateKey: "2026-11-22", tickedAt: 7 }] });
    expect(lines[1]).toBe('[{"taskId":"t-1","dateKey":"2026-11-22","tickedAt":7},5]');
  }, 60_000);
});
