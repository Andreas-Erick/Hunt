<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo/hunt-readme-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="brand/logo/hunt-readme-light.svg" />
    <img src="brand/logo/hunt-readme-dark.svg" alt="Hunt logo" width="96" height="96" />
  </picture>
</p>

<h1 align="center">Hunt</h1>

<p align="center">
  <strong>Local-first single-task focus, daily habits, and weekly quest telemetry across Desktop and native Android — synchronized over LAN via a deterministic CRDT merge engine with zero cloud dependency.</strong>
</p>

<p align="center">
  <a href="https://github.com/Andreas-Erick/Hunt/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/Andreas-Erick/Hunt/actions/workflows/ci.yml/badge.svg" />
  </a>
  <img alt="Next.js 14" src="https://img.shields.io/badge/Next.js-14-0B0C0E?style=flat-square&logo=nextdotjs&logoColor=white" />
  <img alt="TypeScript 5.7" src="https://img.shields.io/badge/TypeScript-5.7-0B0C0E?style=flat-square&logo=typescript&logoColor=00F0FF" />
  <img alt="Android API 26-36" src="https://img.shields.io/badge/Android-API%2026--36-0B0C0E?style=flat-square&logo=android&logoColor=00FF9D" />
</p>

---

## Overview

Hunt is built for deep-work practitioners who want calm, single-task execution instead of crowded Kanban boards or cloud-tethered SaaS subscriptions. You define up to three active **Quests** with weekly hour targets, schedule **Tasks** and recurring **Daily Habits**, lock into a distraction-free **Focus** timer, and review real **Done-List Telemetry** across your week.

All data lives locally on your devices — IndexedDB (Dexie) on desktop and atomic JSON files on Android — and converges automatically over your local Wi-Fi or Tailscale network through an authenticated `/api/sync` merge server.

### Desktop Interface

| Today & Done-List Timeline | Distraction-Free Focus Mode |
| :---: | :---: |
| ![Hunt Desktop Home](docs/screenshots/desktop-home.png) | ![Hunt Desktop Focus](docs/screenshots/desktop-focus.png) |

| Daily Habits & Consistency | Weekly Review Telemetry |
| :---: | :---: |
| ![Hunt Desktop Habits](docs/screenshots/desktop-habits.png) | ![Hunt Desktop Review](docs/screenshots/desktop-review.png) |

### Android Companion (`Pixel 9 Pro XL`)

| Today Queue & Spotlight | Daily Habits & Streaks | Weekly Review Telemetry |
| :---: | :---: | :---: |
| <img src="docs/screenshots/mobile-today.png" alt="Hunt Android Today" width="240" /> | <img src="docs/screenshots/mobile-habits.png" alt="Hunt Android Habits" width="240" /> | <img src="docs/screenshots/mobile-review.png" alt="Hunt Android Review" width="240" /> |

---

## System Architecture

```mermaid
flowchart LR
    subgraph Desktop["Desktop App (Next.js 14 + React 18)"]
        UI["Views: Home · Habits · Plan · Quests · Focus · Review · Guide"]
        Store["Zustand Store + Dexie IndexedDB v3"]
        DiagD["Structured Diagnostics & Breadcrumb Ring Buffer"]
        UI <--> Store
        Store --> DiagD
    end

    subgraph Server["Local LAN Sync Server (/api/sync)"]
        Auth["Timing-Safe X-Hunt-Token Auth + Streaming 16 MB Cap"]
        CRDT["Deterministic LWW CRDT Merge + Tombstone Sets"]
        Disk["Atomic Temp-Rename + 14-Day Backup Rotation"]
        Auth --> CRDT --> Disk
    end

    subgraph Android["Native Android Companion (API 26–36)"]
        Shell["MainActivity.java (Safe-Area FrameLayout + Zero-Shift IME Shell)"]
        Keystore["AndroidKeyStore AES-256-GCM Token Vault"]
        Web["Single-File HTML WebView (assets/hunt-mobile.html)"]
        Shell <--> Web
        Shell <--> Keystore
    end

    Store <-->|"HTTPS/LAN POST + X-Hunt-Correlation-Id"| Auth
    Shell <-->|"Native HttpURLConnection + Backoff"| Auth
```

### Engineering Highlights

