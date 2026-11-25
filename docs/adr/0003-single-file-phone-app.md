# ADR-0003: One-file phone app with a bundled core

Status: Accepted · Date: 2026-11-22

## Context

The phone app must work offline, load instantly in an
Android WebView, and apply exactly the same merge, habit
and focus rules as the desktop. An earlier version
reimplemented those rules in the phone page, and the two
copies drifted apart.

## Options considered

- **React Native or Capacitor.** One component model, but
  a second build chain and a much larger APK.
- **Ship the Next.js build to the phone.** Reuses the
  views, but they are desktop-first and need a server.
- **One HTML file with the domain core bundled in.**

## Decision

`public/hunt-mobile.html` is self-contained: CSS, markup
and script, with no build step for the UI.

`scripts/build-mobile-core.mjs` uses esbuild to bundle
`src/mobile/huntCore.ts` into a marked block in the page.
That bundle covers the merge, stamps, habit rows, the focus
state machine, burst logs, task completion, the next-task
rule, and the Android widgets' side of it (ADR-0006): the
Widget Snapshot the widgets draw (rows, which can be
ticked, Quest progress and streaks) and applying Pending
Ticks. It also holds the due-reminders rule (ADR-0007).

Tests enforce the arrangement:

- `mobileCore.test.ts` fails if the bundled block is stale.
- `mobileMirror.test.ts` fails if the Android assets copy
  differs by a single byte.
- `mobileFocusParity.test.ts` drives the phone's focus
  buttons through seeded sequences and compares every step
  with the desktop modules.

## Consequences

- The APK stays around 200 KB and starts fast.
- Only code inside HuntCore is type-checked. The rest of
  the page (about 6,300 lines of script) is plain JS.
- The phone's input guard (`guardSyncState`) is still a
  separate copy of the server validator. A 300-seed parity
  test keeps the two in step.
