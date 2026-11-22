import fs from "fs";
import path from "path";
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import QRCode from "qrcode";
import tailwindConfig from "../../tailwind.config";
import { db, seedInitialDataIfNeeded } from "@/lib/db";
import { buildLocalSyncPayload, syncDataExistsElsewhere } from "@/lib/syncEngine";
import { validateSyncPayload } from "@/lib/syncTypes";
import { useCommandStore } from "@/store/useCommandStore";
import HomePage from "@/app/page";
import { viewport } from "@/app/layout";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { MobileSyncModal, buildPairingUrl } from "@/components/MobileSyncModal";
import { RegionErrorBoundary } from "@/components/RegionErrorBoundary";
import {
  NOTES_DRAFT_KEY_PREFIX,
  restoreMirroredNoteDrafts,
} from "@/components/TaskNotesField";

// next/font is a Next.js build-time transform; outside Next the module has no runtime exports.
vi.mock("next/font/google", () => {
  const font = (options: { variable: string }) => ({
    className: "next-font",
    variable: `next-font-var${options.variable}`,
    style: { fontFamily: "next-font" },
  });
  return { Space_Grotesk: font, JetBrains_Mono: font, Hanken_Grotesk: font, Newsreader: font };
});

const ROOT = path.resolve(__dirname, "..", "..");
const TOKEN_KEY = "hunt-sync-token-v1";
const LAN = "http://192.168.1.5:3000";
/** A fake pairing key with characters a URL query must escape. */
const KEY = "k3y+/=&#?%" + "a1".repeat(20);
const BOUNDARY_TEXT =
  "Couldn't load this section from your local Hunt data. Nothing was deleted.";
const DB_ERROR_TEXT =
  "Couldn't open your local Hunt data in this browser. Nothing was deleted.";
const FOCUSABLE = 'button, a[href], input:not([type="hidden"])';

// Real store actions, restored after each test replaces them with spies.
const realActions = (() => {
  const s = useCommandStore.getState();
  return { syncNow: s.syncNow, autoSync: s.autoSync, requestSync: s.requestSync };
})();

/** Small deterministic PRNG (mulberry32) for the seeded loops. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Demo data, as on a first launch against an EMPTY local sync server. */
async function seedDemoData() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          payload: { quests: [], tasks: [], timeLogs: [], deletedTaskIds: [], deletedLogIds: [] },
        }),
      }) as unknown as Response
    )
  );
  try {
    await seedInitialDataIfNeeded(syncDataExistsElsewhere);
  } finally {
    vi.unstubAllGlobals();
  }
}

/** Collects unhandled promise rejections (Node and window) until stop(). */
function trackUnhandledRejections() {
  const seen: unknown[] = [];
  const onNode = (reason: unknown) => seen.push(reason);
  const onWindow = (e: Event) => seen.push((e as PromiseRejectionEvent).reason);
  process.on("unhandledRejection", onNode);
  window.addEventListener("unhandledrejection", onWindow);
  return {
    seen,
    stop() {
      process.off("unhandledRejection", onNode);
      window.removeEventListener("unhandledrejection", onWindow);
    },
  };
}

/** One full event-loop turn (setImmediate is never faked here), so rejections get reported. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Waits (inside act) for real I/O such as IndexedDB, one setImmediate turn at a
 * time. For tests that fake setTimeout, where RTL's waitFor/findBy cannot run.
 */
