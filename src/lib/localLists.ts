import { db } from "./db";
import { applyListEdit, buildList, cleanListTitle, newListId, type ListEdit } from "./lists";
import { emitChange } from "./localChange";
import { recordDeletedListTombstone } from "./syncTombstones";
import { compareRank } from "./syncTypes";
import { nextStamp, RANK_STEP } from "./taskQueue";

/**
 * The Local Store's writes to standalone Lists, with the same invariants as
 * localStore.ts: R6 stamps on every edit, the tombstone recorded inside the
 * delete transaction, one local-change signal per write. Every rule (title
 * cut, item edits, Clear ticked, Untick all) is the shared one in lists.ts.
 */

/** Adds a List at the end; false when the title is blank. */
async function createList(title: string): Promise<boolean> {
  const wrote = await db.transaction("rw", db.lists, async () => {
    const lists = (await db.lists.toArray()).sort(compareRank);
    const last = lists[lists.length - 1];
    const now = Date.now();
    const list = buildList({
      id: newListId(now),
      title,
      rank: (last ? Number(last.rank) || 0 : 0) + RANK_STEP,
      now,
    });
    if (!list) return false;
    await db.lists.add(list);
    return true;
  });
  if (wrote) emitChange();
  return wrote;
}

/** Renames a List; false when the List is gone, or the title is blank or unchanged. */
async function renameList(listId: string, title: string): Promise<boolean> {
  const clean = cleanListTitle(title);
  const wrote = await db.transaction("rw", db.lists, async () => {
    const row = await db.lists.get(listId);
    if (!row || !clean || row.title === clean) return false;
    await db.lists.update(listId, { title: clean, updatedAt: nextStamp(row) });
    return true;
  });
  if (wrote) emitChange();
  return wrote;
}

/** One item edit, Clear ticked or Untick all by the shared rule; false when it changes nothing. */
async function editList(listId: string, edit: ListEdit): Promise<boolean> {
  const wrote = await db.transaction("rw", db.lists, async () => {
    const row = await db.lists.get(listId);
    const items = row && applyListEdit(row, edit);
    if (!row || !items) return false;
    await db.lists.update(listId, { items, updatedAt: nextStamp(row) });
    return true;
  });
  if (wrote) emitChange();
  return wrote;
}

/** Deletes a List here and, through its tombstone, on every synced device. */
async function deleteList(listId: string): Promise<void> {
  await db.transaction("rw", db.lists, async () => {
    recordDeletedListTombstone(listId);
    await db.lists.delete(listId);
  });
  emitChange();
}

export const localLists = { createList, renameList, editList, deleteList };
