import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/**
 * The browser demo build (ADR-0010) flips IS_WEB_DEMO at build time. These tests set the
 * same env var and import fresh module graphs, so each one sees what the demo bundle runs.
 */
async function importAsDemo<T>(specifier: string): Promise<T> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HUNT_DEMO", "1");
  return (await import(specifier)) as T;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("web demo platform", () => {
  it("the native build keeps the laptop sync hub", async () => {
    vi.resetModules();
    const { currentPlatform } = await import("@/lib/platform");
    expect(currentPlatform.id).toBe("native");
    expect(currentPlatform.sync).not.toBeNull();
  });

  it("the demo build has no sync, and a sync pass makes no request and shows no error", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { currentPlatform } = await importAsDemo<typeof import("@/lib/platform")>("@/lib/platform");
    expect(currentPlatform.id).toBe("web-demo");
    expect(currentPlatform.sync).toBeNull();

    const { useCommandStore } = await importAsDemo<typeof import("@/store/useCommandStore")>(
      "@/store/useCommandStore"
    );
    await useCommandStore.getState().syncNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useCommandStore.getState().syncError).toBeNull();
  });

  it("the demo opens its own database, never the native app's", async () => {
    const { db } = await importAsDemo<typeof import("@/lib/db")>("@/lib/db");
    expect(db.name).toBe("HuntWebDemo");
  });

  it("the demo never asks for notification permission, and the reminder note says why", async () => {
    const request = vi.fn(async () => "granted" as NotificationPermission);
    vi.stubGlobal("Notification", Object.assign(function Notification() {}, {
      permission: "default",
      requestPermission: request,
    }));
    const reminders = await importAsDemo<typeof import("@/lib/desktopReminders")>(
      "@/lib/desktopReminders"
    );
    expect(reminders.notificationAccess()).toBe("unsupported");
    expect(await reminders.ensureNotificationAccess()).toBe("unsupported");
    expect(request).not.toHaveBeenCalled();

    const { REMINDER_ACCESS_NOTE } = await importAsDemo<
      typeof import("@/components/TaskReminderField")
    >("@/components/TaskReminderField");
    expect(REMINDER_ACCESS_NOTE.unsupported).toMatch(/demo sends no notifications/i);
    vi.unstubAllGlobals();
  });

  it("the demo's Phone & sync sheet explains the gap and links to the releases page", async () => {
    const { DemoPhoneSheet } = await importAsDemo<typeof import("@/components/DemoPhoneSheet")>(
      "@/components/DemoPhoneSheet"
    );
    const onClose = vi.fn();
    render(<DemoPhoneSheet isOpen onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Phone & sync" })).toBeInTheDocument();
    expect(screen.getByText(/runs entirely in your browser/i)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /get the real app/i });
    expect(link).toHaveAttribute("href", "https://github.com/Andreas-Erick/Hunt/releases");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
