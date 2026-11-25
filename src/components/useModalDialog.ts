import React, { useEffect, useLayoutEffect, useRef } from "react";
import { useDocumentScrollLock } from "./useDocumentScrollLock";

/** What Tab / Shift+Tab cycle through inside a modal dialog. */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * The modal contract both hand-rolled dialogs share: page scroll locked, every
 * sibling of the dialog's ancestor chain `inert`, focus moved to
 * `initialFocusRef` and returned to the opener on close, Tab / Shift+Tab
 * wrapping inside the dialog, and Escape calling `onClose`.
 *
 * Attach `dialogRef` to the element that holds the dialog (the backdrop or the
 * card) and `onKeyDown` to the same element. Escape pressed inside the dialog
 * stops there, so an inner control that handles Escape itself (and stops it)
 * keeps it; Escape with focus outside the dialog (e.g. on <body> after a press
 * on plain text) still closes it.
 */
export function useModalDialog<T extends HTMLElement>({
  onClose,
  initialFocusRef,
}: {
  onClose: () => void;
  initialFocusRef: React.RefObject<HTMLElement | null>;
}): {
  dialogRef: React.RefObject<T | null>;
  onKeyDown: (e: React.KeyboardEvent<T>) => void;
} {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Scroll locked; focus moves in, siblings go `inert`, and both are undone (layout effect) before the nodes go.
  useDocumentScrollLock();
  useLayoutEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;

    const inerted: HTMLElement[] = [];
    let current: HTMLElement | null = dialogRef.current;
    while (current && current !== document.body) {
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children)) {
        if (
          sibling !== current &&
          sibling instanceof HTMLElement &&
          sibling.tagName !== "SCRIPT" &&
          sibling.tagName !== "STYLE" &&
          !sibling.inert &&
          !sibling.hasAttribute("inert")
        ) {
          sibling.inert = true;
          sibling.setAttribute("inert", "");
          inerted.push(sibling);
        }
      }
      current = parent;
    }

    initialFocusRef.current?.focus();
    return () => {
      for (const el of inerted) {
        el.inert = false;
        el.removeAttribute("inert");
      }
      if (opener && opener.isConnected) opener.focus();
    };
    // A ref object keeps its identity, so this runs once per mount.
  }, [initialFocusRef]);

  // Escape with focus outside the dialog (inside, onKeyDown handles it and stops it).
  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const root = dialogRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<T>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.tabIndex >= 0
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const activeEl = document.activeElement;
    if (e.shiftKey ? activeEl === first || activeEl === root : activeEl === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  return { dialogRef, onKeyDown };
}
