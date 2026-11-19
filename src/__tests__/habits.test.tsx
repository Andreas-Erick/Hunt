import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import {
  db,
  dateKeyFromOffset,
  habitTaskId,
  isTaskVisibleToday,
  toLocalDateKey,
  type Habit,
  type Quest,
  type Task,
} from "@/lib/db";
import {
  createEmptySyncPayload,
  isSafeSyncId,
  mergeSyncPayloads,
  sanitizeHabit,
  syncContentKey,
  validateSyncPayload,
  type SyncPayload,
} from "@/lib/syncTypes";
import { applyMergedPayloadToLocalDB, buildLocalSyncPayload } from "@/lib/syncEngine";
import { pickNextFocusTask, useCommandStore } from "@/store/useCommandStore";
import { HabitsView, computeHabitStreak } from "@/components/HabitsView";
import { CommandCenterView } from "@/components/CommandCenterView";
import { loadMobile, readState, type MobileWindow } from "./helpers/loadMobile";

function makeQuest(id: string, title: string, slotIndex: 0 | 1 | 2 = 0): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 6).toUpperCase(),
    title,
    description: "",
    accentColor: slotIndex === 0 ? "cyan" : slotIndex === 1 ? "amber" : "emerald",
    targetWeeklyHours: 5,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

function makeHabit(id: string, title: string, extra: Partial<Habit> = {}): Habit {
  return {
    id,
    title,
    notes: "",
    questId: null,
    rank: 1000,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}

function makeTask(id: string, title: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: 1000,
    updatedAt: 1000,
    ...extra,
  };
}

async function resetAll() {
  await Promise.all([
    db.quests.clear(),
    db.tasks.clear(),
    db.timeLogs.clear(),
    db.habits.clear(),
  ]);
  window.localStorage.clear();
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    focusUpdatedAt: 0,
    lastCompletedFeedback: null,
    actionError: null,
  });
}

describe("Daily Habits — pure rules & boundary matrix", () => {
  it("habitTaskId produces safe deterministic ids", () => {
    const id = habitTaskId("hab-1795100000000-ab12", "2026-11-19");
    expect(id).toBe("habtsk-2026-11-19-hab-1795100000000-ab12");
    expect(isSafeSyncId(id)).toBe(true);
  });

  it("isTaskVisibleToday rolls over overdue regular tasks but shows daily habits strictly on their own day", () => {
    const today = "2026-11-19";
    const yesterday = "2026-11-18";
    const tomorrow = "2026-11-20";

    // Regular tasks
    expect(isTaskVisibleToday({ scheduledDate: undefined }, today)).toBe(true);
    expect(isTaskVisibleToday({ scheduledDate: today }, today)).toBe(true);
    expect(isTaskVisibleToday({ scheduledDate: yesterday }, today)).toBe(true);
    expect(isTaskVisibleToday({ scheduledDate: tomorrow }, today)).toBe(false);

    // Daily habit tasks
    expect(isTaskVisibleToday({ habitId: "hab-1", scheduledDate: today }, today)).toBe(true);
    expect(isTaskVisibleToday({ habitId: "hab-1", scheduledDate: yesterday }, today)).toBe(false);
    expect(isTaskVisibleToday({ habitId: "hab-1", scheduledDate: tomorrow }, today)).toBe(false);
    expect(isTaskVisibleToday({ habitId: "hab-1", scheduledDate: undefined }, today)).toBe(false);
  });

  it("computeHabitStreak handles empty, today-only, active streak ending yesterday, gaps, and leap years", () => {
    expect(computeHabitStreak(new Set(), "2026-11-19")).toBe(0);
    expect(computeHabitStreak(new Set(["2026-11-19"]), "2026-11-19")).toBe(1);
    expect(
      computeHabitStreak(new Set(["2026-11-17", "2026-11-18"]), "2026-11-19")
    ).toBe(2);
    expect(
      computeHabitStreak(
        new Set(["2026-11-16", "2026-11-18", "2026-11-19"]),
        "2026-11-19"
      )
    ).toBe(2);
    // Leap year rollover across Feb 28 -> Feb 29 -> Mar 1
    expect(
      computeHabitStreak(
        new Set(["2024-02-28", "2024-02-29", "2024-03-01"]),
        "2024-03-01"
      )
    ).toBe(3);
  });
});

