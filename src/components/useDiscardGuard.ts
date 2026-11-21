"use client";

import { useEffect } from "react";
import { useCommandStore } from "@/store/useCommandStore";

/**
 * While `dirty`, registers `confirmLeave` as the store's discard guard, so a
 * view switch (setActiveView) asks it first instead of unmounting the view and
 * dropping its unsaved form edits. `confirmLeave` should keep one identity
 * (e.g. a module-level function); the guard is removed when the form turns
 * clean or the view unmounts.
 */
export function useDiscardGuard(dirty: boolean, confirmLeave: () => boolean): void {
  const setDiscardGuard = useCommandStore((s) => s.setDiscardGuard);

  useEffect(() => {
    if (!dirty) return;
    setDiscardGuard(confirmLeave);
    return () => {
      if (useCommandStore.getState().discardGuard === confirmLeave) {
        setDiscardGuard(null);
      }
    };
  }, [dirty, confirmLeave, setDiscardGuard]);
}
