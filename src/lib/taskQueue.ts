import { habitTaskId, isTaskVisibleToday } from "./dateUtils";
import type { Habit, Task } from "./domainTypes";
import { compareRank } from "./syncTypes";

/**
 * Deterministic TimeLog id for one focus session. The same session flushed on
 * two devices (or twice on one) yields the same id, so the union merge keeps
 * exactly one log for it.
 */
export function sessionLogId(taskId: string, sessionStartedAt: number): string {
  return `log-${sessionStartedAt}-${taskId}`;
}

/**
 * SHARED "next focus task" rule: among QUEUED tasks that are unscheduled or
 * scheduled for `todayKey` or earlier, the first quest task in rank order
 * (compareRank: rank, ties by id), else the first other task; null when none.
 * Pure: `tasks` is not modified.
 */
export function pickNextFocusTask(
  tasks: readonly Task[],
  todayKey: string
): Task | null {
  const today = tasks
    .filter((t) => t.status === "queued" && isTaskVisibleToday(t, todayKey))
    .sort(compareRank);
  return today.find((t) => t.questId !== null) ?? today[0] ?? null;
}

/** Distance between neighbouring ranks for rows placed at the top/bottom. */
export const RANK_STEP = 1000;
/** Smallest rank gap per row placed between two kept rows. */
const MIN_RANK_GAP = 1e-6;

export const rankValue = (t: { rank?: unknown }): number => Number(t.rank) || 0;

/**
 * Minimal-move rank plan for showing `rows` in exactly this order (rank order
 * with ties by id, see compareRank). Returns the new rank of every row that has
 * to change; all other rows keep their rank and are not written.
 *
 * Keeps the largest set of rows whose current ranks are already in the desired
 * order (a longest increasing subsequence under compareRank, restricted to
 * choices that leave room for the rows in between) and places each other row
 * strictly between its final neighbours: a run of k rows between kept ranks a
 * and b gets a + (b - a) * j / (k + 1); above the first kept row next - 1000·j;
 * below the last prev + 1000·j. A single drag therefore rewrites one row.
 * `preferMovedId` (the dragged row) is the one rewritten when several minimal
 * plans exist. Only if no valid plan results (exhausted float precision)
 * everything is renumbered (i + 1) * 1000.
 */
export function planRankMoves(
  rows: ReadonlyArray<Pick<Task, "id" | "rank">>,
  preferMovedId?: string
): Map<string, number> {
  const n = rows.length;
  const plan = new Map<string, number>();
  if (n === 0) return plan;

  const r = rows.map(rankValue);
  // Score = 2 per kept row, 1 for keeping the preferred-to-move row: the most
  // kept rows first, then the plan that rewrites the dragged row.
  const weight: number[] = rows.map((t) => (t.id === preferMovedId ? 1 : 2));
  const canKeepBoth = (i: number, j: number): boolean => {
    const between = j - i - 1;
    if (between === 0) return compareRank(rows[i], rows[j]) < 0;
    return (r[j] - r[i]) / (between + 1) >= MIN_RANK_GAP;
  };

  // score[j]: best plan for rows[0..j] that keeps row j (rows above the first
  // kept row always fit at the top, rows below the last at the bottom).
  const score = weight.slice();
  const prev = new Array<number>(n).fill(-1);
  for (let j = 1; j < n; j++) {
    for (let i = 0; i < j; i++) {
      if (score[i] + weight[j] > score[j] && canKeepBoth(i, j)) {
        score[j] = score[i] + weight[j];
        prev[j] = i;
      }
    }
  }
  let last = 0;
  for (let j = 1; j < n; j++) if (score[j] > score[last]) last = j;
  const kept: number[] = [];
  for (let j = last; j !== -1; j = prev[j]) kept.push(j);
  kept.reverse();

  const finalRank = r.slice();
  const first = kept[0];
  for (let idx = first - 1, step = 1; idx >= 0; idx--, step++) {
    finalRank[idx] = r[first] - RANK_STEP * step;
  }
  for (let m = 0; m + 1 < kept.length; m++) {
    const a = kept[m];
    const b = kept[m + 1];
    const between = b - a - 1;
    for (let j = 1; j <= between; j++) {
      finalRank[a + j] = r[a] + ((r[b] - r[a]) * j) / (between + 1);
    }
  }
  const tail = kept[kept.length - 1];
  for (let idx = tail + 1, step = 1; idx < n; idx++, step++) {
    finalRank[idx] = r[tail] + RANK_STEP * step;
  }

  const ordered =
    finalRank.every(Number.isFinite) &&
    rows.every(
      (row, i) =>
        i === 0 ||
        compareRank(
          { id: rows[i - 1].id, rank: finalRank[i - 1] },
          { id: row.id, rank: finalRank[i] }
        ) < 0
    );
  if (!ordered) {
    for (let i = 0; i < n; i++) finalRank[i] = (i + 1) * RANK_STEP;
  }

  rows.forEach((row, i) => {
    if (row.rank !== finalRank[i]) plan.set(row.id, finalRank[i]);
  });
  return plan;
}

/**
 * Global queue order after dropping `draggedId` onto `targetId` in a list that
 * shows a subset (`listIds`, in display order) of all pending tasks
 * (`allPendingIds`, in rank order). The dragged task lands next to the target
 * (before it when dragged upwards in that list, after it when dragged
 * downwards); every other task keeps its place, so reorderTaskQueue rewrites
 * exactly one row and tasks outside the list are never touched.
 * Returns null when the drop changes nothing.
 */
export function orderAfterDrop(
  allPendingIds: readonly string[],
  listIds: readonly string[],
  draggedId: string,
  targetId: string
): string[] | null {
  const from = listIds.indexOf(draggedId);
  const to = listIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const order = allPendingIds.filter((id) => id !== draggedId);
  let at = order.indexOf(targetId);
  if (at === -1) return null;
  if (to > from) at += 1;
  order.splice(at, 0, draggedId);
  return order;
}

/**
 * Pure helper: builds the deterministic daily task row for a habit on `dateKey`.
 * Uses `updatedAt = habit.createdAt || 1` and `rank = habit.rank` so laptop and
 * phone materialize identical rows offline and any real user action wins LWW.
 */
export function buildHabitTaskRow(habit: Habit, dateKey: string): Task {
  const stamp = Math.max(1, Number(habit.createdAt) || 1);
  return {
    id: habitTaskId(habit.id, dateKey),
    title: habit.title,
    notes: habit.notes || "",
    questId: habit.questId || null,
    habitId: habit.id,
    status: "queued",
    rank: Number.isFinite(habit.rank) ? habit.rank : RANK_STEP,
    accumulatedSeconds: 0,
    scheduledDate: dateKey,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * R6: stamp for a local write to an existing row. Never older than the row it
 * replaces (the row may carry a newer stamp from a device whose clock is
 * ahead), so the edit cannot silently lose last-write-wins on the next sync.
 */
export function nextStamp(
  row: { updatedAt?: number } | null | undefined,
  now: number = Date.now()
): number {
  return Math.max(now, (row?.updatedAt || 0) + 1);
}
