/**
 * Lane layout for Home's day timeline (components/DayTimeline.tsx): hour window
 * and non-overlapping columns for the day's focus blocks.
 */
import { safeSeconds } from "./reviewCommon";

export interface TimelineBlockInput {
  id: string;
  startTime: number;
  durationSeconds: number;
}

export interface TimelineBlockPlacement {
  id: string;
  startHour: number;
  endHour: number;
  colIndex: number;
  totalCols: number;
}

export interface DayTimelineLayout {
  windowStartHour: number;
  windowEndHour: number;
  hours: number[];
  placements: Map<string, TimelineBlockPlacement>;
}

/**
 * Computes dynamic hour bounds (expanding beyond 08:00–22:00 for early/late
 * sessions) and non-overlapping column lanes (capped at 4 columns) so dense or
 * concurrent sessions on Today's Timeline remain distinct and readable.
 */
export function layoutTimelineBlocks(
  items: readonly TimelineBlockInput[],
  defaultStartHour = 8,
  defaultEndHour = 22
): DayTimelineLayout {
  let minStart = defaultStartHour;
  let maxEnd = defaultEndHour;

  const raw = items.map((item) => {
    const d = new Date(item.startTime);
    const rawStart = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const safeStart = Number.isFinite(rawStart) ? Math.max(0, Math.min(23.75, rawStart)) : defaultStartHour;
    const durHr = Math.max(0.42, safeSeconds(item.durationSeconds) / 3600);
    const safeEnd = Math.min(24, safeStart + durHr);
    if (safeStart < minStart) minStart = Math.max(0, Math.floor(safeStart));
    if (safeEnd > maxEnd) maxEnd = Math.min(24, Math.ceil(safeEnd));
    return { id: item.id, startHour: safeStart, endHour: safeEnd };
  });

  raw.sort((a, b) => a.startHour - b.startHour || b.endHour - a.endHour);

  const MAX_COLS = 4;
  const placements = new Map<string, TimelineBlockPlacement>();
  let cluster: Array<{ id: string; startHour: number; endHour: number; col: number }> = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const flushCluster = () => {
    if (cluster.length === 0) return;
    const usedCols = Math.min(
      MAX_COLS,
      Math.max(1, ...cluster.map((c) => c.col + 1))
    );
    for (const c of cluster) {
      placements.set(c.id, {
        id: c.id,
        startHour: c.startHour,
        endHour: c.endHour,
        colIndex: c.col % usedCols,
        totalCols: usedCols,
      });
    }
    cluster = [];
    clusterEnd = -1;
    laneEnds = [];
  };

  for (const item of raw) {
    if (cluster.length > 0 && item.startHour >= clusterEnd - 0.01) {
      flushCluster();
    }
    let assigned = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i] <= item.startHour + 0.01) {
        assigned = i;
        laneEnds[i] = item.endHour;
        break;
      }
    }
    if (assigned === -1) {
      if (laneEnds.length < MAX_COLS) {
        assigned = laneEnds.length;
        laneEnds.push(item.endHour);
      } else {
        // Pick lane finishing earliest so >4 simultaneous bursts never vanish
        let earliestIdx = 0;
        for (let i = 1; i < laneEnds.length; i++) {
          if (laneEnds[i] < laneEnds[earliestIdx]) earliestIdx = i;
        }
        assigned = earliestIdx;
        laneEnds[earliestIdx] = Math.max(laneEnds[earliestIdx], item.endHour);
      }
    }
    cluster.push({ ...item, col: assigned });
    if (item.endHour > clusterEnd) clusterEnd = item.endHour;
  }
  flushCluster();

  const hours: number[] = [];
  for (let h = minStart; h <= maxEnd; h++) hours.push(h);

  return {
    windowStartHour: minStart,
    windowEndHour: maxEnd,
    hours,
    placements,
  };
}