async function waitUntil(check: () => boolean, label: string, maxTurns = 500) {
  for (let i = 0; i < maxTurns; i++) {
    if (check()) return;
    await act(async () => {
      await nextTurn();
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Lets pending promise callbacks run inside act. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function namedError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

/** Renders the open modal and waits for its QR code (no state updates after the test). */
async function renderModal(onClose: () => void = () => undefined) {
  const view = render(<MobileSyncModal isOpen onClose={onClose} />);
  await screen.findByTestId("pairing-qr");
  return view;
}

/** The controls the dialog's Tab cycle moves through, in DOM order. */
function tabStops(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.hasAttribute("disabled")
  );
}

type TransactionFn = (...args: unknown[]) => unknown;

/** db.transaction that runs read-only transactions for real and rejects every "rw" one. */
function failWriteTransactions(error: Error) {
  const real = db.transaction.bind(db) as unknown as TransactionFn;
  const spy = vi.spyOn(db, "transaction") as unknown as MockInstance<TransactionFn>;
  spy.mockImplementation((...args: unknown[]) =>
    args[0] === "rw" ? Promise.reject(error) : real(...args)
  );
  return spy;
}

let syncNow: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let autoSync: ReturnType<typeof vi.fn<() => Promise<boolean>>>;

beforeEach(async () => {
  await db.quests.clear();
  await db.tasks.clear();
  await db.timeLogs.clear();
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem("hunt-sync-tombstones-v1");
  await seedDemoData();

  syncNow = vi.fn(async () => true);
  autoSync = vi.fn(async () => true);
  useCommandStore.setState({
    activeView: "command",
    activeTaskId: null,
    isRunning: false,
    sessionStartedAt: null,
    lastCompletedFeedback: null,
    actionError: null,
    isSyncOnline: true,
    syncError: null,
    lastSyncedAt: null,
    lanUrls: [LAN],
    phoneLastSeenAt: null,
    syncNow,
    autoSync,
    requestSync: vi.fn(),
  });
});

afterEach(() => {
  cleanup(); // unmount before restoring the store (no updates outside act)
  // Dexie schedules its live-query signal with setTimeout; never drop it.
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(window.navigator, "clipboard");
  window.localStorage.removeItem(TOKEN_KEY);
  useCommandStore.setState({ ...realActions, actionError: null, lanUrls: [] });
});

// ---------------------------------------------------------------------------
// RegionErrorBoundary
// ---------------------------------------------------------------------------
describe("RegionErrorBoundary", () => {
  function Bomb({ fuse }: { fuse: { armed: boolean } }) {
    if (fuse.armed) throw namedError("TypeError", "malformed row");
    return <p>Region content</p>;
  }

  it("shows the inline card, logs the region, and Retry remounts the children", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fuse = { armed: true };
    render(
      <RegionErrorBoundary region="Widget">
        <Bomb fuse={fuse} />
      </RegionErrorBoundary>
    );

    expect(screen.getByRole("alert")).toHaveTextContent(BOUNDARY_TEXT);
    expect(errors).toHaveBeenCalledWith(
      "[hunt] render_error",
      "Widget",
      expect.objectContaining({ message: "malformed row" })
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();

    fuse.armed = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Region content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Retry on a region that still fails shows the card again (no crash loop)", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <RegionErrorBoundary region="Widget">
        <Bomb fuse={{ armed: true }} />
      </RegionErrorBoundary>
    );
    for (let i = 0; i < 10; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    }
    expect(screen.getByRole("alert")).toHaveTextContent(BOUNDARY_TEXT);
  });

  it("renders nothing with fallback={null}, and a custom fallback node as given", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <RegionErrorBoundary region="Pill" fallback={null}>
        <Bomb fuse={{ armed: true }} />
      </RegionErrorBoundary>
    );
    expect(container).toBeEmptyDOMElement();
    cleanup();

    render(
      <RegionErrorBoundary region="Custom" fallback={<span>custom fallback</span>}>
        <Bomb fuse={{ armed: true }} />
      </RegionErrorBoundary>
    );
    expect(screen.getByText("custom fallback")).toBeInTheDocument();
  });

  it("offers Close when onDismiss is given; Close resets the boundary and calls it", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fuse = { armed: true };
    const onDismiss = vi.fn(() => {
      fuse.armed = false;
    });
    render(
      <RegionErrorBoundary region="Overlay" onDismiss={onDismiss}>
        <Bomb fuse={fuse} />
      </RegionErrorBoundary>
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Region content")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// App shell (page.tsx): view boundaries, DB-open error, action errors, auto-sync
// ---------------------------------------------------------------------------
describe("HomePage shell", () => {
  it("boot moves a launcher ?token= key into storage and out of the URL before the seed check", async () => {
    await db.quests.clear();
    await db.tasks.clear();
    await db.timeLogs.clear(); // empty profile: the seed step asks the server
    window.history.replaceState(null, "", `/?token=${encodeURIComponent(KEY)}&view=plan#top`);
    const seedCheck = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response
    );
    vi.stubGlobal("fetch", seedCheck);
    try {
      // A fresh page module: the boot runs once per module (page load).
      vi.resetModules();
      const { useCommandStore: freshStore } = await import("@/store/useCommandStore");
      freshStore.setState({ syncNow: vi.fn(async () => true), autoSync: vi.fn(async () => true) });
      const { default: FreshPage } = await import("@/app/page");

      render(<FreshPage />);
      await screen.findByRole("button", { name: "Plan" });

      expect(window.localStorage.getItem(TOKEN_KEY)).toBe(KEY);
      expect(window.location.search).toBe("?view=plan");
      expect(window.location.hash).toBe("#top");
      expect(seedCheck).toHaveBeenCalledTimes(1);
      const headers = seedCheck.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers["X-Hunt-Token"]).toBe(KEY);
    } finally {
      vi.unstubAllGlobals();
      window.history.replaceState(null, "", "/");
    }
  });

  it("a failed IndexedDB read shows the Home card while the nav stays usable; Retry recovers", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = namedError("UnknownError", "boom");
    const read = vi.spyOn(db.tasks, "toArray").mockRejectedValue(failure);

    render(<HomePage />);

    const card = await screen.findByRole("alert");
    expect(card).toHaveTextContent(BOUNDARY_TEXT);
    expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
    expect(errors).toHaveBeenCalledWith("[hunt] render_error", "Home", failure);

    read.mockRestore();
    fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
    expect((await screen.findAllByText("Design the next chapter")).length).toBeGreaterThan(0);
    expect(screen.queryByText(BOUNDARY_TEXT)).toBeNull();
  });

  it("only the failing view is replaced: switching to another view works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(db.tasks, "toArray").mockRejectedValue(namedError("DataError"));
    render(<HomePage />);
    await screen.findByText(BOUNDARY_TEXT);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("Weekly review")).toBeInTheDocument();
    expect(screen.queryByText(BOUNDARY_TEXT)).toBeNull();
  });

  it("unmounting while the failing read is still pending causes no unhandled rejection", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejectRead: (err: unknown) => void = () => undefined;
    const read = vi.spyOn(db.tasks, "toArray").mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRead = reject;
        }) as unknown as ReturnType<typeof db.tasks.toArray>
    );
    const unhandled = trackUnhandledRejections();
    try {
      const { unmount } = render(<HomePage />);
      await waitFor(() => expect(read).toHaveBeenCalled());
      unmount();
      rejectRead(namedError("UnknownError", "late failure"));
      await nextTurn();
      await nextTurn();
      expect(unhandled.seen).toEqual([]);
      expect(errors).not.toHaveBeenCalledWith("[hunt] render_error", expect.anything(), expect.anything());
    } finally {
      unhandled.stop();
    }
  });

  it("shows the DB-open error with Retry when the database failed to open", async () => {
    vi.spyOn(db, "hasFailed").mockReturnValue(true);
    render(<HomePage />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(DB_ERROR_TEXT);
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows no DB-open error when the database opened", async () => {
    render(<HomePage />);
    await screen.findByRole("button", { name: "Plan" });
    expect(screen.queryByText(DB_ERROR_TEXT)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("always opens on the Home screen on launch even if localStorage previously stored another view, and switches to Quests immediately", async () => {
    window.localStorage.setItem(
      "journey-hud-command-store",
      JSON.stringify({
        state: {
          activeView: "quests",
          activeTaskId: null,
          isRunning: false,
          sessionStartedAt: null,
          focusUpdatedAt: 100,
        },
        version: 0,
      })
    );
    await useCommandStore.persist.rehydrate();
    expect(useCommandStore.getState().activeView).toBe("command");

    render(<HomePage />);
    const nav = within(await screen.findByRole("navigation"));
    expect(nav.getByRole("button", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(await screen.findByText("Quest Work")).toBeInTheDocument();

    // Rapid view switches mount Quests immediately without AnimatePresence wedging
    fireEvent.click(nav.getByRole("button", { name: "Quests" }));
    fireEvent.click(nav.getByRole("button", { name: "Plan" }));
    fireEvent.click(nav.getByRole("button", { name: "Quests" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Quests" })
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 2, name: "Launch my idea" })
    ).toBeInTheDocument();
  });

  it("the 5 s interval calls autoSync (only while visible); resume and focus call syncNow", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { unmount } = render(<HomePage />);
    await screen.findByRole("button", { name: "Plan" });
    syncNow.mockClear();
    autoSync.mockClear();

    await act(() => vi.advanceTimersByTimeAsync(4999));
    expect(autoSync).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(autoSync).toHaveBeenCalledTimes(1);
    expect(syncNow).not.toHaveBeenCalled();

    // Hidden window: no background sync, and a hidden visibilitychange syncs nothing.
    setDocumentHidden(true);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(autoSync).toHaveBeenCalledTimes(1);
    expect(syncNow).not.toHaveBeenCalled();

    // Visible again: one immediate syncNow; the focus event right after is covered by it.
    setDocumentHidden(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(syncNow).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(syncNow).toHaveBeenCalledTimes(2);
    expect(autoSync).toHaveBeenCalledTimes(1);

    unmount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(autoSync).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledTimes(2);
  });

  it("shows the store's actionError in a role=alert strip; Dismiss clears it", async () => {
    useCommandStore.setState({ actionError: "Could not read or save local data in this browser" });
    render(<HomePage />);
    const strip = await screen.findByRole("alert");
    expect(strip).toHaveTextContent("Could not read or save local data in this browser");

    fireEvent.click(within(strip).getByRole("button", { name: "Dismiss" }));
    expect(useCommandStore.getState().actionError).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the actionError strip visible in Focus, where the header is hidden", async () => {
    useCommandStore.setState({ activeView: "focus", actionError: "Could not read or save local data in this browser" });
    render(<HomePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read or save local data");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("a store action whose IndexedDB write fails surfaces in the strip", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<HomePage />);
    await screen.findByRole("button", { name: "Plan" });
    vi.spyOn(db.tasks, "update").mockRejectedValueOnce(namedError("QuotaExceededError"));
    await act(async () => {
      await useCommandStore.getState().updateTask("tsk-01", { notes: "x" });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read or save local data in this browser"
    );
  });
});

describe("layout viewport", () => {
  it("does not cap zoom", () => {
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport).not.toHaveProperty("maximumScale");
    expect(viewport.userScalable).not.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TopTelemetryBar
// ---------------------------------------------------------------------------
describe("TopTelemetryBar", () => {
  it("names the logo button 'Hunt, go to Home' and marks the active nav button", () => {
    useCommandStore.setState({ activeView: "plan" });
    render(<TopTelemetryBar />);

    const logo = screen.getByRole("button", { name: "Hunt, go to Home" });
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByRole("button", { name: "Plan" })).toHaveAttribute("aria-current", "page");
    for (const label of ["Home", "Focus", "Quests", "Review"]) {
      expect(nav.getByRole("button", { name: label })).not.toHaveAttribute("aria-current");
    }

    fireEvent.click(logo);
    expect(useCommandStore.getState().activeView).toBe("command");
    expect(nav.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("button", { name: "Plan" })).not.toHaveAttribute("aria-current");
  });

  it("marks Review as current for the legacy 'log' view", () => {
    useCommandStore.setState({ activeView: "log" });
    render(<TopTelemetryBar />);
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-current", "page");
  });

  it("a failing session pill disappears without taking the header down", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = namedError("UnknownError", "pill read failed");
    vi.spyOn(db.tasks, "get").mockRejectedValue(failure);
    useCommandStore.setState({ activeTaskId: "tsk-01" });

    render(<TopTelemetryBar />);
    await waitFor(() =>
      expect(errors).toHaveBeenCalledWith("[hunt] render_error", "Session timer", failure)
    );
    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Phone sync:/ })).toBeInTheDocument();
    expect(screen.queryByText(BOUNDARY_TEXT)).toBeNull();
  });

  it("a crashing Phone & Sync modal shows the card with Retry and Close; Close dismisses it", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useCommandStore.setState({ lanUrls: null as unknown as string[] }); // corrupted state
    render(<TopTelemetryBar />);

    fireEvent.click(screen.getByRole("button", { name: /Phone sync:/ }));
    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent(BOUNDARY_TEXT);
    expect(errors).toHaveBeenCalledWith("[hunt] render_error", "Phone & Sync", expect.any(TypeError));
    expect(within(card).getByRole("button", { name: "Retry" })).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    useCommandStore.setState({ lanUrls: [LAN] });
    fireEvent.click(screen.getByRole("button", { name: /Phone sync:/ }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("globals.css", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");

  it("defines .no-scrollbar and compiles every class the shell uses (no xs: screen)", async () => {
    const sources = [
      ["src", "components", "TopTelemetryBar.tsx"],
      ["src", "components", "MobileSyncModal.tsx"],
      ["src", "components", "RegionErrorBoundary.tsx"],
      ["src", "app", "page.tsx"],
    ].map((parts) => ({ raw: fs.readFileSync(path.join(ROOT, ...parts), "utf8"), extension: "tsx" }));
    const result = await postcss([
      tailwindcss({ ...tailwindConfig, content: sources, corePlugins: { preflight: false } }),
    ]).process(css, { from: undefined });

    for (const selector of [
      ".border-hud-amber\\/20",
      ".bg-hud-amber\\/\\[0\\.06\\]",
      ".text-hud-amber",
      ".top-16",
      ".sm\\:top-20",
      ".my-auto",
      ".overflow-y-auto",
    ]) {
      expect(result.css, selector).toContain(`${selector} {`);
    }

    expect(result.css).toMatch(/\.no-scrollbar\s*\{\s*scrollbar-width:\s*none;?\s*\}/);
    expect(result.css).toMatch(/\.no-scrollbar::-webkit-scrollbar\s*\{\s*display:\s*none;?\s*\}/);
    expect(result.css).toContain(".sm\\:inline {");
    expect(result.css).not.toContain("xs\\:inline");
    expect(result.css).toContain(".text-hud-muted {");
    expect(result.css).toContain(".sm\\:items-center {");
  });

  it("drops the invalid and unused rules", () => {
    for (const dead of [
      "selection-background-color",
      "#060709",
      ".bg-hud-grid",
      ".bg-hud-subgrid",
      ".hud-scanlines",
      ".clip-chamfer",
      ".text-glow-",
    ]) {
      expect(css, dead).not.toContain(dead);
    }
  });

  it("SystemLogView is removed from src/components (and archived when _archive exists)", () => {
    expect(fs.existsSync(path.join(ROOT, "src", "components", "SystemLogView.tsx"))).toBe(false);
    const archiveDir = path.join(ROOT, "_archive", "pre-audit-2026-11-18");
    if (fs.existsSync(archiveDir)) {
      expect(fs.existsSync(path.join(archiveDir, "src", "components", "SystemLogView.tsx"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MobileSyncModal
// ---------------------------------------------------------------------------
describe("buildPairingUrl", () => {
  it("is the plain address while no key is known", () => {
    expect(buildPairingUrl(LAN, "")).toBe(LAN);
  });

  it("points at the phone page with the encoded key", () => {
    expect(buildPairingUrl(LAN, KEY)).toBe(
      `${LAN}/hunt-mobile.html?token=${encodeURIComponent(KEY)}`
    );
    expect(buildPairingUrl(`${LAN}/`, "x".repeat(32))).toBe(
      `${LAN}/hunt-mobile.html?token=${"x".repeat(32)}`
    );
  });

  it("round-trips any printable key through URLSearchParams (seeded)", () => {
    const seed = 0x5eed11;
    const rand = mulberry32(seed);
    for (let i = 0; i < 300; i++) {
      const length = 32 + Math.floor(rand() * 225); // 32..256
      let key = "";
      for (let j = 0; j < length; j++) key += String.fromCharCode(0x21 + Math.floor(rand() * 94));
      const url = new URL(buildPairingUrl(LAN, key));
      expect(url.origin, `seed ${seed} iteration ${i}`).toBe(LAN);
      expect(url.pathname, `seed ${seed} iteration ${i}`).toBe("/hunt-mobile.html");
      expect(url.searchParams.get("token"), `seed ${seed} iteration ${i}`).toBe(key);
      expect(url.hash, `seed ${seed} iteration ${i}`).toBe("");
    }
  });
});

describe("MobileSyncModal: pairing link", () => {
  it("QR code and Copy carry the pairing link; the key is never shown", async () => {
    window.localStorage.setItem(TOKEN_KEY, KEY);
    const qr = vi.spyOn(QRCode, "toString");
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    const pairing = `${LAN}/hunt-mobile.html?token=${encodeURIComponent(KEY)}`;

    const { container } = render(<MobileSyncModal isOpen onClose={() => undefined} />);
    await screen.findByTestId("pairing-qr");
    expect(qr.mock.calls.map((c) => c[0])).toEqual([pairing]);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(pairing);

    expect(screen.getByText(LAN)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(KEY);
    expect(container.innerHTML).not.toContain(encodeURIComponent(KEY));
    expect(container.innerHTML).not.toContain("a1a1a1");
    expect(screen.queryByText(/desktop launcher/)).toBeNull();
  });

  it("draws a camera-readable QR: dark modules on white with a 4-module quiet zone", async () => {
    window.localStorage.setItem(TOKEN_KEY, KEY);
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    await waitFor(() => expect(screen.queryByText("Generating QR...")).toBeNull());

    const svg = screen.getByTestId("pairing-qr").querySelector("svg");
    expect(svg).not.toBeNull();
    const paths = Array.from(svg?.querySelectorAll("path") ?? []);
    const background = paths.find((p) => p.getAttribute("fill"));
    const modules = paths.find((p) => p.getAttribute("stroke"));
    expect(background?.getAttribute("fill")?.toLowerCase()).toBe("#ffffff");
    expect(modules?.getAttribute("stroke")?.toLowerCase()).toBe("#000000");

    // The first module starts 4 units in from the top-left corner (the quiet zone).
    const firstMove = /^M(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/.exec(modules?.getAttribute("d") ?? "");
    expect(firstMove).not.toBeNull();
    expect(Number(firstMove?.[1])).toBeGreaterThanOrEqual(4);
    expect(Number(firstMove?.[2])).toBeGreaterThanOrEqual(4);
  });

  it.each([
    ["no stored key", null],
    ["an invalid (too short) stored key", "short-key"],
    ["a whitespace-only stored key", "   "],
  ])("with %s: the QR and Copy use the address and the launcher hint shows", async (_label, stored) => {
    if (stored !== null) window.localStorage.setItem(TOKEN_KEY, stored);
    const qr = vi.spyOn(QRCode, "toString");
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);

    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    expect(
      screen.getByText("Open Hunt with the desktop launcher to load the pairing key.")
    ).toBeInTheDocument();
    await screen.findByTestId("pairing-qr");
    expect(qr.mock.calls.map((c) => c[0])).toEqual([LAN]);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByText("Copied");
    expect(writeText).toHaveBeenCalledWith(LAN);
  });

  it("the QR follows the selected LAN address", async () => {
    window.localStorage.setItem(TOKEN_KEY, KEY);
    const second = "http://10.0.0.7:3000";
    useCommandStore.setState({ lanUrls: [LAN, second] });
    const qr = vi.spyOn(QRCode, "toString");
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    await screen.findByTestId("pairing-qr");

    fireEvent.click(screen.getByRole("button", { name: "10.0.0.7:3000" }));
    await waitFor(() =>
      expect(qr).toHaveBeenLastCalledWith(
        `${second}/hunt-mobile.html?token=${encodeURIComponent(KEY)}`,
        expect.anything()
      )
    );
  });
});

describe("MobileSyncModal: phone layout", () => {
  it("scrolls on short screens and wraps the footer", async () => {
    await renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("fixed", "inset-0", "overflow-y-auto", "items-start", "sm:items-center");
    expect(dialog.firstElementChild).toHaveClass("my-auto");
    const footerGroup = screen.getByRole("button", { name: /Export Snapshot/ }).parentElement;
    expect(footerGroup).toHaveClass("flex-wrap");
  });

  it("a backdrop click closes; clicks inside, or a drag from inside to the backdrop, do not", async () => {
    const onClose = vi.fn();
    await renderModal(onClose);
    const dialog = screen.getByRole("dialog");
    const heading = screen.getByRole("heading", { name: /Phone & Cross-Device Sync/ });

    fireEvent.mouseDown(heading);
    fireEvent.click(heading);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(heading);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(dialog);
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MobileSyncModal: focus", () => {
  it("moves focus in, wraps Tab both ways, and Escape returns focus to the Phone button", () => {
    render(<TopTelemetryBar />);
    const phone = screen.getByRole("button", { name: /Phone sync:/ });
    phone.focus();
    fireEvent.click(phone);

    const dialog = screen.getByRole("dialog");
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(close);

    const stops = tabStops(dialog);
    const first = stops[0];
    const last = stops[stops.length - 1];
    expect(first).toBe(close);
    expect(last).toHaveTextContent("Merge Snapshot");
    expect(stops.some((el) => el instanceof HTMLInputElement)).toBe(false);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    // In the middle, Tab is left to the browser.
    const middle = stops[1];
    middle.focus();
    const tab = createEvent.keyDown(middle, { key: "Tab" });
    fireEvent(middle, tab);
    expect(tab.defaultPrevented).toBe(false);

    // Focus on the dialog itself (a click on a non-focusable spot): Shift+Tab stays inside.
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(phone);
  });

  it("Escape calls onClose", async () => {
    const onClose = vi.fn();
    await renderModal(onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not try to refocus an opener that is gone", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<MobileSyncModal isOpen onClose={() => undefined} />);
    opener.remove();
    expect(() => unmount()).not.toThrow();
    expect(document.activeElement).not.toBe(opener);
  });
});

describe("MobileSyncModal: actions", () => {
  let createUrl: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
  let revokeUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
  let anchorClick: MockInstance<() => void>;

  beforeEach(() => {
    createUrl = vi.fn(() => "blob:hunt-test");
    revokeUrl = vi.fn();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = revokeUrl;
    anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  });

  const status = () => screen.getByRole("status");
  const exportButton = () => screen.getByRole("button", { name: /Export Snapshot|Saved/ });
  const mergeButton = () => screen.getByRole("button", { name: /Merge Snapshot/ });

  it("Export downloads a valid snapshot, shows 'Saved', and reverts after the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    render(<MobileSyncModal isOpen onClose={() => undefined} />);

    fireEvent.click(exportButton());
    await waitUntil(() => screen.queryByText("Saved") !== null, "Saved");
    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    const anchor = anchorClick.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toMatch(/^hunt-sync-\d{4}-\d{2}-\d{2}\.json$/);
    expect(revokeUrl).toHaveBeenCalledWith("blob:hunt-test");
    const blob = createUrl.mock.calls[0][0];
    expect(validateSyncPayload(JSON.parse(await blob.text())).valid).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Export Snapshot")).toBeInTheDocument();
  });

  it("a failed export shows an error status, logs it, and leaves no unhandled rejection", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = namedError("UnknownError", "read failed");
    vi.spyOn(db, "transaction").mockRejectedValue(failure);
    const unhandled = trackUnhandledRejections();
    try {
      render(<MobileSyncModal isOpen onClose={() => undefined} />);
      fireEvent.click(exportButton());
      await waitFor(() => expect(status()).toHaveTextContent("Could not export the snapshot."));
      expect(status()).toHaveClass("text-hud-amber");
      expect(errors).toHaveBeenCalledWith("[hunt] snapshot_export_failed", failure);
      expect(createUrl).not.toHaveBeenCalled();
      expect(exportButton()).not.toBeDisabled();
      await nextTurn();
      expect(unhandled.seen).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it.each([
    ["one per render", false],
    ["all in one tick, before React re-renders the disabled button", true],
  ])("10 rapid Export clicks (%s) build and download one snapshot", async (_label, sameTick) => {
    await renderModal();
    const reads = vi.spyOn(db, "transaction");
    const button = exportButton();
    if (sameTick) {
      act(() => {
        for (let i = 0; i < 10; i++) button.click();
      });
    } else {
      for (let i = 0; i < 10; i++) fireEvent.click(button);
    }
    await screen.findByText("Saved");
    expect(reads).toHaveBeenCalledTimes(1);
    expect(createUrl).toHaveBeenCalledTimes(1);
  });

  it("export and import disable both buttons while running, with aria-busy on the running one", async () => {
    let finishRead: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finishRead = resolve;
    });
    const real = db.transaction.bind(db) as unknown as TransactionFn;
    (vi.spyOn(db, "transaction") as unknown as MockInstance<TransactionFn>).mockImplementationOnce(
      (...args: unknown[]) => pending.then(() => real(...args))
    );
    render(<MobileSyncModal isOpen onClose={() => undefined} />);

    fireEvent.click(exportButton());
    expect(exportButton()).toBeDisabled();
    expect(exportButton()).toHaveAttribute("aria-busy", "true");
    expect(mergeButton()).toBeDisabled();
    expect(mergeButton()).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      finishRead();
    });
    await screen.findByText("Saved");
    expect(exportButton()).not.toBeDisabled();
    expect(mergeButton()).not.toBeDisabled();

    // Import: a file whose read is still pending.
    let finishFile: (text: string) => void = () => undefined;
    const file = new File(["{}"], "snap.json", { type: "application/json" });
    file.text = () =>
      new Promise<string>((resolve) => {
        finishFile = resolve;
      });
    const input = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(mergeButton()).toBeDisabled();
    expect(mergeButton()).toHaveAttribute("aria-busy", "true");
    expect(exportButton()).toBeDisabled();

    await act(async () => {
      finishFile("{not json");
    });
    await waitFor(() => expect(status()).toHaveTextContent("Invalid snapshot file."));
    expect(mergeButton()).not.toBeDisabled();
  });

  it("unmounting mid-export causes no state updates, errors or unhandled rejections", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failRead: (err: unknown) => void = () => undefined;
    vi.spyOn(db, "transaction").mockImplementation(
      () =>
        new Promise((_, reject) => {
          failRead = reject;
        }) as unknown as ReturnType<typeof db.transaction>
    );
    const unhandled = trackUnhandledRejections();
    try {
      const { unmount } = render(<MobileSyncModal isOpen onClose={() => undefined} />);
      fireEvent.click(exportButton());
      unmount();
      failRead(namedError("UnknownError", "late"));
      await nextTurn();
      expect(unhandled.seen).toEqual([]);
      for (const call of errors.mock.calls) {
        expect(call[0]).toBe("[hunt] snapshot_export_failed");
      }
    } finally {
      unhandled.stop();
    }
  });

  it("a rejected clipboard write shows the failure text; a later successful copy clears it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(namedError("NotAllowedError", "Document is not focused"))
      .mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<MobileSyncModal isOpen onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(status()).toHaveTextContent("Copy failed. Select the link manually.")
    );
    expect(status()).toHaveClass("text-hud-amber");

    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByText("Copied");
    expect(status()).toHaveTextContent("Away from home Wi-Fi? Sync via snapshot file:");
  });

  it("with a pairing key, a failed copy points to the QR code (the visible address has no key)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    window.localStorage.setItem(TOKEN_KEY, KEY);
    setClipboard(undefined); // no Clipboard API at all
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(status()).toHaveTextContent("Copy failed. Scan the QR code with your phone instead.")
    );
  });

  it("clicking Copy and then unmounting leaves no timers behind", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    useCommandStore.setState({ phoneLastSeenAt: Date.now() - 1000 }); // arms the live-window timer
    setClipboard(vi.fn(async () => undefined));
    // As in the app, focus returns to the opener on close.
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<MobileSyncModal isOpen onClose={() => undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    await settle();
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(document.activeElement).toBe(opener);
    // Every focus() makes jsdom run its own 60 Hz rendering loop, which stops itself
    // after one idle tick. 17 ms is far shorter than any modal timer, so a leaked
    // one would still be counted below.
    vi.advanceTimersByTime(17);
    expect(vi.getTimerCount()).toBe(0);
    opener.remove();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["JSON that is not a snapshot", JSON.stringify({ quests: "nope" })],
    ["an empty file", ""],
    ["a script payload", "<script>alert(1)</script>"],
  ])("import of %s shows 'Invalid snapshot file.' and writes nothing", async (_label, text) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = await db.tasks.count();
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    const input = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([text], "snap.json", { type: "application/json" })] },
    });
    await waitFor(() => expect(status()).toHaveTextContent("Invalid snapshot file."));
    expect(status()).toHaveClass("text-hud-amber");
    expect(await db.tasks.count()).toBe(before);
    expect(errors).not.toHaveBeenCalledWith("[hunt] snapshot_import_failed", expect.anything());
  });

  it("an import whose local save fails says so (not 'Invalid snapshot file.') and logs it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = JSON.stringify(
      await buildLocalSyncPayload({ activeTaskId: null, isRunning: false, sessionStartedAt: null, updatedAt: 0 })
    );
    const failure = namedError("QuotaExceededError", "disk full");
    failWriteTransactions(failure);

    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    const input = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([snapshot], "snap.json", { type: "application/json" })] },
    });
    await waitFor(() =>
      expect(status()).toHaveTextContent("Could not save the snapshot locally.")
    );
    expect(status()).toHaveClass("text-hud-amber");
    expect(errors).toHaveBeenCalledWith("[hunt] snapshot_import_failed", failure);
  });

  it("a successful import merges, syncs, and the message clears after a moment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const payload = await buildLocalSyncPayload({
      activeTaskId: null,
      isRunning: false,
      sessionStartedAt: null,
      updatedAt: 0,
    });
    const imported = {
      ...payload,
      tasks: [
        ...payload.tasks,
        {
          id: "tsk-imported-1",
          title: "Imported from the phone",
          notes: "",
          questId: null,
          status: "queued",
          rank: 99_000,
          accumulatedSeconds: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };
    render(<MobileSyncModal isOpen onClose={() => undefined} />);
    const callsBefore = syncNow.mock.calls.length;
    const input = screen.getByRole("dialog").querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File([JSON.stringify(imported)], "snap.json", { type: "application/json" })] },
    });

    await waitUntil(
      () => status().textContent === "Snapshot merged · syncing",
      "the merge message"
    );
    expect((await db.tasks.get("tsk-imported-1"))?.title).toBe("Imported from the phone");
    expect(syncNow.mock.calls.length).toBe(callsBefore + 1);
    expect(input.value).toBe("");

    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(status()).toHaveTextContent("Away from home Wi-Fi? Sync via snapshot file:");
  });

  it("the footer status is a polite live region", async () => {
    await renderModal();
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status()).toHaveClass("text-hud-muted");
  });
});

