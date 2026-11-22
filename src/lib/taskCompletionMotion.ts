"use client";

import { QUEST_ACCENT_STYLES, type QuestAccentStyle } from "./questAccents";

/** How long (ms) a freshly completed task card keeps its arrival highlight. */
export const COMPLETION_HIGHLIGHT_MS = 650;

/**
 * Surface of a completed card while it settles in (`COMPLETION_HIGHLIGHT_MS`):
 * raised above its siblings with an emerald border and one shared shadow, the
 * same on Home and Plan the week. z-10 keeps it under the z-20 sticky
 * PageNotice it can scroll beneath.
 */
export const SETTLING_COMPLETED_CARD_CLASS =
  "z-10 border-[#00ff9d]/35 bg-[#11141b] shadow-[0_12px_32px_-12px_rgba(0,255,157,0.32)]";

/**
 * Fill of a completed card's dimmed (opacity-65) Reopen dot. The slate "Other"
 * accent (slate-500) falls to about 2.3:1 at that opacity, so it uses slate-400
 * (about 3.8:1); every other accent keeps its own fill.
 */
export function reopenDotBgClass(accent: QuestAccentStyle): string {
  return accent === QUEST_ACCENT_STYLES.slate ? "bg-slate-400" : accent.bg;
}

export interface TaskCompletionScene {
  taskId: string;
  ghost: HTMLElement;
  itemRects: Map<string, DOMRect>;
}

const BEAT1_HOLD_MS = 230;
const FLOW_GLIDE_MS = 320;
const FLOW_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

