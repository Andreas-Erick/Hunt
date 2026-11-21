import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reads } from "@/lib/reads";

const SRC = path.resolve(process.cwd(), "src");

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

describe("read model", () => {
  it("views and the store never touch Dexie tables directly (they read through `reads`)", () => {
    const offenders = [
      ...sources(path.join(SRC, "components")),
      ...sources(path.join(SRC, "app")).filter((f) => !f.includes(`${path.sep}api${path.sep}`)),
      path.join(SRC, "store", "useCommandStore.ts"),
    ].filter((file) => /\bdb\.(tasks|quests|habits|timeLogs)\b/.test(fs.readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  describe("queries", () => {
    beforeEach(async () => {
      await Promise.all([db.tasks.clear(), db.timeLogs.clear()]);
    });

    it("logsForQuests makes no read at all for no quests", async () => {
      const spy = vi.spyOn(db.timeLogs, "where");
      expect(await reads.logsForQuests([])).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("logsBetween is inclusive on both ends and newest first", async () => {
      const log = (id: string, dateKey: string, startTime: number) => ({
        id,
        taskId: "t",
        taskTitleSnapshot: "t",
        questId: null,
        questCodeSnapshot: "Other",
        accentColorSnapshot: "slate" as const,
        startTime,
        endTime: startTime + 1000,
        durationSeconds: 1,
        dateKey,
      });
      await db.timeLogs.bulkAdd([
        log("a", "2026-05-01", 1),
        log("b", "2026-05-03", 3),
        log("c", "2026-05-05", 5),
        log("d", "2026-05-06", 6),
      ]);
      const got = await reads.logsBetween("2026-05-01", "2026-05-05");
      expect(got.map((l) => l.id)).toEqual(["c", "b", "a"]);
    });

    it("task and quest reads resolve undefined for a missing id without a read", async () => {
      expect(await reads.task(null)).toBeUndefined();
      expect(await reads.quest(undefined)).toBeUndefined();
    });
  });
});
