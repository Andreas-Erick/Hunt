// @vitest-environment node
// Phone page side of Android reminder notifications (ADR-0007, #30): after every save the page
// hands the shell the Reminder Plan HuntCore built; the first reminder set asks for the
// permissions; a denied permission is explained where the reminder is set; and a notification
// tap opens the Task.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { click, loadMobile, pageErrors, type AndroidBridgeStub, type MobileWindow } from "./helpers/loadMobile";

const NOW = new Date(2026, 10, 25, 8, 0).getTime();
const TODAY = "2026-11-25";

let w: MobileWindow | null = null;

function state(tasks: Record<string, unknown>[]) {
  return {
    quests: [{ id: "quest-1", slotIndex: 0, title: "Launch", description: "", accentColor: "cyan", targetWeeklyHours: 5, updatedAt: 1 }],
    tasks,
    timeLogs: [],
    deletedQuestIds: [],
    deletedTaskIds: [],
    deletedLogIds: [],
    activeFocus: { activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 },
    lastSyncedAt: 0,
  };
}

function task(extra: Record<string, unknown> = {}) {
  return { id: "tsk-1", title: "Call the bank", status: "queued", rank: 0, questId: "quest-1", accumulatedSeconds: 0, scheduledDate: TODAY, updatedAt: 1, ...extra };
}

type Plan = { version: number; reminders: { key: string; itemId: string; fireAt: number }[] };

/** A shell whose grants are `perms`, recording every plan and permission request. */
function shell(perms: { notifications: boolean; exactAlarms: boolean }) {
  const plans: Plan[] = [];
  const requests: number[] = [];
  const bridge: AndroidBridgeStub & Record<string, unknown> = {
    saveState: () => undefined,
    saveReminderPlan: (json: string) => plans.push(JSON.parse(json)),
    getReminderPermissions: () => JSON.stringify(perms),
    requestReminderPermissions: () => requests.push(Date.now()),
  };
  return { bridge, plans, requests, perms };
}

function setReminder(p: MobileWindow, value: string) {
  (p as MobileWindow & { setTaskReminder(id: string, v: string): void }).setTaskReminder("tsk-1", value);
}

function sheetText(p: MobileWindow): string {
  return p.document.getElementById("sheetContainer")?.textContent ?? "";
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

describe("phone reminder notifications", () => {
  it("hands the shell the plan after a save, and an empty one once the Task is done", () => {
    const s = shell({ notifications: true, exactAlarms: true });
    const p = (w = loadMobile({ seedState: state([task()]), bridge: s.bridge }));
    setReminder(p, "18:45");
    vi.advanceTimersByTime(100); // the save runs after the next frame
    const last = s.plans[s.plans.length - 1];
    expect(last.version).toBe(1);
    expect(last.reminders.map((r) => r.key)).toEqual([`task:tsk-1:${TODAY}T18:45`]);
    expect(last.reminders[0].fireAt).toBe(new Date(2026, 10, 25, 18, 45).getTime());
    p.completeTaskDirect("tsk-1");
    vi.advanceTimersByTime(100);
    expect(s.plans[s.plans.length - 1].reminders).toEqual([]);
  });

  it("asks for the permissions the first time a reminder is set, and only then", () => {
    const s = shell({ notifications: false, exactAlarms: false });
    const p = (w = loadMobile({ seedState: state([task()]), bridge: s.bridge }));
    expect(s.requests).toHaveLength(0);
    setReminder(p, "18:45");
    expect(s.requests).toHaveLength(1);
    setReminder(p, "19:00");
    expect(s.requests).toHaveLength(1);
  });

  it("does not ask when reminders are already allowed", () => {
    const s = shell({ notifications: true, exactAlarms: true });
    const p = (w = loadMobile({ seedState: state([task()]), bridge: s.bridge }));
    setReminder(p, "18:45");
    expect(s.requests).toHaveLength(0);
    p.openTaskInspectorSheet("tsk-1");
    expect(sheetText(p)).not.toMatch(/won't arrive|may arrive late/);
  });

  it("says plainly why reminders aren't arriving when notifications are denied, with a way to allow them", () => {
    const s = shell({ notifications: false, exactAlarms: true });
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]), bridge: s.bridge }));
    p.openTaskInspectorSheet("tsk-1");
    expect(sheetText(p)).toContain("Notifications are off for Hunt, so reminders won't arrive.");
    const allow = Array.from(p.document.querySelectorAll("#sheetContainer button")).find((b) => b.textContent?.trim() === "Allow");
    click(p, allow ?? null);
    expect(s.requests).toHaveLength(1);
  });

  it("says reminders may arrive late when exact alarms are not allowed", () => {
    const s = shell({ notifications: true, exactAlarms: false });
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]), bridge: s.bridge }));
    p.openTaskInspectorSheet("tsk-1");
    expect(sheetText(p)).toContain("Hunt isn't allowed to set exact alarms, so reminders may arrive late.");
  });

  it("refreshes the explanation when Hunt comes back from the settings", () => {
    const s = shell({ notifications: false, exactAlarms: true });
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]), bridge: s.bridge }));
    p.openTaskInspectorSheet("tsk-1");
    expect(sheetText(p)).toContain("won't arrive");
    s.perms.notifications = true;
    p.__huntLifecycle("pause");
    p.__huntLifecycle("resume");
    expect(sheetText(p)).not.toContain("won't arrive");
  });

  it("a notification tap opens the Task; a Task that is gone just opens Hunt", () => {
    const s = shell({ notifications: true, exactAlarms: true });
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]), bridge: s.bridge }));
    const open = (p as MobileWindow & { __huntOpenReminder(t: unknown): void }).__huntOpenReminder;
    open({ kind: "task", itemId: "gone", dateKey: TODAY });
    expect(sheetText(p)).not.toContain("Call the bank");
    open({ kind: "task", itemId: "tsk-1", dateKey: TODAY });
    expect(p.document.querySelector('#sheetContainer input[aria-label="Reminder time"]')).not.toBeNull();
    open(null);
    expect(pageErrors(p)).toEqual([]);
  });

  it("the browser copy has no notifications to explain", () => {
    const p = (w = loadMobile({ seedState: state([task({ reminderTime: "18:45" })]) }));
    p.openTaskInspectorSheet("tsk-1");
    expect(sheetText(p)).not.toMatch(/won't arrive|may arrive late/);
  });
});
