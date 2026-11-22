import fs from "fs";
import path from "path";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import type { Quest, Task } from "@/lib/domainTypes";
import { useCommandStore } from "@/store/useCommandStore";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { DesktopWindowControls } from "@/components/DesktopWindowControls";
import { MobileSyncModal } from "@/components/MobileSyncModal";
import { TelemetryDashboardView } from "@/components/TelemetryDashboardView";
import { GuideView } from "@/components/GuideView";

// next/font is a Next.js build-time transform; outside Next the module has no runtime exports.
vi.mock("next/font/google", () => {
  const font = (options: { variable: string }) => ({
    className: "next-font",
    variable: `next-font-var${options.variable}`,
    style: { fontFamily: "next-font" },
  });
  return { Space_Grotesk: font, JetBrains_Mono: font };
});

const ROOT = path.resolve(__dirname, "..", "..");
const T0 = new Date(2026, 2, 2, 9, 0, 0).getTime();
const LONG_TITLE =
  "Write the full quarterly research synthesis for the falcon tracking study and send it";

const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, requestSync: s.requestSync };
})();

function makeQuest(id: string, title: string, slotIndex: 0 | 1 | 2): Quest {
  return {
    id,
    slotIndex,
    code: title.slice(0, 10).toUpperCase(),
    title,
    description: "",
    accentColor: "cyan",
    targetWeeklyHours: 10,
    archived: false,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeTask(id: string, title: string): Task {
  return {
    id,
    title,
    notes: "",
    questId: null,
    status: "queued",
    rank: 1000,
    accumulatedSeconds: 0,
    createdAt: T0,
    updatedAt: T0,
  };
}

beforeEach(async () => {
  await db.quests.clear();
  await db.tasks.clear();
  await db.timeLogs.clear();
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    actionError: null,
    lanUrls: ["http://192.168.1.5:3000"],
    phoneLastSeenAt: null,
    syncNow: vi.fn(async () => true),
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useCommandStore.setState({ ...realActions, lanUrls: [] });
});

// ---------------------------------------------------------------------------
// P32-01: fonts are self-hosted through next/font (no Google request at runtime)
// ---------------------------------------------------------------------------
describe("root layout fonts (P32-01)", () => {
  it("loads no stylesheet or preconnect from Google and sets both font variables on <html>", async () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "app", "layout.tsx"), "utf8");
    expect(source).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    expect(source).toContain('variable: "--font-space-grotesk"');
    expect(source).toContain('variable: "--font-jetbrains-mono"');

    const { default: RootLayout } = await import("@/app/layout");
    const html = RootLayout({ children: <p>child</p> }) as React.ReactElement<{
      className: string;
      children: React.ReactNode;
    }>;
    expect(html.type).toBe("html");
    expect(html.props.className.split(" ")).toEqual(
      expect.arrayContaining([
        "dark",
        "next-font-var--font-space-grotesk",
        "next-font-var--font-jetbrains-mono",
      ])
    );
    // No <head> with external <link> tags is rendered by the layout any more.
    const children = React.Children.toArray(html.props.children) as React.ReactElement[];
    expect(children.map((c) => c.type)).toEqual(["body"]);
  });

  it("globals.css no longer shadows the next/font variables with a :root definition", () => {
    const css = fs.readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");
    expect(css).not.toMatch(/--font-space-grotesk\s*:/);
    expect(css).not.toMatch(/--font-jetbrains-mono\s*:/);
    expect(css).toContain("font-family: var(--font-space-grotesk), sans-serif;");
  });
});

