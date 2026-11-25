// @vitest-environment node
// The phone page runs the shared domain core (src/mobile/huntCore.ts), bundled into its HUNT-CORE
// block by scripts/build-mobile-core.mjs. These tests fail when the block is stale or the page
// stops using it.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as core from "@/mobile/huntCore";
import { habitTaskId } from "@/lib/dateUtils";
import { loadMobile, type MobileWindow } from "./helpers/loadMobile";
import { buildCoreBlock, HTML_COPIES, withCoreBlock } from "../../scripts/build-mobile-core.mjs";

describe("generated HuntCore block", () => {
  it("is up to date in both HTML copies (run `npm run build:mobile-core` after changing the core)", async () => {
    const block: string = await buildCoreBlock();
    for (const file of HTML_COPIES as string[]) {
      const html = readFileSync(file, "utf8");
      expect(withCoreBlock(html, block) === html, `${file} has a stale HuntCore block`).toBe(true);
    }
  }, 30_000);
});

describe("the phone runs the shared implementations", () => {
  let w: MobileWindow;
  beforeAll(() => {
    w = loadMobile();
  });
  afterAll(() => {
    w.close();
  });

  it("binds every rule the page uses to HuntCore, not to a copy of its own", () => {
    const page = w as unknown as Record<string, unknown> & { HuntCore: Record<string, unknown> };
    const bound = [
      "toLocalDateKey",
      "compareRank",
      "nextStamp",
      "sessionLogId",
      "isSafeSyncId",
      "habitTaskId",
      "isTaskVisibleToday",
      "isMissedHabitTask",
      "isOpenTask",
      "buildHabitTaskRow",
      "computeHabitStreak",
      "completionDateKey",
      "applyChecklistEdit",
      "canHoldChecklist",
      "checklistOf",
      "checklistProgress",
      "newChecklistItemId",
      "applyListEdit",
      "buildList",
      "cleanListTitle",
      "listItemsOf",
      "listProgress",
      "newListId",
      "sanitizeList",
    ];
    for (const name of bound) {
      expect(typeof page.HuntCore[name], name).toBe("function");
      expect(page[name], name).toBe(page.HuntCore[name]);
    }
    expect(Object.keys(page.HuntCore).sort()).toEqual(Object.keys(core).sort());
  });

  it("counts a habit ticked after midnight for its own day, like the desktop", () => {
    const page = w as unknown as { completionDateKey: typeof core.completionDateKey };
    const late = new Date(2026, 4, 11, 0, 30).getTime();
    const habitDay = {
      id: habitTaskId("h", "2026-05-10"),
      status: "completed" as const,
      habitId: "h",
      scheduledDate: "2026-05-10",
      completedAt: late,
      updatedAt: late,
    };
    expect(page.completionDateKey(habitDay)).toBe("2026-05-10");
    expect(page.completionDateKey(habitDay)).toBe(core.completionDateKey(habitDay));
  });
});
