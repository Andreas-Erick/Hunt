"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { db } from "@/lib/db";
import { logDiagnostic, summarizeError } from "@/lib/diagnostics";
import { useCommandStore } from "@/store/useCommandStore";

/** Delay between the last keystroke and the IndexedDB write (+ debounced sync). */
export const NOTES_SAVE_DEBOUNCE_MS = 400;

/**
 * Device-local localStorage mirror of an unsaved notes draft, written
 * synchronously on every keystroke: `hunt-notes-draft-v1:<taskId>` →
 * `{ draft, base }` (base = the notes the draft was typed over). A reload or
 * navigation inside the debounce window does not blur or unmount the field,
 * and a Dexie write started in pagehide does not commit, so the mirror is what
 * survives; page boot restores it (restoreMirroredNoteDrafts).
 */
export const NOTES_DRAFT_KEY_PREFIX = "hunt-notes-draft-v1:";

interface NoteDraftMirror {
  draft: string;
  base: string;
}

function draftKey(taskId: string): string {
  return NOTES_DRAFT_KEY_PREFIX + taskId;
}

function readMirror(key: string): NoteDraftMirror | null {
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

function writeMirror(taskId: string, mirror: NoteDraftMirror): void {
  try {
    window.localStorage.setItem(draftKey(taskId), JSON.stringify(mirror));
  } catch {
    // Storage full or blocked: the debounced save still runs.
  }
}

/** Removes the mirror of `taskId`, but only while it still holds `draft`. */
function clearMirrorIfDraft(taskId: string, draft: string): void {
  try {
    const key = draftKey(taskId);
    const mirror = readMirror(key);
    if (!mirror || mirror.draft === draft) window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function removeMirrorKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Page boot (before seeding / the first sync): puts every mirrored notes draft
 * back into IndexedDB when its task still exists and still holds the notes the
 * draft was typed over (`(task.notes ?? '') === base`), so a newer edit that
 * arrived from the phone meanwhile is never overwritten. A mirror key is
 * removed once handled (restored, task gone, base mismatch, draft already
 * saved, or unreadable mirror); it is kept when the IndexedDB transaction
 * fails, so the next boot tries again. Returns the number of drafts restored.
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
    const mirror = readMirror(key);
    const taskId = key.slice(NOTES_DRAFT_KEY_PREFIX.length);
    if (!mirror || !taskId) {
      removeMirrorKey(key);
      continue;
    }
    try {
      const done = await db.transaction("rw", db.tasks, async () => {
        const task = await db.tasks.get(taskId);
        if (!task || (task.notes ?? "") !== mirror.base) return false;
        if ((task.notes ?? "") === mirror.draft) return false;
        await db.tasks.update(taskId, {
          notes: mirror.draft,
          updatedAt: Math.max(Date.now(), (task.updatedAt || 0) + 1),
        });
        return true;
      });
      if (done) restored += 1;
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

type NativeTextareaProps = Omit<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "defaultValue" | "onChange"
>;

interface TaskNotesFieldProps extends NativeTextareaProps {
  taskId: string;
  /** The task's notes as currently stored (from useLiveQuery). */
  notes: string | undefined;
}

/**
 * Notes textarea backed by a local draft.
 *
 * Typing never waits for the IndexedDB write + liveQuery round trip, so the caret
 * does not jump and no characters are lost. The draft is saved ~400 ms after the
 * last keystroke, immediately on blur, on unmount (closing the drawer or
 * completing the task right after typing keeps the last edit) and, best effort,
 * on pagehide / when the page is hidden. Every unsaved draft is also mirrored to
 * localStorage synchronously, so a reload inside the debounce window loses
 * nothing (restored at boot). Updates from elsewhere (e.g. the phone via sync)
 * replace the draft only while it has no unsaved edits.
 */
export function TaskNotesField({
  taskId,
  notes,
  onBlur,
  onKeyDown,
  ...textareaProps
}: TaskNotesFieldProps) {
  const stored = notes ?? "";
  const [draft, setDraft] = useState(stored);

  const draftRef = useRef(stored);
  /** Value we believe IndexedDB holds (last prop seen, or last value saved). */
  const storedRef = useRef(stored);
  /** True while the draft has edits that were not handed to updateTask yet. */
  const dirtyRef = useRef(false);
  const taskIdRef = useRef(taskId);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback((id: string) => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const next = draftRef.current;
    if (next === storedRef.current) {
      // Typed and reverted: nothing to save, nothing to restore.
      clearMirrorIfDraft(id, next);
      return;
    }
    const base = storedRef.current;
    storedRef.current = next;
    // The write failed, so IndexedDB still holds `base`: the draft is unsaved
    // again (its mirror stays, and later mirrors keep the right base).
    const keepUnsaved = () => {
      if (taskIdRef.current === id && storedRef.current === next) {
        storedRef.current = base;
        dirtyRef.current = true;
        // Typing while the save was in flight mirrored `next` as the base; a
        // reload now would find IndexedDB still at `base` and drop that draft.
        const mirror = readMirror(draftKey(id));
        if (mirror && mirror.base === next) writeMirror(id, { draft: mirror.draft, base });
      }
    };
    useCommandStore
      .getState()
      .updateTask(id, { notes: next })
      .then((saved) => {
        // false: the store reported a failed write (actionError is shown).
        if (saved === false) {
          keepUnsaved();
          return;
        }
        // The save committed: the mirror is no longer needed (unless the user
        // has typed on since, which re-mirrored a newer draft).
        clearMirrorIfDraft(id, next);
      })
      .catch((err) => {
        logDiagnostic({
          level: "ERROR",
          domain: "notes",
          event: "save_notes_failed",
          context: { taskId: id, ...summarizeError(err) },
        });
        keepUnsaved();
      });
  }, []);

  // Adopt the stored value when it changes (or the field is reused for another
  // task), unless the user has unsaved edits for this task.
  useEffect(() => {
    const switchedTask = taskIdRef.current !== taskId;
    taskIdRef.current = taskId;
    storedRef.current = stored;
    if (switchedTask || !dirtyRef.current) {
      dirtyRef.current = false;
      draftRef.current = stored;
      setDraft(stored);
    }
  }, [taskId, stored]);

  // Save the pending draft when the field unmounts or switches task.
  useEffect(() => {
    const id = taskId;
    return () => flush(id);
  }, [taskId, flush]);

  // Best effort on reload / navigation / window hidden (the localStorage mirror
  // is what actually survives a reload; this just saves earlier when it can).
  useEffect(() => {
    const onPageHide = () => flush(taskIdRef.current);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush(taskIdRef.current);
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    draftRef.current = next;
    dirtyRef.current = true;
    writeMirror(taskId, { draft: next, base: storedRef.current });
    setDraft(next);

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    const id = taskId;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush(id);
    }, NOTES_SAVE_DEBOUNCE_MS);
  };

  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    flush(taskId);
    onBlur?.(e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      flush(taskId);
      e.currentTarget.blur();
    }
    onKeyDown?.(e);
  };

  return (
    <textarea
      {...textareaProps}
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