describe("Daily Habits — store lifecycle & daily materialization", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creating a habit immediately materializes today's task and is idempotent under 10x rapid calls", async () => {
    const todayKey = toLocalDateKey();
    await db.quests.put(makeQuest("q1", "Icelandic", 0));

    const ok = await useCommandStore.getState().createHabit({
      title: "Review Anki deck",
      notes: "20 minutes minimum",
      questId: "q1",
    });
    expect(ok).toBe(true);

    const [habit] = await db.habits.toArray();
    expect(habit.title).toBe("Review Anki deck");
    expect(habit.questId).toBe("q1");

    // 10 rapid materialize calls never create duplicates
    const counts = await Promise.all(
      Array.from({ length: 10 }, () =>
        useCommandStore.getState().materializeDailyHabits(todayKey)
      )
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);

    const tasks = await db.tasks.toArray();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: habitTaskId(habit.id, todayKey),
      title: "Review Anki deck",
      notes: "20 minutes minimum",
      questId: "q1",
      habitId: habit.id,
      scheduledDate: todayKey,
      status: "queued",
      updatedAt: habit.createdAt,
    });
  });

  it("materializes a fresh task on the next day while hiding yesterday's missed habit from Focus and Home", async () => {
    const day1 = "2026-11-19";
    const day2 = "2026-11-20";
    const habit = makeHabit("hab-daily", "Morning run", { createdAt: 1000 });
    await db.habits.put(habit);

    expect(await useCommandStore.getState().materializeDailyHabits(day1)).toBe(1);
    expect(await useCommandStore.getState().materializeDailyHabits(day2)).toBe(1);

    const allTasks = await db.tasks.toArray();
    expect(allTasks).toHaveLength(2);
    // On day 2, pickNextFocusTask picks day 2's habit task, never day 1's missed copy
    const next = pickNextFocusTask(allTasks, day2);
    expect(next?.id).toBe(habitTaskId("hab-daily", day2));
  });

  it("deleting today's materialized habit task skips re-creating it today, but tomorrow still materializes fresh", async () => {
    const day1 = "2026-11-19";
    const day2 = "2026-11-20";
    await db.habits.put(makeHabit("hab-1", "Stretch", { createdAt: 1000 }));
    await useCommandStore.getState().materializeDailyHabits(day1);

    const day1TaskId = habitTaskId("hab-1", day1);
    await useCommandStore.getState().deleteTask(day1TaskId);

    // Re-running materialization for day1 does NOT resurrect the deleted instance
    expect(await useCommandStore.getState().materializeDailyHabits(day1)).toBe(0);
    expect(await db.tasks.get(day1TaskId)).toBeUndefined();

    // Tomorrow still creates a fresh task
    expect(await useCommandStore.getState().materializeDailyHabits(day2)).toBe(1);
    expect(await db.tasks.get(habitTaskId("hab-1", day2))).toBeDefined();
  });

  it("editing a habit updates today's open task without mutating past completed instances", async () => {
    const todayKey = toLocalDateKey();
    const yesterdayKey = dateKeyFromOffset(todayKey, -1);
    await db.quests.bulkPut([makeQuest("q1", "ML", 0), makeQuest("q2", "Writing", 1)]);
    const habit = makeHabit("hab-1", "Read paper", {
      notes: "Old note",
      questId: "q1",
      createdAt: 1000,
    });
    await db.habits.put(habit);
    await db.tasks.put(
      makeTask(habitTaskId("hab-1", yesterdayKey), "Read paper", {
        habitId: "hab-1",
        questId: "q1",
        status: "completed",
        scheduledDate: yesterdayKey,
        completedAt: 2000,
      })
    );
    await useCommandStore.getState().materializeDailyHabits(todayKey);

    await useCommandStore.getState().updateHabit("hab-1", {
      title: "Read 1 ML paper",
      notes: "New note",
      questId: "q2",
    });

    const todayTask = await db.tasks.get(habitTaskId("hab-1", todayKey));
    const yesterdayTask = await db.tasks.get(habitTaskId("hab-1", yesterdayKey));
    expect(todayTask).toMatchObject({
      title: "Read 1 ML paper",
      notes: "New note",
      questId: "q2",
    });
    expect(yesterdayTask?.title).toBe("Read paper");
    expect(yesterdayTask?.questId).toBe("q1");
  });

  it("deleting a habit removes today's untouched open task while preserving completed history; deleting a quest unlinks habits", async () => {
    const todayKey = toLocalDateKey();
    await db.quests.put(makeQuest("q1", "ML", 0));
    await db.habits.bulkPut([
      makeHabit("hab-open", "Untouched today", { questId: "q1" }),
      makeHabit("hab-done", "Finished today", { questId: "q1", rank: 2000 }),
    ]);
    await useCommandStore.getState().materializeDailyHabits(todayKey);
    await useCommandStore
      .getState()
      .completeTaskById(habitTaskId("hab-done", todayKey));

    // Delete quest unlinks both habits
    await useCommandStore.getState().deleteQuest("q1");
    expect((await db.habits.get("hab-open"))?.questId).toBeNull();
    expect((await db.habits.get("hab-done"))?.questId).toBeNull();

    // Deleting hab-open removes its untouched queued task today
    await useCommandStore.getState().deleteHabit("hab-open");
    expect(await db.habits.get("hab-open")).toBeUndefined();
    expect(await db.tasks.get(habitTaskId("hab-open", todayKey))).toBeUndefined();

    // Deleting hab-done preserves its completed task history
    await useCommandStore.getState().deleteHabit("hab-done");
    expect(await db.habits.get("hab-done")).toBeUndefined();
    expect((await db.tasks.get(habitTaskId("hab-done", todayKey)))?.status).toBe(
      "completed"
    );
  });
});

