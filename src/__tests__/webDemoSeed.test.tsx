import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/db";
import { buildDemoSeed, DEMO_HISTORY_DAYS } from "@/lib/demoSeed";
import { resetDemoData, seedDemoIfEmpty } from "@/lib/demoStore";
import { habitTaskId } from "@/lib/dateUtils";
import { dateKeyFromOffset, toLocalDateKey } from "@/lib/dateKeys";
import { createEmptySyncPayload } from "@/lib/syncTypes";
import { validateSyncPayload } from "@/lib/syncValidate";
import { DemoBanner } from "@/components/DemoBanner";

/** Visit times the seed must handle: midday, just after and just before midnight, both DST changes. */
const VISITS = [
  new Date(2026, 10, 27, 13, 5).getTime(),
  new Date(2026, 10, 27, 0, 4).getTime(),
  new Date(2026, 10, 27, 23, 58).getTime(),
  new Date(2026, 2, 29, 9, 30).getTime(),
  new Date(2026, 9, 25, 9, 30).getTime(),
];

async function clearDb() {
  await Promise.all([db.quests.clear(), db.tasks.clear(), db.timeLogs.clear(), db.habits.clear(), db.lists.clear()]);
}

describe("demo seed (buildDemoSeed)", () => {
  it.each(VISITS.map((now) => [new Date(now).toString(), now]))(
    "visit at %s: every row is a valid sync row, and no session is in the future or misdated",
    (_label, now) => {
      const seed = buildDemoSeed(now);
      const check = validateSyncPayload({ ...createEmptySyncPayload(), ...seed });
      expect(check.valid, check.valid ? "" : check.error).toBe(true);
      if (!check.valid) return;
      expect(check.payload.tasks).toHaveLength(seed.tasks.length);
      expect(check.payload.timeLogs).toHaveLength(seed.timeLogs.length);
      expect(check.payload.habits).toHaveLength(seed.habits.length);

      const today = toLocalDateKey(now);
      const taskIds = new Set(seed.tasks.map((t) => t.id));
      for (const log of seed.timeLogs) {
        expect(log.endTime, log.id).toBeLessThanOrEqual(now);
        expect(log.dateKey, log.id).toBe(toLocalDateKey(log.startTime));
        expect(log.dateKey >= dateKeyFromOffset(today, -DEMO_HISTORY_DAYS), log.id).toBe(true);
        expect(taskIds.has(log.taskId), log.id).toBe(true);
      }
      for (const task of seed.tasks) {
        if (task.completedAt !== undefined) expect(task.completedAt, task.id).toBeLessThanOrEqual(now);
      }
    }
  );

  it("is deterministic: the same visit time builds the same rows", () => {
    expect(buildDemoSeed(VISITS[0])).toEqual(buildDemoSeed(VISITS[0]));
  });

  it("opens on a full day: work queued today, a planned week, history and one habit of each Kind", () => {
    const now = VISITS[0];
    const today = toLocalDateKey(now);
    const seed = buildDemoSeed(now);
    const queuedToday = seed.tasks.filter((t) => t.scheduledDate === today && t.status === "queued" && !t.habitId);
    expect(queuedToday.length).toBeGreaterThanOrEqual(3);
    for (let offset = 1; offset <= 6; offset += 1) {
      expect(seed.tasks.some((t) => t.scheduledDate === dateKeyFromOffset(today, offset)), `day +${offset}`).toBe(true);
    }
    expect(new Set(seed.timeLogs.map((l) => l.dateKey)).size).toBeGreaterThan(30);
    expect(seed.quests).toHaveLength(3);
    expect(new Set(seed.habits.map((h) => h.kind ?? "check"))).toEqual(new Set(["check", "count", "avoid"]));
    expect(seed.lists.length).toBeGreaterThan(0);
    // Habit day rows use the frozen id format (ADR-0008).
    for (const task of seed.tasks.filter((t) => t.habitId)) {
      expect(task.id).toBe(habitTaskId(task.habitId!, task.scheduledDate!));
    }
  });
});

describe("demo store (seedDemoIfEmpty, resetDemoData)", () => {
  beforeEach(async () => {
    await clearDb();
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("fills an empty database on first visit and leaves a visitor's edits alone afterwards", async () => {
    expect(await seedDemoIfEmpty(VISITS[0])).toBe(true);
    const seeded = await db.tasks.count();
    expect(seeded).toBe(buildDemoSeed(VISITS[0]).tasks.length);

    await db.tasks.delete("demo-today-review");
    expect(await seedDemoIfEmpty(VISITS[0])).toBe(false);
    expect(await db.tasks.get("demo-today-review")).toBeUndefined();
  });

  it("Reset restores the seed and clears Hunt's stored state, but keeps the look and sound choice", async () => {
    await seedDemoIfEmpty(VISITS[0]);
    await db.tasks.update("demo-today-review", { title: "Changed by a visitor" });
    await db.tasks.put({ ...(await db.tasks.get("demo-today-run"))!, id: "visitor-task" });
    await db.quests.delete("quest-slot-2");
    window.localStorage.setItem("journey-hud-command-store", '{"state":{"isRunning":true}}');
    window.localStorage.setItem("hunt-notes-draft-v1:demo-today-review", "{}");
    window.localStorage.setItem("hunt-look", "dawn");
    window.localStorage.setItem("hunt-audio-muted-v1", "1");
    window.localStorage.setItem("portfolio-theme", "light");

    await resetDemoData(VISITS[0]);

    expect((await db.tasks.get("demo-today-review"))?.title).toBe("Finish the new Review screen");
    expect(await db.tasks.get("visitor-task")).toBeUndefined();
    expect(await db.quests.count()).toBe(3);
    expect(await db.tasks.count()).toBe(buildDemoSeed(VISITS[0]).tasks.length);
    expect(window.localStorage.getItem("journey-hud-command-store")).toBeNull();
    expect(window.localStorage.getItem("hunt-notes-draft-v1:demo-today-review")).toBeNull();
    expect(window.localStorage.getItem("hunt-look")).toBe("dawn");
    expect(window.localStorage.getItem("hunt-audio-muted-v1")).toBe("1");
    // The host site's own keys are not Hunt's to clear.
    expect(window.localStorage.getItem("portfolio-theme")).toBe("light");
  });
});

describe("demo banner", () => {
  it("says the data stays in the browser and links to the releases page", () => {
    render(<DemoBanner reset={async () => {}} reload={() => {}} />);
    const banner = screen.getByRole("region", { name: "Live demo" });
    expect(banner).toHaveTextContent("Live demo: data stays in your browser. Get the real app");
    expect(screen.getByRole("link", { name: "Get the real app" })).toHaveAttribute(
      "href",
      "https://github.com/Andreas-Erick/Hunt/releases"
    );
  });

  it("Reset demo restores the data, then reloads the page", async () => {
    const calls: string[] = [];
    render(
      <DemoBanner
        reset={async () => void calls.push("reset")}
        reload={() => calls.push("reload")}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(calls).toEqual(["reset", "reload"]));
  });

  it("a failed reset does not reload, and offers a retry", async () => {
    const reload = vi.fn();
    render(<DemoBanner reset={async () => Promise.reject(new Error("idb blocked"))} reload={reload} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset demo" }));
    expect(await screen.findByRole("button", { name: "Reset failed, retry" })).toBeEnabled();
    expect(reload).not.toHaveBeenCalled();
  });
});
