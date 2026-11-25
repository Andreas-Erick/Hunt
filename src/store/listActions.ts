import type { ListEdit } from "@/lib/lists";
import { localLists } from "@/lib/localLists";
import type { RunAction } from "./habitDayActions";

/** The command store's actions on standalone Lists (rules in lists.ts). */
export interface ListActions {
  /** Resolves to true only when the List was created (false for a blank name or a failed write). */
  createList: (title: string) => Promise<boolean>;
  /** Resolves to true only when the name changed and was saved. */
  renameList: (listId: string, title: string) => Promise<boolean>;
  /** One item edit, Clear ticked or Untick all; true only when the List changed and was saved. */
  editList: (listId: string, edit: ListEdit) => Promise<boolean>;
  /** Deletes a List here and, through its tombstone, on every synced device. */
  deleteList: (listId: string) => Promise<void>;
}

export function listActions(run: RunAction): ListActions {
  /** run() for a write that may change nothing: true only when it ran and wrote. */
  const runWrite = async (name: string, write: () => Promise<boolean>): Promise<boolean> => {
    let wrote = false;
    const ok = await run(name, async () => {
      wrote = await write();
    });
    return ok && wrote;
  };
  return {
    createList: (title) => runWrite("createList", () => localLists.createList(title)),
    renameList: (listId, title) => runWrite("renameList", () => localLists.renameList(listId, title)),
    editList: (listId, edit) => runWrite("editList", () => localLists.editList(listId, edit)),
    deleteList: async (listId) => {
      await run("deleteList", () => localLists.deleteList(listId));
    },
  };
}
