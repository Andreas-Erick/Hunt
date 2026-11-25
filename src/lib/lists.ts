import type { ChecklistItem, List } from "./domainTypes";
import { applyChecklistEdit, checklistProgress, sanitizeChecklist, type ChecklistEdit } from "./checklist";
import { isSafeSyncId } from "./syncIds";
import { copyScalarExtras } from "./syncRowExtras";
import { clampLength, clampTitle } from "./textLimits";

/**
 * List rules shared by the desktop, the phone and the sync server. A List is
 * its own synced collection (ADR-0001), merged per row: two devices that edit
 * the same List while apart keep only the newer row's items. Its items are
 * Checklist items and every item edit uses the Checklist rules, so a List
 * behaves exactly like a Task's Checklist plus "Clear ticked" and "Untick all".
 */

/** Longest List title kept; longer titles are cut. */
export const MAX_LIST_TITLE_LENGTH = 300;
/** Lists per payload (a structural cap: more rejects the payload, as habits do). */
export const MAX_SYNC_LISTS = 1000;

export type ListEdit = ChecklistEdit | { kind: "clearTicked" } | { kind: "untickAll" };

/** A new List id (`list-<ms>-<4 base-36>`), a safe sync id. */
export function newListId(now: number = Date.now(), random: () => number = Math.random): string {
  return `list-${now}-${random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/** The title as stored: trimmed and cut to the sync limit; "" when blank. */
export function cleanListTitle(title: string): string {
  return clampTitle(title, MAX_LIST_TITLE_LENGTH).trimEnd();
}

/** A new empty List, or null when the title is blank. */
export function buildList(params: { id: string; title: string; rank: number; now: number }): List | null {
  const title = cleanListTitle(params.title);
  if (!title) return null;
  return { id: params.id, title, items: [], rank: params.rank, createdAt: params.now, updatedAt: params.now };
}

/** The List's items (a malformed item list reads as empty). */
export function listItemsOf(list: Pick<List, "items">): ChecklistItem[] {
  return Array.isArray(list.items) ? list.items : [];
}

/**
 * The List's items after `edit`, as a new array, or null when the edit changes
 * nothing or is refused. Item edits follow the Checklist rules; "clearTicked"
 * removes the ticked items and "untickAll" unticks every item, in place.
 */
export function applyListEdit(list: Pick<List, "items">, edit: ListEdit): ChecklistItem[] | null {
  const items = listItemsOf(list);
  switch (edit.kind) {
    case "clearTicked":
      return items.some((i) => i.done) ? items.filter((i) => !i.done) : null;
    case "untickAll":
      return items.some((i) => i.done) ? items.map((i) => (i.done ? { ...i, done: false } : i)) : null;
    default:
      return applyChecklistEdit({ checklist: items }, edit);
  }
}

/** Ticked of total (0 of 0 for an empty List). */
export function listProgress(list: Pick<List, "items">): { done: number; total: number } {
  return checklistProgress({ checklist: listItemsOf(list) }) ?? { done: 0, total: 0 };
}

const LIST_FIELDS: ReadonlySet<string> = new Set(["id", "title", "items", "rank", "createdAt", "updatedAt"]);

const isStamp = (value: unknown): value is number =>
  typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

/**
 * Sync validation of one List: a new sanitized row, or null when it cannot be
 * legitimate (not an object, unsafe id, title not a string). The title is cut,
 * items are validated as Checklist items (a missing list reads as empty), an
 * invalid rank or stamp is left out, unknown scalar fields are kept.
 */
export function sanitizeList(raw: unknown): List | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  const { id, title, items, rank, createdAt, updatedAt } = src;
  if (!isSafeSyncId(id) || typeof title !== "string") return null;
  const row: Partial<List> & Pick<List, "id" | "title" | "items"> = {
    id,
    title: clampLength(title, MAX_LIST_TITLE_LENGTH),
    items: Array.isArray(items) ? sanitizeChecklist(items) : [],
  };
  if (typeof rank === "number" && Number.isFinite(rank)) row.rank = rank;
  if (isStamp(createdAt)) row.createdAt = createdAt;
  if (isStamp(updatedAt)) row.updatedAt = updatedAt;
  copyScalarExtras(row, src, LIST_FIELDS);
  return row as List;
}