// ---------------------------------------------------------------------------
// restoreMirroredNoteDrafts
// ---------------------------------------------------------------------------
describe("restoreMirroredNoteDrafts: keeps a draft the restore could not write", () => {
  const key = (taskId: string) => `${NOTES_DRAFT_KEY_PREFIX}${taskId}`;
  const put = (taskId: string, value: unknown) =>
    window.localStorage.setItem(key(taskId), typeof value === "string" ? value : JSON.stringify(value));
  const mirrorKeys = () =>
    Object.keys(window.localStorage).filter((k) => k.startsWith(NOTES_DRAFT_KEY_PREFIX));

  afterEach(() => {
    for (const k of mirrorKeys()) window.localStorage.removeItem(k);
  });

  it("a rejected transaction returns 0 and keeps the key; the next run restores it and removes the key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.tasks.update("tsk-01", { notes: "base" });
    put("tsk-01", { draft: "base + typed before reload", base: "base" });
    vi.spyOn(db, "transaction").mockRejectedValueOnce(namedError("AbortError", "transaction aborted"));

    expect(await restoreMirroredNoteDrafts()).toBe(0);
    expect(window.localStorage.getItem(key("tsk-01"))).not.toBeNull();
    expect((await db.tasks.get("tsk-01"))?.notes).toBe("base");
    expect(errors).toHaveBeenCalled();

    expect(await restoreMirroredNoteDrafts()).toBe(1);
    expect(window.localStorage.getItem(key("tsk-01"))).toBeNull();
    expect((await db.tasks.get("tsk-01"))?.notes).toBe("base + typed before reload");
  });

  it("removes corrupt, wrongly shaped and id-less mirrors without touching IndexedDB", async () => {
    const tx = vi.spyOn(db, "transaction");
    put("tsk-01", "{not json");
    put("tsk-02", { draft: 42, base: "" });
    put("tsk-03", null);
    put("", { draft: "no task id", base: "" });

    expect(await restoreMirroredNoteDrafts()).toBe(0);
    expect(mirrorKeys()).toEqual([]);
    expect(tx).not.toHaveBeenCalled();
  });

  it("removes a mirror whose draft is already saved", async () => {
    await db.tasks.update("tsk-01", { notes: "same text" });
    put("tsk-01", { draft: "same text", base: "same text" });
    expect(await restoreMirroredNoteDrafts()).toBe(0);
    expect(mirrorKeys()).toEqual([]);
  });

  it("one failing transaction keeps only its own key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.tasks.update("tsk-01", { notes: "a" });
    await db.tasks.update("tsk-02", { notes: "b" });
    put("tsk-01", { draft: "a!", base: "a" });
    put("tsk-02", { draft: "b!", base: "b" });
    put("tsk-gone", { draft: "deleted task", base: "" });
    vi.spyOn(db, "transaction").mockRejectedValueOnce(namedError("UnknownError"));

    expect(await restoreMirroredNoteDrafts()).toBe(1);
    const left = mirrorKeys();
    expect(left).toHaveLength(1);
    const keptId = left[0].slice(NOTES_DRAFT_KEY_PREFIX.length);
    expect(["tsk-01", "tsk-02"]).toContain(keptId);
    const restoredId = keptId === "tsk-01" ? "tsk-02" : "tsk-01";
    expect((await db.tasks.get(restoredId))?.notes).toMatch(/!$/);
    expect((await db.tasks.get(keptId))?.notes).not.toMatch(/!$/);
  });
});

