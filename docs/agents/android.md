# Android shell and widgets

The phone app is `public/hunt-mobile.html` in a WebView, wrapped by the
Java shell in `android-app/app/src/main/java/com/hunt/companion/`.
Decisions: ADR-0003 (one-file page + HuntCore), ADR-0004 (no Gradle),
ADR-0005 (looks), ADR-0006 (widgets and Pending Ticks).

## Invariants

- **Hunt rules live in HuntCore, never in Java.** The page builds the
  Widget Snapshot (`src/lib/widgetSnapshot.ts`) and applies Pending
  Ticks (`src/lib/pendingTicks.ts`); Java only draws and queues.
- **Only the bridge writes the state file.** Widget code appends to
  the Pending Tick queue through `PendingTicks`; nothing else.
- **Every file read and write holds `HuntFiles.LOCK`** and writes go
  through `HuntFiles` (atomic, `AtomicFile`). A read error is not an
  empty file: never write over a file you could not read.
- **Names that ship are frozen.** Renaming `DayWidgetProvider`,
  `DayWidgetService`, `StatsWidgetProvider` or `DayWidgetTapActivity`
  removes users' placed widgets. PendingIntent request codes live in
  `WidgetRequestCodes` and never change value.
- **Permissions are pinned** to INTERNET, ACCESS_NETWORK_STATE and
  VIBRATE (a test). Midnight refresh uses inexact `AlarmManager.set`.
- **Same signing key, always.** A different cert forces an uninstall,
  which wipes on-phone data. Never `adb uninstall`; use `install -r`.
- **Row taps go through `DayWidgetTapActivity`.** A broadcast receiver
  may not start an activity on Android 10+ (background launch rules).
- **Each `*_neon` layout/drawable has a `*_dawn` twin** with the same
  view ids and geometry; pick resources only through `WidgetLook`.
- **Java 11, framework APIs only** (no androidx). RemoteViews at
  minSdk 26: no plain `<View>`, no CheckBox; API 31+ attributes go in
  `-v31` resource folders.
- **No `@font` in widget layouts.** The launcher's restricted
  context makes a widget `TextView` ignore it; draw display type
  with `WidgetDisplayText` (fonts per look in `WidgetLook`).
- **Tint white vector icons with `android:tintMode="src_in"`**: the
  default `src_atop` ignores a translucent tint's alpha.

## Build

`bash android-app/build-apk.sh ./android-app <out.apk>`, with the
output outside the repo. It compiles every `*.java` and every `res/`
file, needs no edits for new classes, and checks the cert pin.
In a worktree, run `bash scripts/worktree.sh setup` first so the
pinned key is present.

## Test

- **Java logic**: JDK probes via `src/__tests__/helpers/javaProbe.ts`
  compile the real classes against fakes in
  `src/__tests__/fixtures/javaStubs/` (`android.util`, `org.json`).
  Keep logic in plain Java classes (`UndoWindow`, `DaySelection`,
  `StatsWidgetFit`, `PendingTicks`) so it can be probed.
- **Static guards**: `androidShell.test.ts` (bridge contract,
  manifest, permissions, build hygiene) and the `android*.test.ts`
  files. Guard invariants, not source text.
- **Page**: `src/__tests__/helpers/loadMobile.ts` boots the asset copy
  of the page in jsdom with a fake `AndroidBridge`.
- **On a device**: `scripts/android-smoke.sh` boots a headless
  emulator, installs the APK, and takes screenshots, taps and
  long-presses. Look at the screenshot before claiming a UI works.
  It drives only an emulator (`ANDROID_SERIAL=emulator-*`, else the
  first one adb lists), never a connected phone, and finds a JDK for
  avdmanager like `build-apk.sh` (JAVA_HOME, else Studio's JBR).
