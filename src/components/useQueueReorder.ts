"use client";

import type React from "react";
import { useRef, useState } from "react";
import type { Task } from "@/lib/domainTypes";
import { compareRank } from "@/lib/syncTypes";
import { hudAudio } from "@/lib/hudAudio";
import { orderAfterDrop, useCommandStore } from "@/store/useCommandStore";

/** Elements where Alt+Arrow keys belong to text editing, not to reordering. */
function isTextEntryTarget(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** Event handlers a reorderable queue row spreads onto its root element. */
export type QueueRowReorderHandlers = Required<
  Pick<
    React.HTMLAttributes<HTMLDivElement>,
    "onKeyDown" | "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
  >
>;

export interface QueueReorder {
  /** The row a dragged task currently hovers (drop target highlight). */
  dragOverTaskId: string | null;
  /** Drag-and-drop and Alt+↑/↓ handlers for the row of `taskId`. */
  rowHandlers: (taskId: string) => QueueRowReorderHandlers;
}

/**
 * Drag-and-drop and keyboard (Alt+↑/↓) reordering of the visible quest queue.
 * `allTasks` is every task (the move is applied to the GLOBAL rank order);
 * `queue` is the visible list the rows belong to.
 */
export function useQueueReorder(
  allTasks: Task[] | undefined,
  queue: Task[]
): QueueReorder {
  const reorderTaskQueue = useCommandStore((s) => s.reorderTaskQueue);

  // Drag & Drop State
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);

  // Keyboard reorder (Alt+↑/↓): one move at a time.
  const keyboardMoveRef = useRef(false);

  /**
   * Moves `movedId` next to `targetId` (before it when moving up in `list`,
   * after it when moving down) in the GLOBAL rank order. Nothing else moves, so
   * exactly one row is rewritten (rows the user did not move keep their
   * updatedAt and cannot revert edits made on the phone).
   */
  const moveTaskNextTo = async (
    movedId: string,
    targetId: string,
    list: Task[]
  ): Promise<void> => {
    if (!allTasks) return;
    const allPending = allTasks
      .filter((t) => t.status === "queued" || t.status === "active")
      .sort(compareRank)
      .map((t) => t.id);
    const finalOrder = orderAfterDrop(
      allPending,
      list.map((t) => t.id),
      movedId,
      targetId
    );
    if (!finalOrder) return;
    // The store reports its own failures and resolves; this only keeps the
    // fire-and-forget keyboard and drop handlers free of unhandled rejections.
    try {
      await reorderTaskQueue(finalOrder, movedId);
    } catch (err) {
      console.error("[hunt] action_failed", "reorderTaskQueue", err);
    }
  };

  const clearDrag = () => {
    setDraggedTaskId(null);
    setDragOverTaskId(null);
  };

  const handleDropOnTask = async (targetTaskId: string, targetList: Task[]) => {
    if (!draggedTaskId || draggedTaskId === targetTaskId || !allTasks) {
      clearDrag();
      return;
    }

    hudAudio.playClick();
    await moveTaskNextTo(draggedTaskId, targetTaskId, targetList);

    clearDrag();
  };

  /**
   * Alt+ArrowUp / Alt+ArrowDown anywhere in a quest row (it bubbles up from the
   * row's buttons) swaps the task with its visible neighbour, the keyboard
   * equivalent of dropping it there. Held keys (repeat) and the list ends do
   * nothing; text fields keep their own Alt+Arrow behaviour.
   */
  const handleQueueRowKeyDown = async (
    e: React.KeyboardEvent<HTMLElement>,
    taskId: string
  ) => {
    const step = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (step === 0 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (isTextEntryTarget(e.target)) return;
    e.preventDefault();
    if (e.repeat || keyboardMoveRef.current) return;

    const index = queue.findIndex((t) => t.id === taskId);
    const neighbour = index === -1 ? undefined : queue[index + step];
    if (!neighbour) return;

    // React DOM gives focus back to the pressed control after it moves the
    // row, so the next press works without refocusing.
    keyboardMoveRef.current = true;
    hudAudio.playClick();
    try {
      await moveTaskNextTo(taskId, neighbour.id, queue);
    } finally {
      keyboardMoveRef.current = false;
    }
  };

  const rowHandlers = (taskId: string): QueueRowReorderHandlers => ({
    onKeyDown: (e) => void handleQueueRowKeyDown(e, taskId),
    onDragStart: () => setDraggedTaskId(taskId),
    onDragOver: (e) => {
      e.preventDefault();
      if (draggedTaskId && draggedTaskId !== taskId) {
        setDragOverTaskId(taskId);
      }
    },
    onDrop: () => void handleDropOnTask(taskId, queue),
    onDragEnd: clearDrag,
  });

  return { dragOverTaskId, rowHandlers };
}
