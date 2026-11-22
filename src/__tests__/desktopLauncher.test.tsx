// Desktop launcher: views never go blank after a Dexie versionchange, fullscreen taskbar
// hiding, the native window controls, and the Falcon shortcut icon refresh.
import os from "os";
import fs from "fs";
import path from "path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { db } from "@/lib/db";
import { BOOT_SAFETY_TIMEOUT_MS, bootOnce, resetBootOnceForTests } from "@/lib/bootSequence";
import { useCommandStore } from "@/store/useCommandStore";
import manifest from "@/app/manifest";
import HomePage from "@/app/page";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { FocusHudView } from "@/components/FocusHudView";
import { POST as windowRoutePost } from "@/app/api/window/route";
import {
  ensureCompiledWinCtlHelper,
  setWin32ActionExecutorForTests,
  type DesktopWindowAction,
} from "@/lib/win32WindowCtl";
import { ROOT, makeQuest, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

describe("Desktop launch reliability & fullscreen taskbar hiding", () => {
  it("keeps Dexie auto-open active when closing on versionchange so views never go blank", async () => {
    await db.quests.add(
      makeQuest("q-reopen", 0, "Persistent Quest", "cyan", "Survives versionchange")
    );

    // Fire the versionchange listener CommandCenterDB registers (another tab upgraded the schema).
    db.on("versionchange").fire(Object.assign(new Event("versionchange"), { oldVersion: 3, newVersion: 4 }));
    expect(db.isOpen()).toBe(false);

    // Subsequent queries (such as useLiveQuery on Quests/Habits) must auto-reopen seamlessly.
    const quests = await db.quests.toArray();
    expect(quests).toHaveLength(1);
    expect(quests[0].title).toBe("Persistent Quest");
    expect(db.isOpen()).toBe(true);
  });

  it("renders every desktop view without inline opacity:0 traps even under rapid tab switching", async () => {
    await db.quests.add(
      makeQuest("q-nav", 0, "Core Engineering", "purple", "Ship cleanly", 10)
    );
    await db.habits.add({
      id: "hab-nav",
      title: "Morning Review",
      questId: "q-nav",
      notes: "15 minutes",
      rank: 1000,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const { container } = render(<HomePage />);

    // Wait for initial boot ("Loading Hunt...") to complete and render the top navigation bar.
    await screen.findByRole("button", { name: "Quests" });
    expect(screen.queryByText("Loading Hunt...")).toBeNull();

    const tabs = ["Quests", "Habits", "Plan", "Review", "Guide", "Home"] as const;
    for (let round = 0; round < 2; round++) {
      for (const label of tabs) {
        fireEvent.click(screen.getByRole("button", { name: label }));
      }
    }

    // Also verify Focus view wrapper has no inline opacity:0 trap, then return to top-bar views
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    const focusWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(focusWrapper).not.toBeNull();
    expect(focusWrapper?.style.opacity).not.toBe("0");
    act(() => {
      useCommandStore.getState().setActiveView("command");
    });

    fireEvent.click(screen.getByRole("button", { name: "Quests" }));
    await waitFor(() => {
      expect(screen.getByText("Core Engineering")).toBeTruthy();
    });
    const questWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(questWrapper).not.toBeNull();
    expect(questWrapper?.style.opacity).not.toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Habits" }));
    await waitFor(() => {
      expect(screen.getByText("Morning Review")).toBeTruthy();
    });
    const habitsWrapper = container.querySelector(".hunt-view-enter") as HTMLElement | null;
    expect(habitsWrapper).not.toBeNull();
    expect(habitsWrapper?.style.opacity).not.toBe("0");
  });

  it("bounds bootOnce() with BOOT_SAFETY_TIMEOUT_MS if a boot step stalls and cleans up its timer", async () => {
    vi.useFakeTimers();
    resetBootOnceForTests();
    useCommandStore.setState({
      materializeDailyHabits: () => new Promise<number>(() => undefined),
    });

    let settled = false;
    const p = bootOnce().then(() => {
      settled = true;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOOT_SAFETY_TIMEOUT_MS - 50);
    });
    expect(settled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await p;
    expect(settled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("configures fullscreen PWA manifest and Launch-Hunt.vbs taskbar hiding + stale-build restart", () => {
    const appManifest = manifest();
    expect(appManifest.display).toBe("fullscreen");

    const vbs = fs.readFileSync(path.join(ROOT, "Launch-Hunt.vbs"), "utf8");
    expect(vbs).toContain("StopStaleServerIfRebuilt");
    expect(vbs).toContain(".next\\BUILD_ID");
    expect(vbs).toContain("--start-fullscreen");
    expect(vbs).toContain("EnsureHuntWindowFullscreen");
    expect(vbs).toContain('probeUrl & "/"');
    expect(vbs).toContain('probeUrl & "/api/sync"');
  });

  it("toggles browser fullscreen from TopTelemetryBar and cleans up fullscreenchange listener on unmount", async () => {
    let fsElement: Element | null = null;
    const reqSpy = vi.fn(async function (this: Element) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the stub records which element asked for fullscreen
      fsElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    const exitSpy = vi.fn(async () => {
      fsElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fsElement,
    });
    Object.defineProperty(document.documentElement, "requestFullscreen", {
      configurable: true,
      value: reqSpy,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: exitSpy,
    });

    // Window controls render only inside the desktop launcher (pairing key present);
    // the native window host declines here, so the DOM Fullscreen API fallback runs.
    window.localStorage.setItem("hunt-sync-token-v1", "a".repeat(64));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response)
    );

    const removeListenerSpy = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<TopTelemetryBar />);

    const enterBtn = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enterBtn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(enterBtn);
    });
    expect(reqSpy).toHaveBeenCalledTimes(1);

    const exitBtn = screen.getByRole("button", { name: "Exit fullscreen" });
    expect(exitBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(exitBtn);
    });
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Enter fullscreen" }).getAttribute("aria-pressed")).toBe(
      "false"
    );

    unmount();
    expect(removeListenerSpy).toHaveBeenCalledWith("fullscreenchange", expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// 6. Desktop Fullscreen Window Controls (Minimize, Restore/Fullscreen, Exit) & Icon Cache Busting
// ---------------------------------------------------------------------------
describe("Desktop fullscreen window controls & Falcon shortcut icon refresh", () => {
  afterEach(() => {
    setWin32ActionExecutorForTests(null);
  });

  it("renders Minimize, Fullscreen/Restore, and Exit controls in TopTelemetryBar and FocusHudView", async () => {
    const token = "a".repeat(64);
    window.localStorage.setItem("hunt-sync-token-v1", token);

    const fetchCalls: Array<{ url: string; action: string; token: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const body = init?.body ? (JSON.parse(String(init.body)) as { action: string }) : { action: "" };
        fetchCalls.push({
          url,
          action: body.action,
          token: headers.get("X-Hunt-Token"),
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, found: true, action: body.action }),
        } as unknown as Response;
      })
    );

    // Simulate OS/Browser --start-fullscreen where document.fullscreenElement is null
    // but innerWidth/innerHeight match screen.width/screen.height.
    Object.defineProperty(window, "screen", {
      configurable: true,
      value: { width: 1920, height: 1080 },
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });

    const bar = render(<TopTelemetryBar />);
    const minBtn = screen.getByRole("button", { name: "Minimize window" });
    const fsBtn = screen.getByRole("button", { name: "Exit fullscreen" });
    const exitBtn = screen.getByRole("button", { name: "Exit Hunt" });

    expect(fsBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      fireEvent.click(minBtn);
    });
    expect(fetchCalls.at(-1)).toEqual({
      url: "/api/window",
      action: "minimize",
      token,
    });

    await act(async () => {
      fireEvent.click(fsBtn);
    });
    expect(fetchCalls.at(-1)?.action).toBe("exit-fullscreen");

    // Resize to windowed dimensions updates button state to "Enter fullscreen"
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 980 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    const enterFsBtn = screen.getByRole("button", { name: "Enter fullscreen" });
    expect(enterFsBtn.getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(exitBtn);
    });
    expect(fetchCalls.at(-1)?.action).toBe("close");
    bar.unmount();

    // Verify FocusHudView also exposes Minimize, Fullscreen, and Exit Hunt controls (idle & active)
    const focusIdle = render(<FocusHudView />);
    expect(await screen.findByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit Hunt" })).toBeTruthy();
    focusIdle.unmount();

    await db.tasks.add({
      id: "t-focus-win",
      title: "Fullscreen Focus Task",
      notes: "",
      status: "active",
      questId: null,
      rank: 1000,
      accumulatedSeconds: 0,
      createdAt: 1000,
      updatedAt: 1000,
    });
    useCommandStore.setState({ activeView: "focus", activeTaskId: "t-focus-win" });

    const focusActive = render(<FocusHudView />);
    expect(await screen.findByText("Fullscreen Focus Task")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimize window" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Exit Hunt" })).toBeTruthy();
    focusActive.unmount();
  });

  it("enforces localhost + X-Hunt-Token auth on POST /api/window and dispatches valid actions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-win-api-"));
    const prevDataDir = process.env.HUNT_DATA_DIR;
    process.env.HUNT_DATA_DIR = tmpDir;
    const secret = "b".repeat(64);
    fs.writeFileSync(path.join(tmpDir, "hunt-sync.key"), secret, "utf8");

    const dispatched: DesktopWindowAction[] = [];
    setWin32ActionExecutorForTests(async (action) => {
      dispatched.push(action);
      return { ok: true, found: true };
    });

    try {
      // 1. Rejects non-localhost Host header (e.g. LAN peer)
      const lanRes = await windowRoutePost(
        new Request("http://192.168.1.50:3000/api/window", {
          method: "POST",
          headers: {
            host: "192.168.1.50:3000",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "minimize" }),
        })
      );
      expect(lanRes.status).toBe(403);

      // 2. Rejects cross-origin Origin header even on localhost
      const csrfRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            origin: "https://evil.example",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "close" }),
        })
      );
      expect(csrfRes.status).toBe(403);

      // 3. Rejects missing or wrong X-Hunt-Token
      const unauthRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            "content-type": "application/json",
            "x-hunt-token": "wrong",
          },
          body: JSON.stringify({ action: "minimize" }),
        })
      );
      expect(unauthRes.status).toBe(401);

      // 4. Rejects unknown action
      const badActionRes = await windowRoutePost(
        new Request("http://localhost:3000/api/window", {
          method: "POST",
          headers: {
            host: "localhost:3000",
            "content-type": "application/json",
            "x-hunt-token": secret,
          },
          body: JSON.stringify({ action: "reboot" }),
        })
      );
      expect(badActionRes.status).toBe(400);

      // 5. Dispatches all valid actions cleanly
      for (const action of [
        "minimize",
        "exit-fullscreen",
        "enter-fullscreen",
        "close",
      ] as const) {
        const okRes = await windowRoutePost(
          new Request("http://localhost:3000/api/window", {
            method: "POST",
            headers: {
              host: "localhost:3000",
              origin: "http://localhost:3000",
              "content-type": "application/json",
              "x-hunt-token": secret,
            },
            body: JSON.stringify({ action }),
          })
        );
        expect(okRes.status).toBe(200);
        const json = (await okRes.json()) as { ok: boolean; action: string };
        expect(json.ok).toBe(true);
        expect(json.action).toBe(action);
      }
      expect(dispatched).toEqual([
        "minimize",
        "exit-fullscreen",
        "enter-fullscreen",
        "close",
      ]);
    } finally {
      if (prevDataDir === undefined) delete process.env.HUNT_DATA_DIR;
      else process.env.HUNT_DATA_DIR = prevDataDir;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("compiles native Win32 window helper cleanly on Windows and configures HUNT-Falcon.ico cache busting", async () => {
    if (process.platform === "win32") {
      const exe = await ensureCompiledWinCtlHelper();
      expect(exe).not.toBeNull();
      expect(fs.existsSync(exe!)).toBe(true);
    }

    const vbs = fs.readFileSync(path.join(ROOT, "Launch-Hunt.vbs"), "utf8");
    expect(vbs).toContain("RefreshHuntShortcuts");
    expect(vbs).toContain("HUNT-Falcon.ico");
    expect(vbs).toContain("MonitorFromWindow");

    const iss = fs.readFileSync(path.join(ROOT, "installer", "hunt-desktop.iss"), "utf8");
    expect(iss).toContain("HUNT-Falcon.ico");
    expect(iss).toContain("ChangesAssociations=yes");

    const workflow = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "release.yml"),
      "utf8"
    );
    expect(workflow).toContain("HUNT-Falcon.ico");
  });
});
