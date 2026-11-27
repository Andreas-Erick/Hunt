import type { Habit, List, Quest, QuestAccent, Task, TimeLog } from "./domainTypes";
import { habitTaskId } from "./dateUtils";
import { dateFromKey, dateKeyFromOffset, toLocalDateKey } from "./dateKeys";

/**
 * The browser demo's sample data (ADR-0010): what a portfolio visitor sees on first load and
 * after Reset demo. Pure and deterministic: the same `now` always builds the same rows, and
 * every date is relative to it, so the demo always has work queued today, a week planned
 * ahead, and eight weeks of focus history for Review and the heatmap.
 *
 * Never used by the native app, whose first-run seed (db.ts) holds no history.
 */
export interface DemoSeed {
  quests: Quest[];
  tasks: Task[];
  habits: Habit[];
  lists: List[];
  timeLogs: TimeLog[];
}

/** Days of focus history behind today. */
export const DEMO_HISTORY_DAYS = 56;

const MINUTE_MS = 60_000;

/** mulberry32: a small seeded PRNG, so the history looks varied but is the same every time. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Local timestamp of `hour` (may be fractional) on the day `dateKey`. */
function at(dateKey: string, hour: number): number {
  // dateFromKey answers local noon (DST-safe day maths); the hour counts from midnight.
  const midnight = dateFromKey(dateKey);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() + Math.round(hour * 60) * MINUTE_MS;
}

const QUESTS: Array<Omit<Quest, "createdAt">> = [
  {
    id: "quest-slot-0",
    slotIndex: 0,
    code: "SHIP-2.0",
    title: "Ship the 2.0 release",
    description: "Sync rewrite, the new Review screen and a calmer onboarding, out by the end of the quarter.",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
  },
  {
    id: "quest-slot-1",
    slotIndex: 1,
    code: "WRITING",
    title: "Write every week",
    description: "One essay a week on building small, local-first software.",
    accentColor: "amber",
    targetWeeklyHours: 4,
    archived: false,
  },
  {
    id: "quest-slot-2",
    slotIndex: 2,
    code: "HALF-MARA",
    title: "Run a half marathon",
    description: "Easy aerobic base, one long run a week, race day in spring.",
    accentColor: "emerald",
    targetWeeklyHours: 4,
    archived: false,
  },
];

const OTHER = { questId: null, code: "OTHER", accent: "slate" as const };

/** Past work the history's sessions are logged against, by Quest (null = Other). */
const PAST_WORK: Record<string, string[]> = {
  "quest-slot-0": [
    "Merge the row-level sync tests",
    "Profile the Review heatmap",
    "Fix the tablet layout at 768px",
    "Write the migration for habit days",
    "Review the onboarding copy",
    "Cut the 1.9 release",
  ],
  "quest-slot-1": [
    "Draft: why local-first",
    "Edit the essay on streaks",
    "Outline: small tools, long lives",
  ],
  "quest-slot-2": ["Easy 6 km", "Long run, 14 km", "Intervals: 6 × 400 m"],
  other: ["Inbox zero", "Pay the invoices"],
};

function questOf(id: string | null): { questId: string | null; code: string; accent: QuestAccent | "slate" } {
  const quest = QUESTS.find((q) => q.id === id);
  return quest ? { questId: quest.id, code: quest.code, accent: quest.accentColor } : OTHER;
}

