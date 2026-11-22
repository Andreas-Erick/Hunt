# ADR-0004: Build the APK without Gradle

Status: Accepted · Date: 2026-11-22

## Context

The Android shell is one Activity (`MainActivity.java`)
with no third-party libraries. Android installs an update
only if it is signed with the same key as the installed
app. A different key means uninstalling first, and that
deletes the phone's data.

## Options considered

- **Gradle with the Android Gradle Plugin.** The standard
  route, but a large toolchain for one Java file. An earlier
  Gradle setup also signed with a different key from the
  one the shipped app used.
- **Direct SDK tools.** `aapt2`, `javac`, `d8`, `zipalign`
  and `apksigner`, called from a shell script.

## Decision

`android-app/build-apk.sh` calls the SDK tools directly.
Before it finishes, it:

- refuses a versionCode lower than the manifest's (a
  downgrade can't be installed);
- checks the signer certificate against a pinned SHA-256
  (`EXPECTED_CERT_SHA256`);
- checks that the packaged page matches
  `public/hunt-mobile.html`;
- scans the output for leaked secrets.

Release CI decodes the keystore from the
`ANDROID_KEYSTORE_BASE64` secret.

## Consequences

- The build is fast and readable end to end, and a wrong
  key fails the build instead of wiping a phone.
- Adding any library would mean adopting Gradle or
  resolving the dependency by hand.
- Contributors build with their own key and
  `EXPECTED_CERT_SHA256=skip` (see the README), which
  produces an APK that can't update the shipped app.
