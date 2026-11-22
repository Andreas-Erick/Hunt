<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"
      srcset="brand/logo/hunt-readme-dark.svg" />
    <source media="(prefers-color-scheme: light)"
      srcset="brand/logo/hunt-readme-light.svg" />
    <img src="brand/logo/hunt-readme-dark.svg"
      alt="Hunt logo" width="96" />
  </picture>
</p>

<h1 align="center">Hunt</h1>

<p align="center">
  Local-first focus timer, daily habits and weekly quests for
  one person. Runs on a Windows desktop and an Android phone,
  syncs over your own Wi-Fi, and needs no account or cloud.
</p>

<p align="center">
  <a href="https://github.com/Andreas-Erick/Hunt/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Andreas-Erick/Hunt/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-0B0C0E?style=flat-square&logo=nextdotjs" />
  <img alt="TypeScript 5.9 strict" src="https://img.shields.io/badge/TypeScript-5.9%20strict-0B0C0E?style=flat-square&logo=typescript" />
  <img alt="Android min 26, target 34" src="https://img.shields.io/badge/Android-min%2026%20%C2%B7%20target%2034-0B0C0E?style=flat-square&logo=android" />
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0B0C0E?style=flat-square" />
</p>

![Hunt desktop: today's queue and done-list](docs/screenshots/desktop-home.png)

<p align="center">
  <img src="docs/screenshots/mobile-today.png"
    alt="Android: today" width="48%" />
  <img src="docs/screenshots/mobile-habits.png"
    alt="Android: habits" width="48%" />
</p>

<details>
<summary><b>More screenshots</b></summary>

![Focus mode](docs/screenshots/desktop-focus.png)
![Habits](docs/screenshots/desktop-habits.png)
![Weekly review](docs/screenshots/desktop-review.png)

<img src="docs/screenshots/mobile-review.png"
  alt="Android: weekly review" width="48%" />

</details>

## What it does

You pick up to three **quests** with weekly hour targets,
queue **tasks** and daily **habits** under them, work on one
task at a time in **Focus**, and see where the hours went in
**Review** (day to year, plus an activity heatmap).

The desktop app keeps its data in IndexedDB. The phone keeps
an atomic JSON file through its Android shell. When both are
on the same network (or Tailscale), they converge through a
small sync server that runs inside the desktop app.

## Goals

- **One person, several devices, no account.**
- **Offline first.** Every device works on its own; sync
  only converges state and is never needed to use the app.
- **Merges can't depend on order.** The merge is
  commutative, associative and idempotent, checked by a
  400-seed property test.
- **Never overwrite data that can't be read.** The server
  and the phone keep a copy of an unreadable file before
  anything replaces it, and the server returns HTTP 507
  rather than merge over files it can't read at all.
- **Touch-first.** 44px targets on touch screens; layout is
  tested in a real browser from 360px to 2560px wide.

## Non-goals

- Multiple users, sharing, or permissions.
- Cloud hosting or sync over the public internet
  (use Tailscale for remote access).
- Real-time co-editing or character-level merges.
- iOS, or Play Store distribution.

## Architecture

```mermaid
flowchart TB
  V[Desktop views] --> S[Zustand store]
  S --> C[Domain core]
  S --> D[(IndexedDB)]
  S <--> H["/api/sync hub"]
  P[Android WebView] <--> H
  C -. bundled .-> P
```

These dependency rules are enforced by
[`architectureTopology.test.ts`](src/__tests__/architectureTopology.test.ts):

- No import cycles, including type-only imports.
- Domain modules (`syncTypes`, `focusSession`,
  `reviewAnalytics`, `habitDay`, …) never import React,
  Dexie or the store.
- Views never import the database module. Reads go
  through `lib/reads.ts`, writes through the store.

The phone doesn't reimplement the rules. The same
TypeScript (merge, focus state machine, burst logs, habit
rows) is bundled into it by
[`build-mobile-core.mjs`](scripts/build-mobile-core.mjs).
One test fails if that copy is stale, and another drives the
phone's focus buttons against the desktop modules step by
step.

<details>
<summary><b>Where things live</b></summary>

- `src/lib/` — domain core, sync contract, analytics
- `src/store/` — Zustand store and habit engine
- `src/components/` — desktop views
- `src/app/api/sync/` — sync hub, atomic file, backups
- `src/mobile/` — entry point of the phone bundle
- `public/hunt-mobile.html` — the phone app (one file)
- `android-app/` — WebView shell and APK build script
- `e2e/` — Playwright layout tests, 360–2560px
- `installer/` — Inno Setup script for Windows
- `docs/adr/` — design decisions

</details>

## Design decisions

| ADR | Decision | Trade-off |
| --- | --- | --- |
| [0001](docs/adr/0001-row-level-lww-merge.md) | Row-level LWW merge | Clock skew picks winners |
| [0002](docs/adr/0002-laptop-as-sync-hub.md) | Laptop is the hub | No sync while it's off |
| [0003](docs/adr/0003-single-file-phone-app.md) | One-file phone app | Types stop at HuntCore |
| [0004](docs/adr/0004-direct-apk-build.md) | No-Gradle signed APK | Custom build script |

## Quickstart

Needs Node 22 or newer (CI uses the version in `.nvmrc`).

```bash
git clone https://github.com/Andreas-Erick/Hunt.git
cd Hunt
npm ci
npm run dev        # http://localhost:3000
```

On Windows, `Start-Hunt.bat` opens Hunt in its own app
window. Optional settings (`HUNT_DATA_DIR`, `LOG_LEVEL`) are
listed in [`.env.example`](.env.example).

## Checks

```bash
npm run check          # lint, types, tests, build
npm run test:geometry  # Playwright, 360–2560px
```

`check` runs the same steps as CI's `verify` job, and CI
runs the geometry suite as a second job. The 1,250+ Vitest
tests are hermetic: virtual clocks, seeded random inputs,
`fake-indexeddb`, and temp directories.

`npm install` also sets up a pre-push hook that runs
`npm run check`, so a failing commit never reaches GitHub.

<details>
<summary><b>Building the Android app</b></summary>

Needs a JDK and the Android SDK. Releases are signed with a
key kept in CI secrets, so a local build uses your own key:

```bash
keytool -genkeypair -keystore my.jks -alias hunt \
  -keyalg RSA -keysize 2048 -validity 10000

KEYSTORE=my.jks KEY_ALIAS=hunt KS_PASS=yourpass \
EXPECTED_CERT_SHA256=skip \
bash android-app/build-apk.sh ./android-app ./Hunt.apk

adb install -r ./Hunt.apk
```

An APK signed with a different key can't update an existing
install. Android makes you uninstall first, which deletes
the phone's data. See
[ADR-0004](docs/adr/0004-direct-apk-build.md).

To pair, open **Phone & Sync** on the desktop and scan the
QR code. To revoke a phone, delete `data/hunt-sync.key`. A
new key is created on the next request, and the old one
stops working at once.

</details>

<details>
<summary><b>Releases</b></summary>

Pushing a `v*` tag runs
[`release.yml`](.github/workflows/release.yml). It reruns
the tests, lint and typecheck. It stops if `package.json` or
the Android `versionName` doesn't match the tag. Then it
publishes:

- `Hunt-Desktop-Setup-<version>.exe`: Windows installer
  with a bundled Node.js runtime
- `Hunt-Desktop-Windows-<version>.zip`: portable bundle
- `Hunt-Mobile-<version>.apk`: signed Android app
- `SHA256SUMS.txt`

`npm run screenshots` regenerates `docs/screenshots/` from
the current build, using made-up demo data.

</details>

## License

[MIT](LICENSE)