// ---------------------------------------------------------------------------
// Desktop icons, launcher IPv4 probe & audio mute persistence
// ---------------------------------------------------------------------------
describe("desktop launcher, taskbar favicon & audio persistence", () => {
  it("declares raster favicon icons in layout metadata and ships public/favicon.ico", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const { metadata } = await import("@/app/layout");
    const icons = metadata.icons as {
      icon?: Array<{ url: string }>;
      shortcut?: string;
      apple?: string;
    };
    expect(icons?.shortcut).toBe("/favicon.ico");
    expect(icons?.apple).toBe("/hunt-logo.png");
    expect(icons?.icon?.map((i) => i.url)).toEqual(
      expect.arrayContaining(["/favicon.ico", "/hunt-logo.png"])
    );

    const icoPath = path.resolve(process.cwd(), "public", "favicon.ico");
    expect(fs.existsSync(icoPath)).toBe(true);
    const bytes = fs.readFileSync(icoPath);
    // Standard ICO header: reserved=0, type=1, count>=1
    expect(bytes.readUInt16LE(0)).toBe(0);
    expect(bytes.readUInt16LE(2)).toBe(1);
    expect(bytes.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
  });

  it("Launch-Hunt.vbs probes 127.0.0.1 (avoiding Windows IPv6 ::1 timeout) while opening localhost", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const vbs = fs.readFileSync(path.resolve(process.cwd(), "Launch-Hunt.vbs"), "utf8");
    expect(vbs).toContain('probeUrl = "http://127.0.0.1:3000"');
    expect(vbs).toContain('url = "http://localhost:3000"');
    expect(vbs).toContain('probeUrl & "/favicon.ico"');
    expect(vbs).toContain('probeUrl & "/api/sync"');
  });

  it("persists audio mute toggle across remounts", async () => {
    const { AUDIO_MUTED_STORAGE_KEY } = await import("@/lib/hudAudio");
    window.localStorage.removeItem(AUDIO_MUTED_STORAGE_KEY);
    const first = render(<TopTelemetryBar />);
    const muteBtn = screen.getByRole("button", { name: "Mute interface audio" });
    fireEvent.click(muteBtn);
    expect(window.localStorage.getItem(AUDIO_MUTED_STORAGE_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "Unmute interface audio" })).toBeInTheDocument();
    first.unmount();

    render(<TopTelemetryBar />);
    expect(
      await screen.findByRole("button", { name: "Unmute interface audio" })
    ).toBeInTheDocument();
    window.localStorage.removeItem(AUDIO_MUTED_STORAGE_KEY);
  });

  it("MobileSyncModal sets inert on background siblings while open and restores on close", () => {
    const appMain = document.createElement("main");
    document.body.appendChild(appMain);
    const opener = document.createElement("button");
    appMain.appendChild(opener);
    opener.focus();

    try {
      const { rerender } = render(<MobileSyncModal isOpen onClose={() => undefined} />);
      expect(appMain.hasAttribute("inert")).toBe(true);

      rerender(<MobileSyncModal isOpen={false} onClose={() => undefined} />);
      expect(appMain.hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(opener);
    } finally {
      appMain.remove();
    }
  });

  it("hudAudio never opens an AudioContext: every cue is silent while unmuted", async () => {
    const { hudAudio } = await import("@/lib/hudAudio");
    const constructed = vi.fn();
    const OriginalAudioContext = window.AudioContext;
    class MockAudioContext {
      state = "running";
      constructor() {
        constructed();
      }
    }
    Object.defineProperty(window, "AudioContext", {
      value: MockAudioContext,
      configurable: true,
      writable: true,
    });
    try {
      hudAudio.muted = false;
      hudAudio.playClick();
      hudAudio.playClick();
      hudAudio.playLockOn();
      hudAudio.playComplete();
      expect(constructed).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "AudioContext", {
        value: OriginalAudioContext,
        configurable: true,
        writable: true,
      });
    }
  });
});