// ---------------------------------------------------------------------------
// TopTelemetryBar: session pill title (P08-03), nav overflow (P15-01), press states (P14-03)
// ---------------------------------------------------------------------------
describe("TopTelemetryBar", () => {
  it("the running-session pill exposes the full task title on hover (P08-03)", async () => {
    await db.tasks.add(makeTask("tsk-long", LONG_TITLE));
    useCommandStore.setState({ activeTaskId: "tsk-long" });
    render(<TopTelemetryBar />);

    const pill = await screen.findByTitle(`Open Focus: ${LONG_TITLE}`);
    expect(pill.tagName).toBe("BUTTON");
    // The clipped title only shows on wide headers, so the nav keeps its room.
    const clipped = screen.getByText(LONG_TITLE);
    expect(clipped).toHaveClass("truncate", "hidden", "min-[1440px]:inline");
    expect(clipped).not.toHaveClass("md:inline");
  });

  it("the nav shows an edge scroll cue and keeps the active tab scrolled into view (P15-01)", () => {
    const rects = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        const box = (left: number, right: number) =>
          ({ left, right, top: 0, bottom: 20, width: right - left, height: 20, x: left, y: 0 }) as DOMRect;
        if (this.tagName === "NAV") return box(100, 300);
        if (this.getAttribute("aria-current") === "page") return box(340, 400);
        return box(0, 0);
      });
    let scrollLeft = 0;
    const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft");
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (v: number) => {
        scrollLeft = v;
      },
    });
    try {
      useCommandStore.setState({ activeView: "guide" });
      render(<TopTelemetryBar />);
      const nav = screen.getByRole("navigation");
      expect(nav).toHaveClass("scroll-shadow-x", "overflow-x-auto", "no-scrollbar");
      // The Guide tab's right edge (400) sat 100px past the nav's right edge (300).
      expect(scrollLeft).toBe(100);
      expect(rects).toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollLeft");
      if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollLeft", scrollDescriptor);
    }
  });

  it("nav tabs, Phone and sound buttons have a pressed state (P14-03)", () => {
    render(<TopTelemetryBar />);
    expect(screen.getByRole("button", { name: "Plan" })).toHaveClass("active:opacity-80");
    expect(screen.getByRole("button", { name: /^Phone sync:/ })).toHaveClass("active:scale-[0.98]");
    expect(screen.getByRole("button", { name: "Mute interface audio" })).toHaveClass(
      "active:scale-[0.98]"
    );
  });
});

