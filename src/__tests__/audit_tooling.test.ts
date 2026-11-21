// @vitest-environment node
// Tooling audit coverage: the winctl compile-failure cooldown (P18-01) and the
// date-key / midnight / horizon math under UTC-8 (with US DST), UTC+0 and UTC+9 (P29-05).
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const execFileMock = vi.hoisted(() =>
  vi.fn<(file: string, args: string[], opts: unknown, cb: ExecFileCallback) => void>()
);

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFile: execFileMock };
});

import {
  computeHabitStreak,
  dateKeyFromOffset,
  msUntilNextLocalMidnight,
  toLocalDateKey,
} from "@/lib/dateUtils";
import { buildHorizonWindow } from "@/lib/reviewAnalytics";
import {
  WINCTL_COMPILE_FAILURE_COOLDOWN_MS,
  ensureCompiledWinCtlHelper,
  executeWin32WindowAction,
} from "@/lib/win32WindowCtl";

describe("winctl helper compile-failure cooldown", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const envKeys = ["WINDIR", "TEMP", "TMP", "TMPDIR"] as const;
  const savedEnv: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};
  let sandbox = "";
  let now = 0;
  // Fake time only moves forward across tests: the module keeps its failure stamp
  // between tests, so a later test must never start "before" an earlier stamp.
  let epoch = 1_000_000_000_000;

  /** Fake csc.exe: fails with exit code 1, or writes the /out: exe and succeeds. */
  function fakeCompiler(outcome: "fail" | "succeed"): void {
    execFileMock.mockImplementation((_file, args, _opts, cb) => {
      if (outcome === "succeed") {
        const out = args.find((a) => a.startsWith("/out:"));
        if (out) fs.writeFileSync(out.slice("/out:".length), "MZ");
        setImmediate(() => cb(null, "", ""));
        return;
      }
      const err = Object.assign(new Error("compile failed"), { code: 1 });
      setImmediate(() => cb(err, "", "error CS0000"));
    });
  }

  function compileCalls(): number {
    return execFileMock.mock.calls.filter(([file]) => file.endsWith("csc.exe")).length;
  }

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-winctl-cooldown-"));
    for (const key of envKeys) savedEnv[key] = process.env[key];
    const windir = path.join(sandbox, "Windows");
    const cscDir = path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319");
    fs.mkdirSync(cscDir, { recursive: true });
    fs.writeFileSync(path.join(cscDir, "csc.exe"), "");
    const temp = path.join(sandbox, "temp");
    fs.mkdirSync(temp);
    process.env.WINDIR = windir;
    process.env.TEMP = temp;
    process.env.TMP = temp;
    process.env.TMPDIR = temp;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    execFileMock.mockReset();
    epoch += WINCTL_COMPILE_FAILURE_COOLDOWN_MS * 100;
    now = epoch;
    vi.spyOn(Date, "now").mockImplementation(() => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    for (const key of envKeys) {
      const prev = savedEnv[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("does not respawn csc.exe inside the cooldown and answers helper_unavailable at once", async () => {
    fakeCompiler("fail");
    expect(await ensureCompiledWinCtlHelper()).toBeNull();
    expect(compileCalls()).toBe(1);

    now += WINCTL_COMPILE_FAILURE_COOLDOWN_MS - 1;
    expect(await ensureCompiledWinCtlHelper()).toBeNull();
    expect(await executeWin32WindowAction("close")).toEqual({
      ok: false,
      found: false,
      detail: "helper_unavailable",
    });
    expect(compileCalls()).toBe(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    // Cooldown over: the next action retries the compile, and a success is cached on disk.
    now += 1;
    fakeCompiler("succeed");
    const exe = await ensureCompiledWinCtlHelper();
    expect(exe).not.toBeNull();
    expect(compileCalls()).toBe(2);
    expect(fs.existsSync(exe!)).toBe(true);
    expect(await ensureCompiledWinCtlHelper()).toBe(exe);
    expect(compileCalls()).toBe(2);
  });

  it("keeps single-flight: concurrent callers share one compile attempt", async () => {
    fakeCompiler("fail");
    const results = await Promise.all([
      ensureCompiledWinCtlHelper(),
      ensureCompiledWinCtlHelper(),
      ensureCompiledWinCtlHelper(),
    ]);
    expect(results).toEqual([null, null, null]);
    expect(compileCalls()).toBe(1);
  });
});

/** UTC calendar arithmetic on a YYYY-MM-DD key: the zone-independent reference. */
function utcKeyFromOffset(baseKey: string, dayOffset: number): string {
  const [y, m, d] = baseKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + dayOffset)).toISOString().slice(0, 10);
}

function utcDaysBetween(startKey: string, endKey: string): number {
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
}

const HOUR = 3_600_000;

// LA changes clocks on 2026-03-08 and 2026-11-01; Berlin (the other suites) on
// 03-29 and 10-25. Tokyo and UTC never do. Feb 29 is covered via 2024.
const ZONES = [
  {
    zone: "America/Los_Angeles",
    januaryOffsetMinutes: 480,
    dayHours: { "2026-03-08": 23, "2026-11-01": 25 } as Record<string, number>,
  },
  { zone: "UTC", januaryOffsetMinutes: 0, dayHours: {} as Record<string, number> },
  { zone: "Asia/Tokyo", januaryOffsetMinutes: -540, dayHours: {} as Record<string, number> },
];

