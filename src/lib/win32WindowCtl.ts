import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

export type DesktopWindowAction =
  | "minimize"
  | "enter-fullscreen"
  | "exit-fullscreen"
  | "close";

export const DESKTOP_WINDOW_ACTIONS: readonly DesktopWindowAction[] = [
  "minimize",
  "enter-fullscreen",
  "exit-fullscreen",
  "close",
];

export function isDesktopWindowAction(val: unknown): val is DesktopWindowAction {
  return (
    typeof val === "string" &&
    (DESKTOP_WINDOW_ACTIONS as readonly string[]).includes(val)
  );
}

export interface Win32ActionResult {
  ok: boolean;
  found: boolean;
  detail?: string;
}

type Win32Executor = (action: DesktopWindowAction) => Promise<Win32ActionResult>;

let testOverrideExecutor: Win32Executor | null = null;

/** Test hook so unit tests never minimize or close real desktop windows. */
export function setWin32ActionExecutorForTests(fn: Win32Executor | null): void {
  testOverrideExecutor = fn;
}

/**
 * Self-contained C# 5 source compiled once via Windows' built-in .NET Framework
 * compiler (`csc.exe`) so window actions execute in ~15 ms with zero cold-start lag.
 */
const WINCTL_CS_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class HuntWinCtl {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int L;
    public int T;
    public int R;
    public int B;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int maxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int maxCount);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);

  [DllImport("user32.dll")]
  private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  private const int SW_MINIMIZE = 6;
  private const int SW_RESTORE = 9;
  private const uint WM_CLOSE = 0x0010;
  private const uint WM_KEYDOWN = 0x0100;
  private const uint WM_KEYUP = 0x0101;
  private const byte VK_F11 = 0x7A;
  private const byte SCAN_F11 = 0x57;
  private const uint KEYEVENTF_KEYUP = 0x0002;
  private const uint MONITOR_DEFAULTTONEAREST = 2;

  private static IntPtr FindHuntWindow() {
    IntPtr standalone = IntPtr.Zero;
    IntPtr fallback = IntPtr.Zero;
    string prefix = "Hunt \\u2014 Make time";

    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder cls = new StringBuilder(64);
      GetClassName(h, cls, 64);
      if (!cls.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) {
        return true;
      }
      StringBuilder titleSb = new StringBuilder(256);
      GetWindowText(h, titleSb, 256);
      string title = titleSb.ToString();
      if (title.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) {
        if (title.IndexOf(" - Google Chrome", StringComparison.OrdinalIgnoreCase) < 0 &&
            title.IndexOf(" - Microsoft", StringComparison.OrdinalIgnoreCase) < 0) {
          standalone = h;
          return false;
        }
        if (fallback == IntPtr.Zero) {
          fallback = h;
        }
      }
      return true;
    }, IntPtr.Zero);

    return standalone != IntPtr.Zero ? standalone : fallback;
  }

  private static bool IsMonitorFullscreen(IntPtr hWnd) {
    if (IsIconic(hWnd)) return false;
    RECT r;
    if (!GetWindowRect(hWnd, out r)) return false;
    IntPtr mon = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
    if (mon == IntPtr.Zero) return false;
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(mon, ref mi)) return false;
    int monW = mi.rcMonitor.R - mi.rcMonitor.L;
    int monH = mi.rcMonitor.B - mi.rcMonitor.T;
    int winW = r.R - r.L;
    int winH = r.B - r.T;
    return monW > 0 && monH > 0 && winW >= (monW - 8) && winH >= (monH - 8);
  }

  private static void SendF11Toggle(IntPtr hWnd, bool wantFullscreen) {
    PostMessage(hWnd, WM_KEYDOWN, (IntPtr)VK_F11, IntPtr.Zero);
    PostMessage(hWnd, WM_KEYUP, (IntPtr)VK_F11, IntPtr.Zero);
    Thread.Sleep(130);
    if (IsMonitorFullscreen(hWnd) != wantFullscreen) {
      SetForegroundWindow(hWnd);
      Thread.Sleep(30);
      if (GetForegroundWindow() == hWnd) {
        keybd_event(VK_F11, SCAN_F11, 0, UIntPtr.Zero);
        keybd_event(VK_F11, SCAN_F11, KEYEVENTF_KEYUP, UIntPtr.Zero);
      }
    }
  }

  public static int Main(string[] args) {
    string action = args.Length > 0 ? args[0] : "";
    if (action == "noop") {
      Console.WriteLine("OK:noop");
      return 0;
    }

    IntPtr hWnd = FindHuntWindow();
    if (hWnd == IntPtr.Zero) {
      Console.WriteLine("NOT_FOUND");
      return 2;
    }

    if (action == "minimize") {
      ShowWindow(hWnd, SW_MINIMIZE);
      Console.WriteLine("OK:minimize");
      return 0;
    }

    if (action == "exit-fullscreen") {
      if (IsMonitorFullscreen(hWnd)) {
        SendF11Toggle(hWnd, false);
      } else if (IsZoomed(hWnd)) {
        ShowWindow(hWnd, SW_RESTORE);
      }
      Console.WriteLine("OK:exit-fullscreen");
      return 0;
    }

    if (action == "enter-fullscreen") {
      if (IsIconic(hWnd)) {
        ShowWindow(hWnd, SW_RESTORE);
        Thread.Sleep(80);
      }
      if (!IsMonitorFullscreen(hWnd)) {
        SendF11Toggle(hWnd, true);
      }
      Console.WriteLine("OK:enter-fullscreen");
      return 0;
    }

    if (action == "close") {
      PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      Console.WriteLine("OK:close");
      return 0;
    }

    Console.WriteLine("UNKNOWN_ACTION");
    return 1;
  }
}
`;

const SOURCE_HASH = crypto
  .createHash("sha256")
  .update(WINCTL_CS_SOURCE)
  .digest("hex")
  .slice(0, 12);

let compileInFlight: Promise<string | null> | null = null;

/**
 * After a failed compile, window actions skip csc.exe for this long and answer
 * helper_unavailable at once, so the client falls back to the DOM APIs instead of
 * waiting out its deadline on every click.
 */
export const WINCTL_COMPILE_FAILURE_COOLDOWN_MS = 60_000;
let compileFailedAt: number | null = null;

function findCscCompiler(): string | null {
  const windir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function execFilePromise(
  file: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
            ? 1
            : 0;
        resolve({
          code,
          stdout: String(stdout ?? "").trim(),
          stderr: String(stderr ?? "").trim(),
        });
      }
    );
  });
}

async function compileWinCtlHelper(exePath: string): Promise<string | null> {
  try {
    const csc = findCscCompiler();
    if (!csc) return null;
    const csPath = path.join(
      os.tmpdir(),
      `hunt-winctl-${SOURCE_HASH}-${process.pid}.cs`
    );
    const tmpExe = path.join(
      os.tmpdir(),
      `hunt-winctl-${SOURCE_HASH}-${process.pid}.exe`
    );
    fs.writeFileSync(csPath, WINCTL_CS_SOURCE, "utf8");
    try {
      const res = await execFilePromise(
        csc,
        ["/nologo", "/optimize+", "/target:exe", `/out:${tmpExe}`, csPath],
        8000
      );
      if (res.code !== 0 || !fs.existsSync(tmpExe)) {
        return null;
      }
      try {
        fs.renameSync(tmpExe, exePath);
      } catch {
        if (!fs.existsSync(exePath)) {
          fs.copyFileSync(tmpExe, exePath);
        }
      }
      return fs.existsSync(exePath) ? exePath : null;
    } finally {
      try {
        if (fs.existsSync(csPath)) fs.unlinkSync(csPath);
      } catch {
        // Best-effort temp cleanup
      }
      try {
        if (fs.existsSync(tmpExe)) fs.unlinkSync(tmpExe);
      } catch {
        // Best-effort temp cleanup
      }
    }
  } catch {
    return null;
  }
}

export async function ensureCompiledWinCtlHelper(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const exePath = path.join(os.tmpdir(), `hunt-winctl-${SOURCE_HASH}.exe`);
  if (fs.existsSync(exePath)) return exePath;

  if (compileInFlight) return compileInFlight;

  if (
    compileFailedAt !== null &&
    Date.now() - compileFailedAt < WINCTL_COMPILE_FAILURE_COOLDOWN_MS
  ) {
    return null;
  }

  compileInFlight = (async () => {
    try {
      const compiled = await compileWinCtlHelper(exePath);
      compileFailedAt = compiled ? null : Date.now();
      return compiled;
    } finally {
      compileInFlight = null;
    }
  })();

  return compileInFlight;
}

export async function executeWin32WindowAction(
  action: DesktopWindowAction
): Promise<Win32ActionResult> {
  if (testOverrideExecutor) {
    return testOverrideExecutor(action);
  }
  if (process.platform !== "win32") {
    return { ok: false, found: false, detail: "unsupported_platform" };
  }

  const exe = await ensureCompiledWinCtlHelper();
  if (!exe) {
    return { ok: false, found: false, detail: "helper_unavailable" };
  }

  const res = await execFilePromise(exe, [action], 4000);
  if (res.code === 0 && res.stdout.startsWith("OK:")) {
    return { ok: true, found: true };
  }
  if (res.code === 2 || res.stdout === "NOT_FOUND") {
    return { ok: false, found: false, detail: "window_not_found" };
  }
  return {
    ok: false,
    found: false,
    detail: res.stderr || res.stdout || `exit_${res.code}`,
  };
}
