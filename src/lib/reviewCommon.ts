// Small rules shared by the Review report, its heatmap and the day timeline.

/** Which quest a Review shows: every quest, Other work, or one quest id. */
export type ReviewScope = "ALL" | "OTHER" | string;

/** A duration in seconds, or 0 for anything that is not a positive number. */
export function safeSeconds(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whether a row with `questId` belongs to the Review `scope`. */
export function matchesScope(questId: string | null | undefined, scope: ReviewScope): boolean {
  const normalized = questId ?? null;
  if (scope === "ALL") return normalized !== null;
  if (scope === "OTHER") return normalized === null;
  return normalized === scope;
}