const BASE_KEYS = [
  "2024-02-28",
  "2024-02-29",
  "2024-03-01",
  "2025-12-31",
  "2026-03-07",
  "2026-03-08",
  "2026-03-29",
  "2026-10-25",
  "2026-11-01",
  "2026-11-02",
];

describe.each(ZONES)("date math in $zone", ({ zone, januaryOffsetMinutes, dayHours }) => {
  let savedTz: string | undefined;
  let savedZone = "UTC";

  beforeAll(() => {
    savedTz = process.env.TZ;
    savedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = zone;
  });

  afterAll(() => {
    // Deleting TZ alone does not reset Node's zone cache (seen on Node 24 /
    // Windows), so assign the original zone first, then drop the variable.
    process.env.TZ = savedTz ?? savedZone;
    if (savedTz === undefined) delete process.env.TZ;
  });

  it("actually runs in the pinned zone", () => {
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(januaryOffsetMinutes);
  });

  it("dateKeyFromOffset matches calendar arithmetic and round-trips across DST and Feb 29", () => {
    for (const base of BASE_KEYS) {
      for (let n = -40; n <= 40; n++) {
        const shifted = dateKeyFromOffset(base, n);
        expect(shifted).toBe(utcKeyFromOffset(base, n));
        expect(dateKeyFromOffset(shifted, -n)).toBe(base);
      }
    }
    expect(dateKeyFromOffset("2024-02-28", 1)).toBe("2024-02-29");
    expect(dateKeyFromOffset("2024-03-01", -1)).toBe("2024-02-29");
  });

  it("toLocalDateKey keeps every local hour on its local date, even when UTC has rolled over", () => {
    for (const key of BASE_KEYS) {
      const [y, m, d] = key.split("-").map(Number);
      for (let h = 0; h < 24; h++) {
        expect(toLocalDateKey(new Date(y, m - 1, d, h, 30).getTime())).toBe(key);
      }
    }
  });

  it("computeHabitStreak counts straight through Feb 29 and DST days", () => {
    const leapRun = new Set(["2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29", "2024-03-01", "2024-03-02"]);
    expect(computeHabitStreak(leapRun, "2024-03-02")).toBe(6);
    // Today not done yet: the streak runs from yesterday.
    expect(computeHabitStreak(leapRun, "2024-03-03")).toBe(6);
    const missedLeapDay = new Set(Array.from(leapRun).filter((k) => k !== "2024-02-29"));
    expect(computeHabitStreak(missedLeapDay, "2024-03-02")).toBe(2);

    for (const dstDay of ["2026-03-08", "2026-11-01"]) {
      const run = new Set([-3, -2, -1, 0, 1, 2].map((n) => utcKeyFromOffset(dstDay, n)));
      expect(computeHabitStreak(run, utcKeyFromOffset(dstDay, 2))).toBe(6);
    }
  });

  it("msUntilNextLocalMidnight lands just after the next local midnight on 23/24/25-hour days", () => {
    for (const key of ["2024-02-28", "2024-02-29", "2026-03-07", "2026-03-08", "2026-10-31", "2026-11-01"]) {
      const [y, m, d] = key.split("-").map(Number);
      const startOfDay = new Date(y, m - 1, d, 0, 0, 0, 50).getTime();
      const expectedHours = dayHours[key] ?? 24;
      expect(msUntilNextLocalMidnight(startOfDay)).toBe(expectedHours * HOUR);

      const noon = new Date(y, m - 1, d, 12).getTime();
      const wake = new Date(noon + msUntilNextLocalMidnight(noon));
      expect(toLocalDateKey(wake.getTime())).toBe(utcKeyFromOffset(key, 1));
      expect([wake.getHours(), wake.getMinutes(), wake.getSeconds(), wake.getMilliseconds()]).toEqual([0, 0, 0, 50]);
    }
  });

  it("buildHorizonWindow key spans stay whole calendar ranges", () => {
    for (const today of ["2024-02-29", "2024-03-01", "2026-03-08", "2026-03-09", "2026-11-01", "2026-11-02"]) {
      for (const offset of [0, -1, -2]) {
        const week = buildHorizonWindow("week", offset, today);
        expect(week.endKey).toBe(utcKeyFromOffset(today, offset * 7));
        expect(utcDaysBetween(week.startKey, week.endKey)).toBe(6);
        expect(week.totalDays).toBe(7);

        const day = buildHorizonWindow("day", offset, today);
        expect(day.startKey).toBe(utcKeyFromOffset(today, offset));
        expect(day.endKey).toBe(day.startKey);
      }
    }

    const feb = buildHorizonWindow("month", 0, "2024-02-15");
    expect([feb.startKey, feb.endKey, feb.totalDays]).toEqual(["2024-02-01", "2024-02-29", 29]);

    const novFromDec = buildHorizonWindow("month", -1, "2026-12-01");
    expect([novFromDec.startKey, novFromDec.endKey, novFromDec.totalDays]).toEqual(["2026-11-01", "2026-11-30", 30]);

    const q1 = buildHorizonWindow("quarter", 0, "2024-03-10");
    expect([q1.startKey, q1.endKey, q1.totalDays]).toEqual(["2024-01-01", "2024-03-31", 91]);

    const leapYear = buildHorizonWindow("year", -2, "2026-11-01");
    expect([leapYear.startKey, leapYear.endKey, leapYear.totalDays]).toEqual(["2024-01-01", "2024-12-31", 366]);
  });
});
