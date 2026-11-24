import { describe, it, expect, afterEach, vi } from "vitest";
import {
  captureTaskCompletionScene,
  playTwoBeatTaskCompletion,
} from "@/lib/taskCompletionMotion";

/**
 * The completing task must move toward where it actually lands. jsdom has no
 * layout, so each row's top is stubbed and WAAPI calls are recorded.
 */

type Keyframes = Array<{ transform?: string }>;
const calls: Array<{ el: Element; keyframes: Keyframes }> = [];

function stubLayout(el: Element, top: number): void {
  el.getBoundingClientRect = () =>
    ({ top, left: 0, width: 300, height: 40, right: 300, bottom: top + 40, x: 0, y: top }) as DOMRect;
}

function translateY(transform: string | undefined): number {
  const m = /translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(transform ?? "");
  return m ? Number(m[1]) : 0;
}

function row(id: string, top: number, completed = false): HTMLElement {
  const el = document.createElement("div");
  el.dataset.taskId = id;
  if (completed) el.dataset.completedRow = "true";
  el.innerHTML = '<button aria-label="Mark complete"></button><span data-task-title>t</span>';
  stubLayout(el, top);
  return el;
}

function setup(rows: HTMLElement[]): HTMLElement {
  const container = document.createElement("div");
  stubLayout(container, 0);
  rows.forEach((r) => container.appendChild(r));
  document.body.appendChild(container);
  const animate = function (this: Element, keyframes: Keyframes) {
    calls.push({ el: this, keyframes });
    return { addEventListener: () => {} } as unknown as Animation;
  };
  Element.prototype.animate = animate as unknown as Element["animate"];
  return container;
}

/** Vertical drift of the fading ghost at the end of its exit. */
function ghostDrift(): number {
  const ghost = calls.find((c) => c.el.getAttribute("aria-hidden") === "true");
  return translateY(ghost?.keyframes.at(-1)?.transform);
}

/** Where the arriving Completed card starts, relative to where it rests. */
function arrivalOffset(taskId: string): number | undefined {
  const arrival = calls.find(
    (c) => (c.el as HTMLElement).dataset.taskId === taskId && (c.el as HTMLElement).dataset.completedRow === "true"
  );
  return arrival ? translateY(arrival.keyframes[0]?.transform) : undefined;
}

afterEach(() => {
  calls.length = 0;
  document.body.innerHTML = "";
  delete (Element.prototype as { animate?: unknown }).animate;
  vi.useRealTimers();
});

describe("playTwoBeatTaskCompletion direction", () => {
  it("fades the bottom task in place when the list drops completed tasks (Quests panel)", () => {
    vi.useFakeTimers();
    const container = setup([row("a", 0), row("b", 50), row("c", 100)]);
    const scene = captureTaskCompletionScene(container, "c", "red");
    container.removeChild(container.querySelector('[data-task-id="c"]')!);

    playTwoBeatTaskCompletion(container, scene);

    expect(ghostDrift()).toBe(0);
  });

  it("drifts down and enters from above when the Completed card lands below", () => {
    vi.useFakeTimers();
    const container = setup([row("a", 0), row("b", 50)]);
    const scene = captureTaskCompletionScene(container, "a", "red");
    container.removeChild(container.querySelector('[data-task-id="a"]')!);
    stubLayout(container.querySelector('[data-task-id="b"]')!, 0);
    container.appendChild(row("a", 120, true));

    playTwoBeatTaskCompletion(container, scene);

    expect(ghostDrift()).toBeGreaterThan(0);
    expect(arrivalOffset("a")).toBeLessThan(0);
  });

  it("never pushes past a destination that is only a few pixels away", () => {
    vi.useFakeTimers();
    const container = setup([row("a", 0)]);
    const scene = captureTaskCompletionScene(container, "a", "red");
    container.removeChild(container.querySelector('[data-task-id="a"]')!);
    container.appendChild(row("a", 5, true));

    playTwoBeatTaskCompletion(container, scene);

    expect(ghostDrift()).toBeLessThanOrEqual(5);
    expect(Math.abs(arrivalOffset("a") ?? 0)).toBeLessThanOrEqual(5);
  });

  it("keeps the bottom task visible and glides it into a Completed card right below", () => {
    vi.useFakeTimers();
    const container = setup([row("a", 0), row("b", 50)]);
    const scene = captureTaskCompletionScene(container, "b", "red");
    container.removeChild(container.querySelector('[data-task-id="b"]')!);
    container.appendChild(row("b", 100, true));

    playTwoBeatTaskCompletion(container, scene);

    const ghost = calls.find((c) => c.el.getAttribute("aria-hidden") === "true");
    const arrival = calls.find(
      (c) => (c.el as HTMLElement).dataset.taskId === "b" && (c.el as HTMLElement).dataset.completedRow === "true"
    );
    // Nothing sits between the task and its Completed card: no fade out and back in.
    expect(ghost?.keyframes.every((k) => (k as { opacity?: number }).opacity !== 0)).toBe(true);
    expect((arrival?.keyframes[0] as { opacity?: number } | undefined)?.opacity).not.toBe(0);
    // The Completed card starts exactly where the task was.
    expect(arrivalOffset("b")).toBe(-50);
  });

  it("drifts up and enters from below when the Completed card lands above", () => {
    vi.useFakeTimers();
    const container = setup([row("x", 0, true), row("a", 200)]);
    const scene = captureTaskCompletionScene(container, "a", "red");
    container.removeChild(container.querySelector('[data-task-id="a"]')!);
    container.insertBefore(row("a", 0, true), container.firstChild);
    stubLayout(container.querySelector('[data-task-id="x"]')!, 50);

    playTwoBeatTaskCompletion(container, scene);

    expect(ghostDrift()).toBeLessThan(0);
    expect(arrivalOffset("a")).toBeGreaterThan(0);
  });
});
