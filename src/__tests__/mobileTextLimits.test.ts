// @vitest-environment node
// The phone cuts titles and notes exactly as the sync validator does (textLimits.ts), so the
// server never shortens a row the phone saved. A shortened copy with the same stamp could lose
// the tie-break to the phone's long one and leave the devices split, and a plain .slice() cut
// could split an emoji into a lone surrogate.
import { afterEach, describe, expect, it } from "vitest";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";
import {
  MAX_HABIT_TITLE_LENGTH,
  MAX_QUEST_TITLE_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  sanitizeHabit,
  sanitizeQuest,
  sanitizeTask,
} from "@/lib/syncTypes";

type Page = MobileWindow & {
  openNewTaskSheet(): void;
  submitNewTaskFromSheet(promoteToTop: boolean): void;
  openNewQuestSheet(): void;
  createNewQuestFromSheet(): void;
  openNewHabitSheet(): void;
  saveNewHabit(): void;
};

let w: Page | null = null;
afterEach(() => {
  w?.close();
  w = null;
});

function boot(): Page {
  w = loadMobile({
    seedState: {
      quests: [],
      tasks: [],
      habits: [],
      timeLogs: [],
      deletedQuestIds: [],
      deletedTaskIds: [],
      deletedLogIds: [],
      activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
      lastSyncedAt: 0,
    },
  }) as Page;
  return w;
}

const field = (p: Page, id: string) => p.document.getElementById(id) as HTMLInputElement;
const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("phone text limits match the sync validator", () => {
  it("a pasted Task title is cut to the server's length, so the server keeps it unchanged", () => {
    const p = boot();
    p.openNewTaskSheet();
    field(p, "sheetTaskTitle").value = "a".repeat(MAX_TASK_TITLE_LENGTH) + " more";
    p.submitNewTaskFromSheet(false);
    const [task] = readState(p).tasks as Record<string, unknown>[];
    expect(String(task.title)).toHaveLength(MAX_TASK_TITLE_LENGTH);
    expect(sanitizeTask(task)?.title).toBe(task.title);
  });

  it("a pasted Quest title is cut to the server's length", () => {
    const p = boot();
    p.openNewQuestSheet();
    field(p, "newQuestTitleInput").value = "q".repeat(MAX_QUEST_TITLE_LENGTH) + " extra";
    p.createNewQuestFromSheet();
    const [quest] = readState(p).quests as Record<string, unknown>[];
    expect(String(quest.title)).toHaveLength(MAX_QUEST_TITLE_LENGTH);
    expect(sanitizeQuest(quest)?.title).toBe(quest.title);
  });

  it("a Habit title cut at an emoji drops the whole emoji, never half of it", () => {
    const p = boot();
    p.openNewHabitSheet();
    field(p, "newHabitTitleInput").value = "a".repeat(MAX_HABIT_TITLE_LENGTH - 1) + "🚀";
    p.saveNewHabit();
    const [habit] = readState(p).habits as Record<string, unknown>[];
    const title = String(habit.title);
    expect(hasLoneSurrogate(title)).toBe(false);
    expect(title).toBe("a".repeat(MAX_HABIT_TITLE_LENGTH - 1));
    expect(sanitizeHabit(habit)?.title).toBe(title);
  });
});
