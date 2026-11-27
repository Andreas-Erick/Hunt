# ADR-0010: A static browser demo from the same app

Status: Accepted · Date: 2026-11-27

## Context

People should be able to try Hunt without installing it,
as a live demo embedded in an iframe on a portfolio site
and served from a sub-path such as `/demos/hunt/`. The host
is static: it serves files and runs no server.

The desktop UI is already a client-side Next.js page that
keeps its data in IndexedDB (Dexie). Only two parts need a
server: the sync hub (`/api/sync`, ADR-0002) and window
control (`/api/window`, ADR-0009). The phone app is a single
HTML file that relies on the Android shell for storage,
notifications and widgets (ADR-0003).

## Options considered

- **Host the Next.js server.** Everything works, but it
  needs a running server, and the sync and window routes
  would face the internet.
- **A second build of the UI** (Vite or similar) for the
  web. Two bundlers for one app, and they drift apart.
- **Demo the phone app.** It is phone-shaped, but its
  storage and notifications go through the Android bridge,
  which would need a fake for nearly every call.
- **A static export of the desktop app.** Next's own
  `output: "export"`, with the server parts switched off
  and replaced behind an interface.

## Decision

`npm run build:web` sets `HUNT_WEB_DEMO=1`, and
`next.config.mjs` then:

- exports static files to `out/` (`output: "export"`);
- sets `basePath` from `HUNT_WEB_BASE_PATH` (default
  `/demos/hunt`), the only base-path setting;
- sets `pageExtensions` to `tsx`/`jsx`, so the
  `route.ts` handlers and the PWA manifest are not built;
- inlines `NEXT_PUBLIC_HUNT_DEMO=1`, read once as
  `IS_WEB_DEMO` in `src/lib/webDemo.ts`.

The script then removes the phone app, the APK and the
reminder service worker from `out/`.

Platform access sits behind `src/lib/platform.ts`
(`HuntPlatform`), picked at build time:

- `sync`: the HTTP transport to the hub, or `null`. With
  `null` a sync pass is a no-op rather than an error, and
  the page stops polling.
- `seedIfEmpty`: the native first-run template, or
  `buildDemoSeed` (`src/lib/demoSeed.ts`). The demo seed is
  deterministic, and its dates are relative to the visit.

The other demo stand-ins:

- `notificationAccess()` answers `unsupported`, so
  permission is never requested, no service worker is
  registered, and the reminder field says the demo sends
  no notifications.
- The Phone button opens `DemoPhoneSheet`, which explains
  that sync needs the real app and links to Releases.
- Dexie opens `HuntWebDemo` instead of `JourneyCommandDB`.
- `DemoBanner` shows "Live demo: data stays in your
  browser. Get the real app". Its **Reset demo** rewrites
  the seed, clears Hunt's localStorage keys (keeping the
  look and sound choice) and reloads.

Business logic is not forked: the store, the domain
modules and every view are the same code as the native
app.

## Consequences

- The native build is unchanged. It runs the same code
  with `IS_WEB_DEMO` false, and its routes and headers
  stay as they were.
- The base path is fixed at build time. URLs are
  root-absolute with the prefix (`/demos/hunt/_next/…`),
  not relative, because Next has no reliable relative
  mode. Serving the demo from another path means
  rebuilding with `HUNT_WEB_BASE_PATH`.
- The bundle still contains the unused sync client code.
  Nothing calls it: the smoke test fails on any request
  outside the demo's folder.
- The host needs no special headers. Nothing uses
  `SharedArrayBuffer`, and the demo sends no framing
  headers.
- The demo shares the host site's origin, so it shares
  localStorage with it. Reset clears only `hunt-`,
  `journey-hud-` and note-draft keys.
- Not in the demo: LAN sync and pairing, the phone app
  and its widgets, OS notifications, and window controls.
- A first visit downloads about 370 KB gzipped (1.2 MB
  raw, 12 requests). With a 4× slower CPU and a 10 Mbit/s
  link it is usable in under 2 s.
- `web-demo.yml` builds the demo and runs the Playwright
  smoke test (`npm run test:web-demo`) on every push. A
  release tag attaches `hunt-web-demo.zip`, with `out/`'s
  contents at its root.