- **Clock-Independent CRDT Sync & Crash-Safe Storage:** [`src/lib/syncTypes.ts`](src/lib/syncTypes.ts) and [`src/app/api/sync/route.ts`](src/app/api/sync/route.ts) implement a commutative, associative, idempotent last-write-wins merge over quests, tasks, habits, time logs, and bounded tombstone sets — verified across 400-seed property tests in [`syncProperties.test.ts`](src/__tests__/syncProperties.test.ts). Open and completed tasks, habits, quests, and focus logs support safe deletion (two-step confirm on desktop; 5-second Undo hold pill on Android) with deterministic cross-device tombstone convergence. Writes use temp-file + atomic rename with automatic rollback recovery across main, backup, and 14-day snapshots.
- **Deterministic Offline Daily Habits:** Daily habits materialize into per-day tasks using deterministic IDs (`habtsk-<YYYY-MM-DD>-<habitId>`), allowing laptop and phone to materialize identical tasks independently offline and converge without duplicate rows upon reconnect.
- **Multi-Horizon Review Telemetry & Activity Heatmap:** [`src/lib/reviewAnalytics.ts`](src/lib/reviewAnalytics.ts), [`TelemetryDashboardView.tsx`](src/components/TelemetryDashboardView.tsx), and the Android Review view provide DST-safe analytics across **Day, Week, Month, Quarter, and Year** horizons — counting both **focus hours** and **completed tasks** (split by regular steps vs. daily habits), session bout duration, active-day consistency, Quest "X" drill-down filtering, and a Monday–Sunday **Activity Heatmap** with streak and peak-rhythm insights.
- **Zero-Gradle Direct Android Build & Zero-Shift Mobile UX:** [`android-app/build-apk.sh`](android-app/build-apk.sh) compiles and signs the Android companion directly with `aapt2`, `javac`, `d8`, `zipalign`, and `apksigner` (verifying the pinned signing certificate and scanning for leaked secrets). [`MainActivity.java`](android-app/app/src/main/java/com/hunt/companion/MainActivity.java) stores pairing tokens exclusively in AndroidKeyStore AES-256-GCM envelopes, locks WebView navigation to an explicit origin allowlist, and pairs `SOFT_INPUT_ADJUST_NOTHING` inside a safe-area-padded `FrameLayout` with top-anchored floating composer sheets, a spacious 5-tab navigation bar (**Today · Plan · Focus · Quests · Habits**) + 1-tap **Review** header access, and compact bottom-anchored confirmation/Undo capsules.
- **Structured Observability & Root-Cause Diagnostics:** [`src/lib/diagnostics.ts`](src/lib/diagnostics.ts) propagates `X-Hunt-Correlation-Id` end-to-end across desktop, `/api/sync`, and mobile, records `durationMs` I/O telemetry, maintains bounded circular breadcrumb flight recorders, wires global unhandled fault traps (`error` / `unhandledrejection`), and recursively redacts bearer tokens and 64-hex keys (`[REDACTED]`).
- **Adversarial Security & Chaos Test Suite:** 29 Vitest suites (1,015+ tests) exercise boundary inputs, XSS/prototype-pollution/timing-safe auth pentesting ([`syncRouteSecurity.test.ts`](src/__tests__/syncRouteSecurity.test.ts), [`mobileSecurity.test.ts`](src/__tests__/mobileSecurity.test.ts)), 300-seed payload sanitizer fuzzing, 400-step random store fuzzing, 150-step mobile delete/Undo/sync chaos fuzzing, 100-seed multi-horizon telemetry property checks, Europe/Berlin DST rollover fuzzing, WCAG AA contrast ratios, and JDK compilation of `MainActivity.java` helpers.

---

## Project Structure