function prefersReducedMotion(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

/**
 * Captures the pre-completion geometry of a task container and builds an
 * in-place visual ghost card so Beat 1 (check fill + checkmark draw + title
 * strikethrough) plays calmly in place before Beat 2 smoothly collapses the
 * queue and glides the task into Completed.
 *
 * Returns null in reduced-motion or non-WAAPI test environments (e.g. JSDOM).
 */
export function captureTaskCompletionScene(
  containerEl: HTMLElement | null,
  taskId: string,
  accentHex: string
): TaskCompletionScene | null {
  if (
    !containerEl ||
    typeof Element === "undefined" ||
    typeof containerEl.animate !== "function" ||
    prefersReducedMotion()
  ) {
    return null;
  }

  const taskNodes = Array.from(
    containerEl.querySelectorAll<HTMLElement>("[data-task-id]")
  );
  const sourceEl = taskNodes.find(
    (el) =>
      el.dataset.taskId === taskId &&
      el.dataset.testid !== "completed-task-row" &&
      el.dataset.completedRow !== "true"
  );
  if (!sourceEl) return null;

  const containerRect = containerEl.getBoundingClientRect();
  const sourceRect = sourceEl.getBoundingClientRect();
  if (sourceRect.width <= 0 || sourceRect.height <= 0) return null;

  const itemRects = new Map<string, DOMRect>();
  for (const el of taskNodes) {
    const id = el.dataset.taskId;
    if (!id || id === taskId) continue;
    const prefix =
      el.dataset.testid === "completed-task-row" ||
      el.dataset.completedRow === "true"
        ? "done:"
        : "open:";
    itemRects.set(prefix + id, el.getBoundingClientRect());
  }
  const flowNodes = Array.from(
    containerEl.querySelectorAll<HTMLElement>("[data-flow-key]")
  );
  for (const el of flowNodes) {
    const key = el.dataset.flowKey;
    if (key) itemRects.set("flow:" + key, el.getBoundingClientRect());
  }

  const ghost = sourceEl.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.removeAttribute("data-testid");
  ghost.removeAttribute("data-task-id");
  ghost.removeAttribute("draggable");
  ghost.setAttribute("aria-hidden", "true");
  ghost
    .querySelectorAll("[id],[data-testid],[data-task-id]")
    .forEach((node) => {
      node.removeAttribute("id");
      node.removeAttribute("data-testid");
      node.removeAttribute("data-task-id");
    });

  ghost.style.position = "absolute";
  ghost.style.top = `${sourceRect.top - containerRect.top}px`;
  ghost.style.left = `${sourceRect.left - containerRect.left}px`;
  ghost.style.width = `${sourceRect.width}px`;
  ghost.style.margin = "0";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "30";

  const checkBtn = ghost.querySelector<HTMLElement>(
    'button[aria-label="Mark complete"]'
  );
  if (checkBtn) {
    checkBtn.style.backgroundColor = accentHex;
    checkBtn.style.borderColor = "transparent";
    checkBtn.style.color = "#05070a";
    checkBtn.style.boxShadow = `0 0 14px -2px ${accentHex}`;
    checkBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;"><polyline data-ghost-check="true" points="20 6 9 17 4 12" style="stroke-dasharray:24;stroke-dashoffset:0;"/></svg>';
  }

  const titleEl =
    ghost.querySelector<HTMLElement>("[data-task-title]") ??
    ghost.querySelector<HTMLElement>("button");
  if (titleEl) {
    titleEl.style.color = "#8b93a4";
    titleEl.style.textDecoration = "line-through";
    titleEl.style.textDecorationColor = "rgba(163, 171, 188, 0.85)";
    titleEl.style.textDecorationThickness = "1.5px";
  }

  return { taskId, ghost, itemRects };
}

/**
 * Runs the Two-Beat Things 3 / Linear completion sequence after React commits
 * the updated list:
 *   Beat 1 (0..230ms): In-place check pop + stroke draw + title strike while
 *                      every sibling row holds its pre-completion position.
 *   Beat 2 (230..565ms): Ghost releases softly, sibling rows glide cleanly up,
 *                        and the completed card glides into Completed.
 */
export function playTwoBeatTaskCompletion(
  containerEl: HTMLElement | null,
  scene: TaskCompletionScene | null
): (() => void) | undefined {
  if (
    !containerEl ||
    !scene ||
    typeof containerEl.animate !== "function" ||
    prefersReducedMotion()
  ) {
    return undefined;
  }

  const { ghost, itemRects, taskId } = scene;
  containerEl.appendChild(ghost);

  let cleaned = false;
  const removeGhost = () => {
    if (cleaned) return;
    cleaned = true;
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
  };

  const checkBtn = ghost.querySelector<HTMLElement>(
    'button[aria-label="Mark complete"]'
  );
  if (checkBtn && typeof checkBtn.animate === "function") {
    checkBtn.animate(
      [
        { transform: "scale(0.78)" },
        { transform: "scale(1.15)", offset: 0.6 },
        { transform: "scale(1)" },
      ],
      { duration: 210, easing: FLOW_EASING }
    );
  }

  const checkPoly = ghost.querySelector<SVGElement>("[data-ghost-check]");
  if (checkPoly && typeof checkPoly.animate === "function") {
    checkPoly.animate(
      [{ strokeDashoffset: "24" }, { strokeDashoffset: "0" }],
      { duration: 185, easing: FLOW_EASING }
    );
  }

  const ghostAnim = ghost.animate(
    [
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)", offset: 0 },
      { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)", offset: 0.48 },
      {
        opacity: 0,
        transform: "translate3d(0, 12px, 0) scale(0.98)",
        offset: 1,
      },
    ],
    { duration: 480, easing: FLOW_EASING, fill: "forwards" }
  );
  if (ghostAnim && typeof ghostAnim.addEventListener === "function") {
    ghostAnim.addEventListener("finish", removeGhost);
    ghostAnim.addEventListener("cancel", removeGhost);
  }
  const safetyTimer = setTimeout(removeGhost, 540);

  // Hold surviving open/completed rows during Beat 1, then glide smoothly in Beat 2
  const taskNodes = Array.from(
    containerEl.querySelectorAll<HTMLElement>("[data-task-id]")
  );
  for (const el of taskNodes) {
    if (typeof el.animate !== "function") continue;
    const id = el.dataset.taskId;
    if (!id) continue;
    const isCompletedRow =
      el.dataset.testid === "completed-task-row" ||
      el.dataset.completedRow === "true";

    if (id === taskId && isCompletedRow) {
      el.animate(
        [
          {
            opacity: 0,
            transform: "translate3d(0, -16px, 0) scale(0.985)",
          },
          {
            opacity: 1,
            transform: "translate3d(0, 0, 0) scale(1)",
          },
        ],
        {
          delay: BEAT1_HOLD_MS + 15,
          duration: FLOW_GLIDE_MS,
          easing: FLOW_EASING,
          fill: "backwards",
        }
      );
      continue;
    }

    const first = itemRects.get((isCompletedRow ? "done:" : "open:") + id);
    if (!first) continue;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1.5) continue;

    el.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        delay: BEAT1_HOLD_MS,
        duration: FLOW_GLIDE_MS,
        easing: FLOW_EASING,
        fill: "backwards",
      }
    );
  }

  // Hold & glide section headers / empty states smoothly in lockstep
  const flowNodes = Array.from(
    containerEl.querySelectorAll<HTMLElement>("[data-flow-key]")
  );
  for (const el of flowNodes) {
    if (typeof el.animate !== "function") continue;
    const key = el.dataset.flowKey;
    if (!key) continue;
    const first = itemRects.get("flow:" + key);
    if (!first) {
      el.animate(
        [
          { opacity: 0, transform: "translate3d(0, 6px, 0)" },
          { opacity: 1, transform: "translate3d(0, 0, 0)" },
        ],
        {
          delay: BEAT1_HOLD_MS + 10,
          duration: 280,
          easing: FLOW_EASING,
          fill: "backwards",
        }
      );
      continue;
    }
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1.5) continue;

    el.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0)` },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        delay: BEAT1_HOLD_MS,
        duration: FLOW_GLIDE_MS,
        easing: FLOW_EASING,
        fill: "backwards",
      }
    );
  }

  return () => {
    clearTimeout(safetyTimer);
    removeGhost();
  };
}
