import type { Habit, Quest, QuestAccent, Task, TimeLog } from "../../src/lib/domainTypes";

/**
 * A made-up person's week for the README screenshots: a side project, a language and a race.
 * Everything is relative to `now` (the frozen browser clock), with date keys in UTC to match the
 * capture config's timezone. Nothing here comes from a real user's data.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const dateKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface DemoData {
  quests: Quest[];
  tasks: Task[];
  habits: Habit[];
  timeLogs: TimeLog[];
}

export function buildDemoData(now: number): DemoData {
  const today = dateKey(now);
  const dayStart = Date.parse(`${today}T00:00:00Z`);
  const created = now - 21 * DAY;

  const quest = (
    slotIndex: 0 | 1 | 2,
    id: string,
    code: string,
    title: string,
    description: string,
    accentColor: QuestAccent,
    targetWeeklyHours: number
  ): Quest => ({ id, slotIndex, code, title, description, accentColor, targetWeeklyHours, archived: false, createdAt: created, updatedAt: created });

  const quests: Quest[] = [
    quest(0, "q-app", "APP", "Ship the budgeting app", "Get v1 into the app store before the end of the quarter.", "cyan", 10),
    quest(1, "q-spanish", "ES", "Conversational Spanish", "Hold a 20-minute conversation by the summer trip.", "amber", 4),
    quest(2, "q-race", "RUN", "Half marathon in spring", "Build up to 21 km with three runs a week.", "emerald", 5),
  ];
  const questById = new Map(quests.map((q) => [q.id, q]));

  const task = (t: Partial<Task> & Pick<Task, "id" | "title" | "questId">): Task => ({
    notes: "",
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: today,
    createdAt: now - 2 * DAY,
    updatedAt: now - 2 * DAY,
    ...t,
  });

  const tasks: Task[] = [
    task({ id: "t-sync", title: "Fix offline sync for shared budgets", questId: "q-app", rank: 1000, accumulatedSeconds: 50 * 60, notes: "Repro: edit on two phones while one is offline." }),
    task({ id: "t-onboarding", title: "Design the onboarding screens", questId: "q-app", rank: 2000 }),
    task({ id: "t-podcast", title: "Listen to one episode of Coffee Break Spanish", questId: "q-spanish", rank: 3000 }),
    task({ id: "t-tax", title: "File the quarterly tax return", questId: null, rank: 4000 }),
    task({ id: "t-store", title: "Write the App Store description", questId: "q-app", rank: 5000, scheduledDate: dateKey(now + DAY) }),
    task({ id: "t-shoes", title: "Book a gait analysis for new running shoes", questId: "q-race", rank: 6000, scheduledDate: dateKey(now + 2 * DAY) }),
    task({ id: "t-tests", title: "Add tests for the CSV importer", questId: "q-app", status: "completed", rank: 7000, accumulatedSeconds: 75 * 60, completedAt: dayStart + 11 * HOUR + 15 * MIN }),
    task({ id: "t-verbs", title: "Review past-tense verb flashcards", questId: "q-spanish", status: "completed", rank: 8000, accumulatedSeconds: 30 * 60, completedAt: dayStart + 8 * HOUR + 40 * MIN }),
  ];

  const habit = (id: string, title: string, questId: string | null, rank: number): Habit => ({
    id,
    title,
    notes: "",
    questId,
    rank,
    createdAt: created,
    updatedAt: created,
  });
  const habits: Habit[] = [
    habit("h-run", "Easy 5 km run", "q-race", 1000),
    habit("h-vocab", "15 minutes of vocabulary", "q-spanish", 2000),
    habit("h-read", "Read 20 pages", null, 3000),
    habit("h-stretch", "Stretch for 10 minutes", "q-race", 4000),
    habit("h-plan", "Pick tomorrow's top task", null, 5000),
  ];

  // Completed habit rows for past days, so streaks and the habit grid have history.
  // A few deliberate gaps keep it believable.
  const missed = new Set(["h-run:3", "h-run:6", "h-vocab:5", "h-read:2", "h-read:9", "h-read:10", "h-stretch:1", "h-stretch:4", "h-plan:7"]);
  for (const h of habits) {
    for (let daysAgo = 13; daysAgo >= 1; daysAgo--) {
      if (missed.has(`${h.id}:${daysAgo}`)) continue;
      const day = dateKey(now - daysAgo * DAY);
      const done = Date.parse(`${day}T07:30:00Z`) + h.rank * 1000;
      tasks.push({
        id: `habtsk-${day}-${h.id}`,
        title: h.title,
        notes: "",
        questId: h.questId,
        habitId: h.id,
        status: "completed",
        rank: h.rank,
        accumulatedSeconds: 0,
        scheduledDate: day,
        createdAt: done,
        updatedAt: done,
        completedAt: done,
      });
    }
  }
  // Today: the run is already done.
  tasks.push({
    id: `habtsk-${today}-h-run`,
    title: "Easy 5 km run",
    notes: "",
    questId: "q-race",
    habitId: "h-run",
    status: "completed",
    rank: 1000,
    accumulatedSeconds: 0,
    scheduledDate: today,
    createdAt: dayStart + 6 * HOUR,
    updatedAt: dayStart + 7 * HOUR,
    completedAt: dayStart + 7 * HOUR,
  });

  // Focus sessions over the last four weeks, plus today's done-list.
  const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
  const log = (taskId: string, questId: string | null, start: number, minutes: number): TimeLog => {
    const q = questId ? questById.get(questId) : undefined;
    return {
      id: `log-${start}-${taskId}`,
      taskId,
      taskTitleSnapshot: titleOf.get(taskId) ?? "Focus session",
      questId,
      questCodeSnapshot: q ? q.title : "Other",
      accentColorSnapshot: q ? q.accentColor : "slate",
      startTime: start,
      endTime: start + minutes * MIN,
      durationSeconds: minutes * 60,
      dateKey: dateKey(start),
    };
  };

  const timeLogs: TimeLog[] = [
    log("t-verbs", "q-spanish", dayStart + 8 * HOUR + 10 * MIN, 30),
    log("t-tests", "q-app", dayStart + 9 * HOUR + 30 * MIN, 45),
    log("t-tests", "q-app", dayStart + 10 * HOUR + 30 * MIN, 30),
    log("t-sync", "q-app", dayStart + 13 * HOUR, 50),
  ];
  // History: four weeks of finished work, one completed task per session, so Review, the heatmap
  // and the done-lists have shape while today's open tasks keep small, honest counters.
  const history: Array<{ questId: string | null; titles: string[]; hour: number; minutes: number; every: number }> = [
    { questId: "q-app", hour: 9, minutes: 90, every: 1, titles: ["Set up crash reporting", "Sketch the categories screen", "Refactor the transactions list", "Write the CSV export", "Fix rounding in monthly totals", "Add dark mode to settings", "Review the database schema", "Wire up bill reminders"] },
    { questId: "q-spanish", hour: 19, minutes: 30, every: 1, titles: ["Coffee Break Spanish episode", "Practise ordering at a café", "Write a short diary entry in Spanish", "Shadow a news clip in Spanish"] },
    { questId: "q-race", hour: 7, minutes: 70, every: 3, titles: ["Long run", "Tempo intervals", "Hill repeats"] },
    { questId: null, hour: 17, minutes: 35, every: 2, titles: ["Clear the inbox", "Pay the monthly bills", "Plan meals for the week"] },
  ];
  for (let daysAgo = 1; daysAgo <= 27; daysAgo++) {
    const day = Date.parse(`${dateKey(now - daysAgo * DAY)}T00:00:00Z`);
    history.forEach((h, i) => {
      if ((daysAgo + i) % h.every !== 0 || (daysAgo * 5 + i) % 7 === 0) return;
      const minutes = Math.max(20, h.minutes - ((daysAgo * 7 + i * 11) % 30));
      const start = day + h.hour * HOUR + ((daysAgo * 13) % 40) * MIN;
      const id = `t-done-${daysAgo}-${i}`;
      const title = h.titles[(daysAgo + i) % h.titles.length];
      tasks.push({
        id,
        title,
        notes: "",
        questId: h.questId,
        status: "completed",
        rank: 9000 + daysAgo * 10 + i,
        accumulatedSeconds: minutes * 60,
        scheduledDate: dateKey(start),
        createdAt: start - DAY,
        updatedAt: start + minutes * MIN,
        completedAt: start + minutes * MIN,
      });
      titleOf.set(id, title);
      timeLogs.push(log(id, h.questId, start, minutes));
    });
  }
  timeLogs.sort((a, b) => b.startTime - a.startTime);

  return { quests, tasks, habits, timeLogs };
}
