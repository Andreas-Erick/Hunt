import { db } from "./db";
import { logDiagnostic, summarizeError } from "./diagnostics";
import { MAX_LONG_TEXT_LENGTH } from "./syncTypes";
import { clampLength } from "./textLimits";

/**
 * Device-local localStorage mirror of an unsaved notes draft, written
 * synchronously on every keystroke: `hunt-notes-draft-v1:<taskId>` ->
 * `{ draft, base }` (base = the notes the draft was typed over). A reload or
 * navigation inside the debounce window does not blur or unmount the field,
 * and a Dexie write started in pagehide does not commit, so the mirror is what
 * survives; page boot restores it (restoreMirroredNoteDrafts).
 */
export const NOTES_DRAFT_KEY_PREFIX = "hunt-notes-draft-v1:";

export interface NoteDraftMirror {
  draft: string;
  base: string;
}

export function noteDraftKey(taskId: string): string {
  return NOTES_DRAFT_KEY_PREFIX + taskId;
}

export function readNoteDraftMirror(key: string): NoteDraftMirror | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NoteDraftMirror> | null;
    if (
      !parsed ||
      typeof parsed.draft !== "string" ||
      typeof parsed.base !== "string"
    ) {
      return null;
    }
    return { draft: parsed.draft, base: parsed.base };
  } catch {
    return null;
  }
}

export function writeNoteDraftMirror(taskId: string, mirror: NoteDraftMirror): void {
  try {
    window.localStorage.setItem(noteDraftKey(taskId), JSON.stringify(mirror));
  } catch {
    // Storage full or blocked: the debounced save still runs.
  }
}

/** Removes the mirror of `taskId`, but only while it still holds `draft`. */
export function clearNoteDraftMirrorIfDraft(taskId: string, draft: string): void {
  try {
    const key = noteDraftKey(taskId);
    const mirror = readNoteDraftMirror(key);
    if (!mirror || mirror.draft === draft) window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the stale mirror's base no longer matches, so boot will not restore it.
  }
}

function removeMirrorKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the key stays and the next boot handles it again, which is harmless.
  }
}

/** Heads a draft kept after the notes changed elsewhere, so the user can merge it by hand. */
export const CONFLICTED_DRAFT_MARKER = "--- Unsaved draft (these notes changed on another device) ---";

/** `notes` with a conflicted `draft` appended under the marker, cut to the synced notes length. */
export function withConflictedDraft(notes: string, draft: string): string {
  const head = notes ? `${notes}\n\n` : "";
  return clampLength(`${head}${CONFLICTED_DRAFT_MARKER}\n${draft}`, MAX_LONG_TEXT_LENGTH);
}

/**
 * Page boot (before seeding / the first sync): puts every mirrored notes draft
 * back into IndexedDB when its task still exists and still holds the notes the
 * draft was typed over (`(task.notes ?? '') === base`), so a newer edit that
 * arrived from the phone meanwhile is never overwritten. When the notes did
 * change meanwhile, the draft is not lost either: it is appended under
 * CONFLICTED_DRAFT_MARKER for the user to merge. A mirror key is removed once
 * handled (restored, kept as a conflict, task gone, draft already saved, or
 * unreadable mirror; the last two drops are logged); it is kept when the
 * IndexedDB transaction fails, so the next boot tries again. Returns the
 * number of drafts restored, conflicts included.
 */
export async function restoreMirroredNoteDrafts(): Promise<number> {
  if (typeof window === "undefined") return 0;
  const keys: string[] = [];
  try {
    const storage = window.localStorage;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(NOTES_DRAFT_KEY_PREFIX)) keys.push(key);
    }
  } catch {
    return 0;
  }

  let restored = 0;
  for (const key of keys) {
    const mirror = readNoteDraftMirror(key);
    const taskId = key.slice(NOTES_DRAFT_KEY_PREFIX.length);
    if (!mirror || !taskId) {
      logDiagnostic({ level: "WARN", domain: "notes", event: "draft_unreadable", context: { key } });
      removeMirrorKey(key);
      continue;
    }
    try {
      const outcome = await db.transaction("rw", db.tasks, async () => {
        const task = await db.tasks.get(taskId);
        if (!task) return "task_gone" as const;
        const notes = task.notes ?? "";
        if (notes === mirror.draft) return "already_saved" as const;
        const conflicted = notes !== mirror.base;
        await db.tasks.update(taskId, {
          notes: conflicted ? withConflictedDraft(notes, mirror.draft) : mirror.draft,
          updatedAt: Math.max(Date.now(), (task.updatedAt || 0) + 1),
        });
        return conflicted ? ("conflict_kept" as const) : ("restored" as const);
      });
      if (outcome === "restored" || outcome === "conflict_kept") restored += 1;
      if (outcome === "conflict_kept" || outcome === "task_gone") {
        logDiagnostic({ level: "WARN", domain: "notes", event: `draft_${outcome}`, context: { taskId } });
      }
      removeMirrorKey(key);
    } catch (err) {
      logDiagnostic({
        level: "ERROR",
        domain: "notes",
        event: "draft_restore_failed",
        context: summarizeError(err),
      });
    }
  }
  return restored;
}
