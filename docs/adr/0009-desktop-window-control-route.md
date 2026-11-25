# ADR-0009: Desktop window control through a local route

Status: Accepted · Date: 2026-11-25

## Context

On Windows, Hunt runs as a borderless fullscreen window
with the taskbar hidden, so it needs its own Minimize,
Fullscreen and Exit buttons. A web page can't minimize or
close its window, and the DOM Fullscreen API shows a
"Press Esc" toast and is a different state from the
`--start-fullscreen` the launcher uses. The app already
runs a local Next.js server on the laptop (ADR-0002).

## Options considered

- **Electron.** Full window control, but ships its own
  Chromium and Node, a large install and a second update
  channel.
- **Tauri.** A small binary, but adds a Rust toolchain to
  the build and a WebView2 shell beside the Next.js server.
- **Browser app window plus a small Win32 bridge.** The
  launcher opens Chrome or Edge with `--app`, and a
  Next.js route drives the window through `user32.dll`.

## Decision

`Launch-Hunt.vbs` (run by `Start-Hunt.bat`) starts the
server with `Start-Server.bat`, which prefers a bundled
`node.exe`. It reads `data/hunt-sync.key` and opens:

```text
chrome --app=http://localhost:3000/?token=<key>
  --start-fullscreen
```

Edge is used when Chrome is missing, and a plain browser
tab when neither is found. The page stores the key and
strips it from the address bar.

`src/lib/desktopWindow.ts` POSTs `{action}` to
`/api/window` with the key as `X-Hunt-Token`. Actions are
`minimize`, `enter-fullscreen`, `exit-fullscreen` and
`close`. The route (`src/app/api/window/route.ts`):

- answers 403 unless `Host` is localhost or 127.0.0.1 and
  any `Origin` is too (`isLocalDesktopOriginRequest`);
- checks the token in constant time against the sync key
  (`authorizeRequestWithSyncKey`), 401 when wrong;
- accepts only JSON of at most 512 bytes and a known
  action.

`src/lib/win32WindowCtl.ts` holds a small C# program that
finds the Hunt window (a `Chrome_WidgetWin_` window titled
"Hunt — Make time") and calls `ShowWindow`, `PostMessage`
(WM_CLOSE, F11) or `keybd_event`. Windows' built-in .NET
Framework `csc.exe` compiles it once into the temp folder,
named by a hash of its source, and each action runs that
exe with `execFile`.

## Consequences

- No extra runtime: the install is the Next.js build, the
  bundled Node and a browser the user already has.
- Off Windows, or without `csc.exe`, the route answers
  `unsupported_platform` or `helper_unavailable`. The page
  falls back to the DOM Fullscreen API and
  `window.close()`; Minimize has no fallback and does
  nothing. After a failed compile the helper is skipped
  for 60 s, so clicks don't wait on it.
- The buttons only show when the page holds the sync key
  (`useIsDesktopLauncher`), so a tablet on the LAN URL
  never sees them.
- A local endpoint that drives OS windows is guarded by
  the token, not by the Host check: a LAN client can send
  any `Host`, so the token is what stops it. The Origin
  check stops other local browser tabs.
- The first action after a reboot or an update pays for
  one compile (a few seconds). Later actions start a
  cached exe, about 15 ms, with no PowerShell start-up.
- The launcher's own fullscreen and icon fix-up still
  runs once through PowerShell's `Add-Type`, off the click
  path.
- The helper finds the window by its title, so renaming
  the page title breaks the buttons until the helper and
  the launcher are updated too.