// ---------------------------------------------------------------------------
// DesktopWindowControls: spacing (P12-02) and pressed state (P14-03)
// ---------------------------------------------------------------------------
describe("DesktopWindowControls", () => {
  const TOKEN_KEY = "hunt-sync-token-v1";
  afterEach(() => window.localStorage.removeItem(TOKEN_KEY));

  it("spaces the controls >= 8px apart, Exit a little further, and gives each a press state", () => {
    window.localStorage.setItem(TOKEN_KEY, "a".repeat(64));
    render(<DesktopWindowControls />);
    const group = screen.getByRole("group", { name: "Window controls" });
    expect(group).toHaveClass("gap-2");
    expect(group).not.toHaveClass("gap-1");
    expect(screen.getByTestId("window-close-btn")).toHaveClass("ml-1");
    for (const id of ["window-minimize-btn", "window-fullscreen-btn", "window-close-btn"]) {
      expect(screen.getByTestId(id), id).toHaveClass("active:scale-[0.98]");
    }
  });

  it("renders nothing outside the desktop launcher (no pairing key), where the controls cannot work (UI-18)", () => {
    window.localStorage.removeItem(TOKEN_KEY);
    render(<DesktopWindowControls />);
    expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
    expect(screen.queryByTestId("window-close-btn")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MobileSyncModal: QR failure (P08-01), recovery copy (P11-02), local-date filename (P29-01)
// ---------------------------------------------------------------------------
describe("MobileSyncModal", () => {
  const QR_FAILED = "Couldn't draw the QR code. Use Copy to get the pairing link instead.";

  it("a rejected QR render explains the failure instead of loading forever (P08-01)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("qr overflow");
    vi.spyOn(QRCode, "toString").mockRejectedValue(failure);
    render(<MobileSyncModal isOpen onClose={() => undefined} />);

    expect(await screen.findByText(QR_FAILED)).toHaveAttribute("role", "alert");
    expect(screen.queryByText("Generating QR...")).toBeNull();
    expect(screen.queryByTestId("pairing-qr")).toBeNull();
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    expect(errors).toHaveBeenCalledWith("[hunt] qr_render_failed", failure);
  });

  it("QR output that cannot be parsed is a failure too, not a loading state (P08-01)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(QRCode, "toString").mockImplementation(async () => "<svg></svg>");
    render(<MobileSyncModal isOpen onClose={() => undefined} />);

    expect(await screen.findByText(QR_FAILED)).toBeInTheDocument();
    expect(screen.queryByText("Generating QR...")).toBeNull();
  });

  it("an invalid snapshot file says how to fix it (P11-02)", async () => {
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    const input = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["{not json"], "snap.json", { type: "application/json" })] },
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Invalid snapshot file. Choose a .json snapshot exported from Hunt."
      )
    );
  });

  it("names the exported snapshot with the LOCAL calendar date (P29-01)", async () => {
    // 00:30 local on Jan 1: in any zone east of UTC the UTC date is still Dec 31.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 1, 0, 30, 0));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:hunt-test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    try {
      render(<MobileSyncModal isOpen onClose={() => undefined} />);
      fireEvent.click(screen.getByRole("button", { name: /Export Snapshot/ }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
      const anchor = anchorClick.mock.contexts[0] as HTMLAnchorElement;
      expect(anchor.download).toBe("hunt-sync-2026-01-01.json");
      await screen.findByText("Saved");
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});

// ---------------------------------------------------------------------------
// Review scope listbox: keyboard (P10-01 / P16-01), radius (P12-07), titles (P10-06)
// ---------------------------------------------------------------------------
describe("Review scope listbox", () => {
  beforeEach(async () => {
    await db.quests.bulkAdd([
      makeQuest("quest-a", "Launch", 0),
      makeQuest("quest-b", "Research", 1),
    ]);
  });

  async function openScopeMenu() {
    render(<TelemetryDashboardView />);
    const trigger = screen.getByRole("button", { name: /Filter review scope/ });
    fireEvent.click(trigger);
    const listbox = screen.getByRole("listbox", { name: "Quest filter options" });
    await screen.findByRole("option", { name: /Research/ });
    return { trigger, listbox };
  }

  it("opening moves focus to the selected option, which is the only Tab stop", async () => {
    const { listbox } = await openScopeMenu();
    const all = screen.getByRole("option", { name: /All Quests/ });
    expect(document.activeElement).toBe(all);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(listbox).toHaveClass("p-1", "rounded-xl");
    expect(listbox).not.toHaveClass("p-1.5");
  });

  it("reopening focuses the selected option (not the first) and makes it the Tab stop", async () => {
    const { trigger } = await openScopeMenu();
    act(() => {
      screen.getByRole("option", { name: /Research/ }).click();
    });
    fireEvent.click(trigger);
    const research = await screen.findByRole("option", { name: /Research/ });
    expect(research).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(research);
    expect(screen.getAllByRole("option").map((o) => o.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it("ArrowDown / ArrowUp wrap, Home and End jump, between the options", async () => {
    const { listbox } = await openScopeMenu();
    const [all, launch, research, other] = screen.getAllByRole("option");
    expect(other).toHaveTextContent("Other work");

    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(launch);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(research);
    fireEvent.keyDown(listbox, { key: "End" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all);
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(listbox, { key: "Home" });
    expect(document.activeElement).toBe(all);
  });

  it("Escape closes the list and returns focus to the trigger", async () => {
    const { trigger } = await openScopeMenu();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("picking an option applies it, closes the list and returns focus to the trigger", async () => {
    const { trigger, listbox } = await openScopeMenu();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    act(() => {
      (document.activeElement as HTMLButtonElement).click();
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAccessibleName("Filter review scope: Research");
  });

  it("the period chevrons show their label as a tooltip (P10-06)", () => {
    render(<TelemetryDashboardView />);
    for (const name of [/previous/i, /next/i]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("title", button.getAttribute("aria-label"));
    }
  });
});

// ---------------------------------------------------------------------------
// P11-04: display headings get tight leading
// ---------------------------------------------------------------------------
describe("display headings (P11-04)", () => {
  it("Review and Guide h1s set leading-tight", () => {
    const review = render(<TelemetryDashboardView />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");
    review.unmount();
    render(<GuideView />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("leading-tight");
  });
});