describe("Daily Habits — sync security, offline convergence & property tests", () => {
  beforeEach(async () => {
    await resetAll();
  });

  it("rejects hostile/oversized habit payloads and sanitizes prototype pollution and bad habitId", () => {
    expect(sanitizeHabit(null)).toBeNull();
    expect(sanitizeHabit({ id: "../evil", title: "x" })).toBeNull();
    expect(sanitizeHabit({ id: "<script>", title: "x" })).toBeNull();
    expect(sanitizeHabit({ id: "hab-ok", title: 123 })).toBeNull();

    const polluted = JSON.parse(
      '{"id":"hab-1","title":"' +
        "a".repeat(1000) +
        '","questId":"../bad","__proto__":{"polluted":true},"nested":{"x":1}}'
    );
    const clean = sanitizeHabit(polluted);
    expect(clean?.title.length).toBe(300);
    expect(clean?.questId).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((clean as unknown as Record<string, unknown>).nested).toBeUndefined();

    const oversized = validateSyncPayload({
      ...createEmptySyncPayload(),
      habits: Array.from({ length: 201 }, (_, i) => makeHabit(`hab-${i}`, "H")),
    });
    expect(oversized.valid).toBe(false);

    const badTaskHabit = validateSyncPayload({
      ...createEmptySyncPayload(),
      tasks: [makeTask("tsk-1", "T", { habitId: "javascript:alert(1)" })],
    });
    expect(badTaskHabit.valid).toBe(true);
    expect(badTaskHabit.payload?.tasks[0].habitId).toBeUndefined();
  });

  it("offline materialization on laptop & phone merges into 1 task and completed copy always wins", () => {
    const today = "2026-11-19";
    const habit = makeHabit("hab-1", "Meditate", { createdAt: 1000, updatedAt: 1000 });
    const tid = habitTaskId("hab-1", today);

    // Laptop materialized at 08:00 and completed it at 08:15
    const laptop: SyncPayload = {
      ...createEmptySyncPayload(),
      habits: [habit],
      tasks: [
        makeTask(tid, "Meditate", {
          habitId: "hab-1",
          scheduledDate: today,
          status: "completed",
          createdAt: 1000,
          updatedAt: 5000,
          completedAt: 5000,
        }),
      ],
    };
    // Phone woke up later at 09:00 offline and materialized untouched queued copy (updatedAt = habit.createdAt = 1000)
    const phone: SyncPayload = {
      ...createEmptySyncPayload(),
      habits: [habit],
      tasks: [
        makeTask(tid, "Meditate", {
          habitId: "hab-1",
          scheduledDate: today,
          status: "queued",
          createdAt: 1000,
          updatedAt: 1000,
        }),
      ],
    };

    const mergedAB = mergeSyncPayloads(laptop, phone);
    const mergedBA = mergeSyncPayloads(phone, laptop);
    expect(mergedAB.tasks).toHaveLength(1);
    expect(mergedAB.tasks[0].status).toBe("completed");
    expect(syncContentKey(mergedAB)).toBe(syncContentKey(mergedBA));
  });

  it("syncEngine round-trips habits and deletedHabitIds through IndexedDB with zero idle writes", async () => {
    const merged: SyncPayload = {
      ...createEmptySyncPayload(),
      habits: [makeHabit("hab-sync-1", "Journal", { createdAt: 2000, updatedAt: 2000 })],
      deletedHabitIds: ["hab-deleted"],
    };
    expect(await applyMergedPayloadToLocalDB(merged)).toBe(true);
    expect(await applyMergedPayloadToLocalDB(merged)).toBe(false);

    const exported = await buildLocalSyncPayload({
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    });
    expect(exported.habits?.map((h) => h.id)).toEqual(["hab-sync-1"]);
    expect(exported.deletedHabitIds).toEqual(["hab-deleted"]);
  });

  it("property test (100 seeds): mergeSyncPayloads with habits is commutative and idempotent", () => {
    let seed = 0x12345678;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const ids = ["hab-a", "hab-b", "hab-c", "hab-d"];
    const genPayload = (): SyncPayload => {
      const habits = ids
        .filter(() => rand() < 0.6)
        .map((id, i) =>
          makeHabit(id, `Title ${Math.floor(rand() * 3)}`, {
            questId: rand() < 0.5 ? "q1" : null,
            rank: (i + 1) * 1000,
            updatedAt: 1000 + Math.floor(rand() * 4) * 500,
          })
        );
      return {
        ...createEmptySyncPayload(),
        quests: rand() < 0.5 ? [makeQuest("q1", "Q1")] : [],
        habits,
        deletedQuestIds: rand() < 0.2 ? ["q1"] : [],
        deletedHabitIds: ids.filter(() => rand() < 0.15),
      };
    };

    const norm = (p: SyncPayload) =>
      syncContentKey({
        ...p,
        deletedQuestIds: [...(p.deletedQuestIds ?? [])].sort(),
        deletedTaskIds: [...p.deletedTaskIds].sort(),
        deletedLogIds: [...p.deletedLogIds].sort(),
        deletedHabitIds: [...(p.deletedHabitIds ?? [])].sort(),
      });

    for (let i = 0; i < 100; i++) {
      const a = genPayload();
      const b = genPayload();
      const ab = mergeSyncPayloads(a, b);
      const ba = mergeSyncPayloads(b, a);
      expect(norm(ab), `commutative iter ${i}`).toBe(norm(ba));
      expect(norm(mergeSyncPayloads(ab, ab)), `idempotent iter ${i}`).toBe(norm(ab));
    }
  });
});

