import type { ChecklistItem, Task } from "./domainTypes";
import { isSafeSyncId } from "./syncIds";

/**
 * Checklist rules shared by the desktop and the phone (both apply edits with
 * applyChecklistEdit, so a Checklist edited on either device has the same
 * shape the sync validator keeps). The Checklist lives on the Task row and
 * merges with it as one row (ADR-0001). Ticking every item never completes
 * the Task: that stays the user's own action.
 */

/** Items kept in one Task's Checklist (the validator keeps the first ones). */
export const MAX_CHECKLIST_ITEMS = 200;
/** Text of one Checklist item. */
export const MAX_CHECKLIST_TEXT_LENGTH = 500;

export type ChecklistEdit =
  | { kind: "add"; id: string; text: string }
  | { kind: "toggle"; id: string }
  | { kind: "rename"; id: string; text: string }
  | { kind: "move"; id: string; toIndex: number }
  | { kind: "remove"; id: string };

type ChecklistTask = Pick<Task, "habitId" | "checklist">;

/** The Task's items (an absent or malformed Checklist reads as empty). */
export function checklistOf(task: ChecklistTask): ChecklistItem[] {
  return Array.isArray(task.checklist) ? task.checklist : [];
}

/** A new item id (`chk-<ms>-<4 base-36>`), a safe sync id unique within its Checklist. */
export function newChecklistItemId(now: number = Date.now(), random: () => number = Math.random): string {
  return `chk-${now}-${random().toString(36).slice(2, 6).padEnd(4, "0")}`;
}

/** Habit day Tasks never hold a Checklist: a Habit's Outcome comes only from its Habit Kind. */
export function canHoldChecklist(task: ChecklistTask): boolean {
  return !task.habitId;
}

/** `text` cut to the item limit without splitting a surrogate pair (the validator's cut). */
function cutText(text: string): string {
  const max = MAX_CHECKLIST_TEXT_LENGTH;
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Trimmed and cut, so the validator never changes it; "" when blank. */
function cleanText(text: string): string {
  return cutText(text.trim()).trimEnd();
}

/**
 * Sync validation of a Checklist: its legitimate items as new flat
 * `{ id, text, done }` objects, in order. A safe id not seen before and string
 * text (cut to the limit) are required, `done` is true only when it is
 * literally true, and only the first MAX_CHECKLIST_ITEMS are kept. An empty
 * list stays empty. (The caller drops the Checklist of a habit day Task.)
 */
export function sanitizeChecklist(raw: readonly unknown[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (items.length >= MAX_CHECKLIST_ITEMS) break;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const { id, text, done } = value as Record<string, unknown>;
    if (!isSafeSyncId(id) || seen.has(id) || typeof text !== "string") continue;
    seen.add(id);
    items.push({ id, text: cutText(text), done: done === true });
  }
  return items;
}

/**
 * The Task's Checklist after `edit`, as a new array, or null when the edit
 * changes nothing or is refused (a habit day Task, blank text, an unknown or
 * duplicate id, a full Checklist).
 */
export function applyChecklistEdit(task: ChecklistTask, edit: ChecklistEdit): ChecklistItem[] | null {
  if (!canHoldChecklist(task)) return null;
  const items = checklistOf(task);
  const index = items.findIndex((i) => i.id === edit.id);
  switch (edit.kind) {
    case "add": {
      const text = cleanText(edit.text);
      if (!text || index !== -1 || items.length >= MAX_CHECKLIST_ITEMS) return null;
      return [...items, { id: edit.id, text, done: false }];
    }
    case "toggle":
      if (index === -1) return null;
      return items.map((i, n) => (n === index ? { ...i, done: !i.done } : i));
    case "rename": {
      const text = cleanText(edit.text);
      if (index === -1 || !text || items[index].text === text) return null;
      return items.map((i, n) => (n === index ? { ...i, text } : i));
    }
    case "move": {
      if (index === -1 || !Number.isInteger(edit.toIndex)) return null;
      const to = Math.min(items.length - 1, Math.max(0, edit.toIndex));
      if (to === index) return null;
      const next = items.slice();
      const [moved] = next.splice(index, 1);
      next.splice(to, 0, moved);
      return next;
    }
    case "remove":
      if (index === -1) return null;
      return items.filter((_, n) => n !== index);
  }
}

/** "n of m" ticked, or null when the Task has no Checklist items. */
export function checklistProgress(task: ChecklistTask): { done: number; total: number } | null {
  const items = checklistOf(task);
  if (items.length === 0) return null;
  return { done: items.filter((i) => i.done === true).length, total: items.length };
}