export function buildDemoSeed(now: number = Date.now()): DemoSeed {
  const random = seededRandom(20_261_127);
  const today = toLocalDateKey(now);
  const day = (offset: number) => dateKeyFromOffset(today, offset);
  const historyStart = at(day(-DEMO_HISTORY_DAYS), 9);

  const quests: Quest[] = QUESTS.map((q) => ({ ...q, createdAt: historyStart }));
  const tasks: Task[] = [];
  const timeLogs: TimeLog[] = [];
  let rank = 1000;
  const nextRank = () => (rank += 1000);

  const task = (t: Partial<Task> & Pick<Task, "id" | "title">): Task => {
    const row: Task = {
      notes: "",
      questId: null,
      status: "queued",
      rank: nextRank(),
      accumulatedSeconds: 0,
      createdAt: historyStart,
      ...t,
    };
    tasks.push(row);
    return row;
  };

  /** A focus session on `row`, ending at `endTime`; adds its time to the Task. */
  const logSession = (row: Task, endTime: number, minutes: number) => {
    const durationSeconds = minutes * 60;
    const startTime = endTime - durationSeconds * 1000;
    const quest = questOf(row.questId);
    row.accumulatedSeconds += durationSeconds;
    timeLogs.push({
      id: `log-${startTime}-${row.id}`,
      taskId: row.id,
      taskTitleSnapshot: row.title,
      questId: quest.questId,
      questCodeSnapshot: quest.code,
      accentColorSnapshot: quest.accent,
      startTime,
      endTime,
      durationSeconds,
      dateKey: toLocalDateKey(startTime),
    });
  };

  // ---- History: finished Tasks and their sessions, most weekdays, lighter weekends --------
  const pastTasks = new Map<string, Task>();
  const pastTaskFor = (questKey: string, weekIndex: number): Task => {
    const titles = PAST_WORK[questKey];
    const title = titles[weekIndex % titles.length];
    const id = `demo-past-${questKey}-${weekIndex}`;
    const existing = pastTasks.get(id);
    if (existing) return existing;
    const row = task({
      id,
      title,
      questId: questKey === "other" ? null : questKey,
      status: "completed",
      createdAt: historyStart,
    });
    pastTasks.set(id, row);
    return row;
  };

  for (let offset = -DEMO_HISTORY_DAYS; offset < 0; offset += 1) {
    const key = day(offset);
    const weekday = dateFromKey(key).getDay();
    const weekend = weekday === 0 || weekday === 6;
    const weekIndex = Math.floor((offset + DEMO_HISTORY_DAYS) / 7);
    // A few quiet days, so the heatmap has texture instead of a solid block.
    if (random() < (weekend ? 0.45 : 0.1)) continue;

    let hour = 8.5 + random();
    const sessions: Array<[string, number]> = weekend
      ? [["quest-slot-2", 45 + Math.round(random() * 60)]]
      : [
          ["quest-slot-0", 50 + Math.round(random() * 70)],
          ["quest-slot-0", 25 + Math.round(random() * 50)],
          [random() < 0.6 ? "quest-slot-1" : "other", 25 + Math.round(random() * 35)],
        ];
    if (!weekend && random() < 0.4) sessions.push(["quest-slot-2", 30 + Math.round(random() * 30)]);

    for (const [questKey, minutes] of sessions) {
      const row = pastTaskFor(questKey, weekIndex);
      hour += minutes / 60;
      logSession(row, at(key, hour), minutes);
      row.completedAt = Math.max(row.completedAt ?? 0, at(key, hour));
      row.scheduledDate = key;
      hour += 0.25 + random() * 0.75;
    }
  }

  // ---- Today: one done already (it opens the Done-list), the rest queued ------------------
  const doneToday = task({
    id: "demo-today-done",
    title: "Answer the beta testers' sync reports",
    questId: "quest-slot-0",
    status: "completed",
    scheduledDate: today,
    createdAt: at(day(-1), 17),
  });
  // Finished at 10:00, or 20 minutes ago before then; never yesterday, never in the future.
  const doneAt = Math.min(now - 20 * MINUTE_MS, at(today, 10));
  if (doneAt - 40 * MINUTE_MS >= at(today, 0)) logSession(doneToday, doneAt, 40);
  doneToday.completedAt = Math.max(doneAt, at(today, 0));

  task({
    id: "demo-today-review",
    title: "Finish the new Review screen",
    notes: "Week, month and year scopes; the heatmap must stay readable at 360px.",
    questId: "quest-slot-0",
    scheduledDate: today,
    accumulatedSeconds: 55 * 60,
    checklist: [
      { id: "demo-chk-1", text: "Scope picker", done: true },
      { id: "demo-chk-2", text: "Heatmap legend", done: true },
      { id: "demo-chk-3", text: "Empty state for a new Quest", done: false },
      { id: "demo-chk-4", text: "Test on the tablet", done: false },
    ],
  });
  task({
    id: "demo-today-essay",
    title: "Draft this week's essay: the case for boring sync",
    notes: "Start from the merge rules. Three examples, one diagram.",
    questId: "quest-slot-1",
    scheduledDate: today,
    reminderTime: "16:30",
  });
  task({
    id: "demo-today-run",
    title: "Easy 7 km, nose breathing only",
    questId: "quest-slot-2",
    scheduledDate: today,
    reminderTime: "18:00",
  });
  task({ id: "demo-today-other", title: "Renew the domain name", scheduledDate: today });

  // ---- The week ahead, for Plan ----------------------------------------------------------
  const planned: Array<[number, string | null, string]> = [
    [1, "quest-slot-0", "Wire the onboarding into the real sync flow"],
    [1, "quest-slot-1", "Edit and publish the essay"],
    [2, "quest-slot-0", "Release candidate: full test pass"],
    [2, null, "Book the physio"],
    [3, "quest-slot-2", "Long run, 16 km"],
    [4, "quest-slot-0", "Write the 2.0 release notes"],
    [5, "quest-slot-1", "Outline next week's essay"],
    [6, "quest-slot-2", "Rest day walk"],
  ];
  planned.forEach(([offset, questId, title], i) =>
    task({ id: `demo-plan-${i + 1}`, title, questId, scheduledDate: day(offset) })
  );

  // ---- Habits: one of each Kind, with a past to show streaks and rates -------------------
  const habitStart = at(day(-42), 7);
  const habits: Habit[] = [
    {
      id: "demo-habit-pages",
      title: "Morning pages",
      notes: "Three pages, longhand, before the laptop opens.",
      questId: "quest-slot-1",
      rank: 1000,
      createdAt: habitStart,
      reminderTimes: ["07:30"],
    },
    {
      id: "demo-habit-water",
      title: "Drink water",
      notes: "",
      questId: null,
      rank: 2000,
      createdAt: habitStart,
      kind: "count",
      target: 8,
      unit: "glasses",
    },
    {
      id: "demo-habit-strength",
      title: "Strength training",
      notes: "Squats, deadlifts, core. Twenty minutes is enough.",
      questId: "quest-slot-2",
      rank: 3000,
      createdAt: habitStart,
      frequencyHistory: [{ effectiveFrom: day(-42), frequency: { type: "perWeek", times: 3 } }],
    },
    {
      id: "demo-habit-phone",
      title: "No phone in bed",
      notes: "",
      questId: null,
      rank: 4000,
      createdAt: habitStart,
      kind: "avoid",
    },
  ];

  const habitDay = (habit: Habit, key: string, fields: Partial<Task>) =>
    task({
      id: habitTaskId(habit.id, key),
      title: habit.title,
      questId: habit.questId,
      habitId: habit.id,
      scheduledDate: key,
      createdAt: at(key, 6),
      ...fields,
    });

  const [pages, water, strength, phone] = habits;
  for (let offset = -42; offset < 0; offset += 1) {
    const key = day(offset);
    const weekday = dateFromKey(key).getDay();
    // The last nine days are all Met, so Morning pages shows a live streak.
    if (offset >= -9 || random() < 0.8) {
      habitDay(pages, key, { status: "completed", completedAt: at(key, 7.75) });
    }
    const glasses = Math.round(5 + random() * 5);
    habitDay(water, key, {
      amount: glasses,
      ...(glasses >= 8 ? { status: "completed", completedAt: at(key, 20) } : {}),
    });
    if (weekday === 1 || weekday === 3 || (weekday === 5 && random() < 0.7)) {
      habitDay(strength, key, { status: "completed", completedAt: at(key, 18.5) });
    }
    if (offset < -12 && random() < 0.12) habitDay(phone, key, { slips: 1 });
  }
  // Today, under way: three glasses so far, and this morning's pages done.
  habitDay(water, today, { amount: 3 });
  habitDay(pages, today, { status: "completed", completedAt: Math.min(now, at(today, 7.75)) });

  // ---- Lists -----------------------------------------------------------------------------
  const lists: List[] = [
    {
      id: "demo-list-race",
      title: "Race-day kit",
      items: [
        { id: "demo-race-1", text: "Bib and safety pins", done: true },
        { id: "demo-race-2", text: "Gels × 3", done: false },
        { id: "demo-race-3", text: "Old shirt for the start", done: false },
        { id: "demo-race-4", text: "Charge the watch", done: false },
      ],
      rank: 1000,
      createdAt: at(day(-5), 21),
      updatedAt: at(day(-5), 21),
    },
    {
      id: "demo-list-groceries",
      title: "Groceries",
      items: [
        { id: "demo-groc-1", text: "Oats", done: false },
        { id: "demo-groc-2", text: "Bananas", done: true },
        { id: "demo-groc-3", text: "Coffee beans", done: false },
      ],
      rank: 2000,
      createdAt: at(day(-1), 19),
      updatedAt: at(day(-1), 19),
    },
  ];

  // Every row ends up stamped, as rows written through the store are.
  for (const row of tasks) row.updatedAt = row.completedAt ?? row.createdAt;
  for (const quest of quests) quest.updatedAt = quest.createdAt;
  for (const habit of habits) habit.updatedAt = habit.createdAt;

  return { quests, tasks, habits, lists, timeLogs };
}