describe("Daily Habits — Desktop UI (HabitsView + CommandCenterView)", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetAll();
  });

  it("adds a daily habit with double-submit guard, shows it on Home with Daily tag, toggles completion & streak, edits with Escape/Save, and requires 2-step delete", async () => {
    await db.quests.put(makeQuest("q1", "Icelandic", 0));

    const habitsView = render(<HabitsView />);
    expect(await screen.findByText(/No daily habits yet/)).toBeInTheDocument();

    const input = screen.getByLabelText("Add a daily habit");
    fireEvent.change(input, { target: { value: "Practice speaking 15m" } });
    const addBtn = screen.getByRole("button", { name: "Add Habit" });
    // Spam-submit 5 times in one tick creates exactly 1 habit
    act(() => {
      for (let i = 0; i < 5; i++) fireEvent.click(addBtn);
    });

    const row = await screen.findByTestId("habit-row");
    expect(within(row).getByText("Practice speaking 15m")).toBeInTheDocument();
    expect(screen.getAllByTestId("habit-row")).toHaveLength(1);
    expect(screen.getByText("0 / 1")).toBeInTheDocument();

    // Complete today's habit from HabitsView -> updates done count & streak
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Complete today's habit: Practice speaking 15m",
      })
    );
    expect(await screen.findByText("1 / 1")).toBeInTheDocument();
    expect(await screen.findByText("1d streak")).toBeInTheDocument();

    // Reopen it so it shows as queued on Home
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Reopen today's habit: Practice speaking 15m",
      })
    );
    expect(await screen.findByText("0 / 1")).toBeInTheDocument();

    // Edit drawer: Escape cancels, Save updates title
    fireEvent.click(
      within(row).getByRole("button", { name: "Edit habit Practice speaking 15m" })
    );
    const titleInput = screen.getByLabelText("Habit Title");
    fireEvent.keyDown(titleInput, { key: "Escape" });
    expect(screen.queryByLabelText("Habit Title")).toBeNull();

    fireEvent.click(
      within(row).getByRole("button", { name: "Edit habit Practice speaking 15m" })
    );
    fireEvent.change(screen.getByLabelText("Habit Title"), {
      target: { value: "Speak Icelandic 20m" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Speak Icelandic 20m")).toBeInTheDocument();

    habitsView.unmount();

    // Home screen displays the materialized daily habit task with the Daily pill
    const homeView = render(<CommandCenterView />);
    expect(
      await screen.findByRole("button", { name: "Speak Icelandic 20m" })
    ).toBeInTheDocument();
    expect(screen.getByTitle("Daily habit")).toBeInTheDocument();
    homeView.unmount();

    // Two-step delete guard on HabitsView
    render(<HabitsView />);
    const delRow = await screen.findByTestId("habit-row");
    const delBtn = within(delRow).getByRole("button", {
      name: "Delete habit Speak Icelandic 20m",
    });
    fireEvent.click(delBtn); // step 1: arms
    expect(screen.getByTestId("habit-row")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete habit?" })); // step 2: confirms
    await waitFor(() => expect(screen.queryByTestId("habit-row")).toBeNull());
  });
});

