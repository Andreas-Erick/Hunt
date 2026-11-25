import { useLayoutEffect } from "react";

/**
 * Locks page scrolling while a modal is mounted, restoring the previous value
 * on unmount. `inert` on the background blocks focus but not wheel or touch
 * scrolling, so a modal needs both.
 */
export function useDocumentScrollLock(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, []);
}
