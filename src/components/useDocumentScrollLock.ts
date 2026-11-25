import { useLayoutEffect } from "react";

/**
 * Locks page scrolling while a modal is mounted, restoring the previous value
 * on unmount. `inert` on the background blocks focus but not wheel or touch
 * scrolling, so a modal needs both.
 *
 * Hiding overflow also removes a classic (non-overlay) scrollbar, which would
 * shift the whole page sideways by its width as the modal opens. When the page
 * shows one, `scrollbar-gutter: stable` keeps its space reserved meanwhile.
 */
export function useDocumentScrollLock(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    const previousGutter = root.style.scrollbarGutter;
    if (window.innerWidth - root.clientWidth > 0) root.style.scrollbarGutter = "stable";
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
      root.style.scrollbarGutter = previousGutter;
    };
  }, []);
}