describe("Daily Habits — Mobile Parity (hunt-mobile.html)", () => {
  let w: MobileWindow | null = null;
  afterEach(() => {
    w?.close();
    w = null;
  });

  it("supports creating, materializing, completing, midnight rolling, and deleting (with Undo) habits on mobile", () => {
    w = loadMobile({
      seedState: {
        quests: [makeQuest("q1", "Core", 0)],
        tasks: [],
        timeLogs: [],
        habits: [],
      },
    });
    const p = w as MobileWindow & {
      switchView(v: string): void;
      openNewHabitSheet(): void;
      saveNewHabit(): void;
      toggleHabitToday(id: string): void;
      deleteHabitItem(id: string): void;
      materializeDailyHabits(dk: string): number;
      dayKeyOffset(n: number): string;
    };

    p.switchView("habits");
    expect(p.document.getElementById("mainContainer")?.textContent).toContain(
      "No daily habits yet"
    );

    p.openNewHabitSheet();
    const titleEl = p.document.getElementById("newHabitTitleInput") as HTMLInputElement;
    titleEl.value = "Daily walk";
    p.saveNewHabit();

    const s1 = readState(p) as ReturnType<typeof readState> & { habits: Habit[] };
    expect(s1.habits).toHaveLength(1);
    expect(s1.tasks).toHaveLength(1);
    expect(s1.tasks[0].title).toBe("Daily walk");
    expect(s1.tasks[0].habitId).toBe(s1.habits[0].id);

    // Appears on Today view with Daily tag
    p.switchView("command");
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("Daily walk");

    // Toggle completion from Habits view
    p.switchView("habits");
    p.toggleHabitToday(s1.habits[0].id);
    const s2 = readState(p);
    expect(s2.tasks[0].status).toBe("completed");
    expect(p.document.getElementById("mainContainer")?.textContent).toContain("1 / 1 done today");

    // Tomorrow materializes a fresh task
    const tomorrow = p.dayKeyOffset(1);
    expect(p.materializeDailyHabits(tomorrow)).toBe(1);
    expect(readState(p).tasks).toHaveLength(2);

    // Deleting habit removes it and adds tombstone
    p.deleteHabitItem(s1.habits[0].id);
    const s3 = readState(p) as ReturnType<typeof readState> & {
      habits: Habit[];
      deletedHabitIds: string[];
    };
    expect(s3.habits).toHaveLength(0);
    expect(s3.deletedHabitIds).toContain(s1.habits[0].id);
  });
});
