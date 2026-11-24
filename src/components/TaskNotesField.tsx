"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { logDiagnostic, summarizeError } from "@/lib/diagnostics";
import { MAX_LONG_TEXT_LENGTH } from "@/lib/syncTypes";
import {
  NOTES_DRAFT_KEY_PREFIX,
  clearNoteDraftMirrorIfDraft,
  noteDraftKey,
  readNoteDraftMirror,
  restoreMirroredNoteDrafts,
  writeNoteDraftMirror,
} from "@/lib/noteDraftStore";
import { useCommandStore } from "@/store/useCommandStore";

export { NOTES_DRAFT_KEY_PREFIX, restoreMirroredNoteDrafts };

/** Delay between the last keystroke and the IndexedDB write (+ debounced sync). */
export const NOTES_SAVE_DEBOUNCE_MS = 400;

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
      clearNoteDraftMirrorIfDraft(id, next);
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
        const mirror = readNoteDraftMirror(noteDraftKey(id));
        if (mirror && mirror.base === next) {
          writeNoteDraftMirror(id, { draft: mirror.draft, base });
        }
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
        clearNoteDraftMirrorIfDraft(id, next);
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
    writeNoteDraftMirror(taskId, { draft: next, base: storedRef.current });
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
      maxLength={MAX_LONG_TEXT_LENGTH}
      {...textareaProps}
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