```text
.
├── src/
│   ├── app/
│   │   ├── api/sync/route.ts       # Authenticated CRDT merge API + atomic backup store
│   │   ├── layout.tsx              # Root shell, typography, icons & 100dvh layout
│   │   └── page.tsx                # View router, boot pipeline & global fault traps
│   ├── components/                 # Home, Habits, Plan, Quests, Focus, Review, Heatmap, Guide & Sync UI
│   ├── lib/
│   │   ├── db.ts                   # Dexie IndexedDB v3 schema, DST-safe dates & formatters
│   │   ├── diagnostics.ts          # Structured logging, redaction, breadcrumbs & fault traps
│   │   ├── hudAudio.ts             # Silent-by-default audio state & context lifecycle
│   │   ├── reviewAnalytics.ts      # Multi-horizon focus/task telemetry & activity heatmap engine
│   │   ├── syncEngine.ts           # Client diff-apply, AbortController timeout & tombstones
│   │   ├── syncTypes.ts            # Strict runtime schema validators & LWW CRDT merge
│   │   └── taskCompletionMotion.ts # Two-beat Things 3 / Linear task completion choreography
│   ├── store/useCommandStore.ts    # Zustand state machine, focus sessions & habit engine
│   └── __tests__/                  # 29 test suites (1,015+ unit, property, fuzz & security tests)
├── public/
│   └── hunt-mobile.html            # Self-contained mobile web & Android WebView UI
├── android-app/
│   ├── build-apk.sh                # Direct aapt2/javac/d8/apksigner APK build + verification
│   └── app/src/main/
│       ├── AndroidManifest.xml     # Least-privilege permissions & backup exclusion rules
│       ├── assets/hunt-mobile.html # Byte-identical mirror verified by mobileMirror.test.ts
│       └── java/com/hunt/companion/MainActivity.java
├── .github/workflows/
│   ├── ci.yml                      # Automated Vitest, tsc & Next.js build verification
│   └── release.yml                 # Builds & publishes Windows .exe/.zip + Android .apk
├── installer/hunt-desktop.iss      # Inno Setup script for Hunt-Desktop-Setup.exe
├── docs/screenshots/               # Desktop & Pixel 9 Pro XL app screenshots
├── brand/logo/                     # Vector logo marks and icon assets
├── Start-Hunt.bat                  # Windows standalone app-mode launcher
├── Start-Server.bat                # Production/dev server bootstrapper
└── .env.example                    # Optional runtime environment variables
```

---

## Quickstart

### Prerequisites

- **Node.js** 22+ (tested on Node 24) and **npm**
- *(Optional, for Android APK builds)* **JDK 11+** and **Android SDK** (`build-tools` + `platforms` + `adb`)

### Installation

```bash
git clone https://github.com/Andreas-Erick/Hunt.git
cd Hunt
npm install
```

*(Optional)* Copy `.env.example` to `.env.local` if you want to customize `HUNT_DATA_DIR` or `LOG_LEVEL`.

### Running Locally

**Development mode:**

```bash
npm run dev
```

**Production build & server:**

```bash
npm run build
npm run start
```

Open `http://localhost:3000` in your browser. On Windows, you can also run `Start-Hunt.bat` to launch Hunt in a standalone desktop app window.

### Running Tests & Typechecking

```bash
npm test
npx tsc --noEmit
```

All 28 test suites (1,009+ tests) are deterministic and hermetic (virtual clocks, seeded PRNGs, `fake-indexeddb`, and isolated temp directories).

### Building & Installing the Android Companion APK

1. Ensure `public/hunt-mobile.html` and `android-app/app/src/main/assets/hunt-mobile.html` are synced (enforced automatically by `mobileMirror.test.ts` and `build-apk.sh`).
2. Build and verify the signed APK:

```bash
bash android-app/build-apk.sh "./android-app" "./Hunt-Mobile.apk"
```

3. Install in-place over ADB without wiping existing phone data:

```bash
adb install -r "./Hunt-Mobile.apk"
```

Pair the phone once by opening **Phone & Sync** on desktop and scanning/entering the local LAN URL and pairing token stored in `data/hunt-sync.key`.

---

## Releases & Automated Installers

Pushing a version tag (e.g., `git tag v1.6.5 && git push origin v1.6.5`) or triggering **Actions → Release Desktop & Android Installers** runs [`.github/workflows/release.yml`](.github/workflows/release.yml), which verifies all 1,009+ tests + TypeScript and publishes a GitHub Release containing:

- **`Hunt-Desktop-Setup-<version>.exe`** — Windows Inno Setup installer (bundles Node.js + standalone Next.js server + Desktop/Start Menu shortcuts with `HUNT.ico`; no Node.js install required).
- **`Hunt-Desktop-Windows-<version>.zip`** — Self-contained portable Windows bundle.
- **`Hunt-Mobile-<version>.apk`** — Signed Android companion APK built via `build-apk.sh` (installs in-place over prior releases without wiping app data).
- **`SHA256SUMS.txt`** — Verification checksums for all release assets.
