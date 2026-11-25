/**
 * Opening an item from outside its view (a reminder notification's click,
 * ADR-0007): a request for the Today view to open a Task's row, which waits
 * when the view is not drawn yet, and a scroll to an element once its view
 * has drawn it.
 */

let pendingTaskId: string | null = null;
const listeners = new Set<() => void>();

/** Asks the Today view to open the Task's row (its drawer); kept until the view takes it. */
export function requestOpenTask(taskId: string): void {
  pendingTaskId = taskId;
  for (const listener of listeners) listener();
}

/** The Task a request asks to open, once: null when there is none. */
export function takeOpenTaskRequest(): string | null {
  const taskId = pendingTaskId;
  pendingTaskId = null;
  return taskId;
}

/** Calls `listener` on each new request; returns the unsubscribe function. */
export function onOpenTaskRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How long a reveal keeps looking for its element while the view renders. */
const REVEAL_TRIES = 20;
const REVEAL_STEP_MS = 100;

const SELECTOR = { habitId: "[data-habit-id]", taskId: "[data-task-id]" } as const;

/** Scrolls the element whose `data-habit-id` / `data-task-id` is `id` into view once its view has drawn it. */
export function revealWhenDrawn(attribute: keyof typeof SELECTOR, id: string, triesLeft = REVEAL_TRIES): void {
  const el = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR[attribute])).find(
    (node) => node.dataset[attribute] === id
  );
  if (el) el.scrollIntoView?.({ block: "center" });
  else if (triesLeft > 0) setTimeout(() => revealWhenDrawn(attribute, id, triesLeft - 1), REVEAL_STEP_MS);
}
