#!/usr/bin/env bash
# Run the phone app on a headless Android emulator and take screenshots,
# so a change to the Android shell or widgets can be seen, not guessed.
#
#   bash scripts/android-smoke.sh boot              start the emulator
#   bash scripts/android-smoke.sh install <apk>     adb install -r, launch
#   bash scripts/android-smoke.sh shot <out.png>    screenshot
#   bash scripts/android-smoke.sh tap <x> <y>       tap (screen pixels)
#   bash scripts/android-smoke.sh press <x> <y>     long-press (1 s)
#   bash scripts/android-smoke.sh home              go to the home screen
#   bash scripts/android-smoke.sh stop              shut the emulator down
#
# Uses its own AVD (Hunt_Smoke) so personal AVDs stay untouched. Build
# the APK first: bash android-app/build-apk.sh ./android-app <out.apk>
#
# Every adb call targets an emulator, never a phone that happens to be
# connected (USB or wireless debugging): ANDROID_SERIAL if it names an
# emulator, else the first emulator-* serial adb lists.
#
# Env: ANDROID_SDK_ROOT / ANDROID_HOME (default as build-apk.sh)
#      JAVA_HOME (for avdmanager; default: Android Studio's bundled JBR)
#      ANDROID_SERIAL (an emulator-* serial; default: the first emulator)
#      SMOKE_IMAGE (default: newest installed x86_64 phone image)
set -euo pipefail

die() { echo "android-smoke.sh: $*" >&2; exit 1; }

SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${LOCALAPPDATA:+$LOCALAPPDATA/Android/Sdk}}}
SDK=${SDK:-$HOME/Android/Sdk}
[ -d "$SDK" ] || die "Android SDK not found at $SDK (set ANDROID_SDK_ROOT)"
EXE=""; [ -n "${WINDIR:-}" ] && EXE=".exe"
ADB_BIN="$SDK/platform-tools/adb$EXE"
EMU="$SDK/emulator/emulator$EXE"
AVDM="$SDK/cmdline-tools/latest/bin/avdmanager"
[ -n "$EXE" ] && AVDM="$AVDM.bat"
AVD=Hunt_Smoke
PKG=com.hunt.companion

# avdmanager needs a JDK: JAVA_HOME, else Android Studio's JBR (as build-apk.sh).
find_jdk() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java$EXE" ]; then return; fi
  local cand
  for cand in "${LOCALAPPDATA:+$LOCALAPPDATA/Programs/Android Studio/jbr}" \
              "/c/Program Files/Android/Android Studio/jbr" \
              "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
              "$HOME/android-studio/jbr" "/opt/android-studio/jbr"; do
    if [ -n "$cand" ] && [ -x "$cand/bin/java$EXE" ]; then export JAVA_HOME=$cand; return; fi
  done
  command -v java >/dev/null 2>&1 || die "no JDK for avdmanager (set JAVA_HOME)"
}

# The emulator to drive. ANDROID_SERIAL must name an emulator; a phone is refused.
SERIAL=""
emulator_serial() {
  if [ -n "${ANDROID_SERIAL:-}" ]; then
    case "$ANDROID_SERIAL" in
      emulator-*) echo "$ANDROID_SERIAL"; return ;;
      *) die "ANDROID_SERIAL=$ANDROID_SERIAL is not an emulator; refusing to drive a device" ;;
    esac
  fi
  "$ADB_BIN" devices | tr -d '\r' | awk '$1 ~ /^emulator-/ { print $1; exit }'
}
adb() {
  [ -n "$SERIAL" ] || SERIAL=$(emulator_serial)
  [ -n "$SERIAL" ] || die "no emulator running (bash scripts/android-smoke.sh boot)"
  "$ADB_BIN" -s "$SERIAL" "$@"
}

pick_image() {
  if [ -n "${SMOKE_IMAGE:-}" ]; then echo "$SMOKE_IMAGE"; return; fi
  local d
  d=$(find "$SDK/system-images" -mindepth 3 -maxdepth 3 -type d \
        -name x86_64 2>/dev/null | grep -v -i wear | sort -V | tail -1)
  [ -n "$d" ] || die "no x86_64 phone system image installed"
  d=${d#"$SDK/"}
  echo "${d//\//;}"
}

ensure_avd() {
  "$EMU" -list-avds | tr -d '\r' | grep -qx "$AVD" && return
  local image
  image=$(pick_image)
  find_jdk
  echo "creating AVD $AVD from $image"
  echo no | "$AVDM" create avd -n "$AVD" -k "$image" -d pixel_7 >/dev/null
  "$EMU" -list-avds | tr -d '\r' | grep -qx "$AVD" || die "avdmanager did not create $AVD"
}

wait_boot() {
  local i
  for i in $(seq 1 60); do
    SERIAL=$(emulator_serial)
    [ -n "$SERIAL" ] && break
    sleep 2
  done
  [ -n "$SERIAL" ] || die "the emulator did not show up in adb devices"
  adb wait-for-device
  for i in $(seq 1 180); do
    [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] \
      && { echo "booted ($SERIAL)"; return; }
    sleep 2
  done
  die "emulator did not finish booting in 6 minutes"
}

running() { [ -n "$(emulator_serial)" ] && "$ADB_BIN" devices | tr -d '\r' | grep -q "^$(emulator_serial)[[:space:]]*device$"; }

case "${1:-}" in
  boot)
    ensure_avd
    if running; then echo "already running"; exit 0; fi
    "$EMU" -avd "$AVD" -no-window -no-audio -no-boot-anim \
      -no-snapshot-save -gpu swiftshader_indirect >/dev/null 2>&1 &
    wait_boot
    adb shell settings put global window_animation_scale 0
    adb shell settings put global transition_animation_scale 0
    adb shell settings put global animator_duration_scale 0 ;;
  install)
    [ -f "${2:-}" ] || die "install needs an APK path"
    adb install -r "$2"
    adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 \
      >/dev/null ;;
  shot)
    [ -n "${2:-}" ] || die "shot needs an output .png path"
    adb exec-out screencap -p > "$2"
    echo "saved $2" ;;
  tap) adb shell input tap "$2" "$3" ;;
  press) adb shell input swipe "$2" "$3" "$2" "$3" 1000 ;;
  home) adb shell input keyevent KEYCODE_HOME ;;
  stop) if [ -n "$(emulator_serial)" ]; then adb emu kill || true; else echo "no emulator running"; fi ;;
  *) die "usage: boot | install <apk> | shot <png> | tap x y | press x y | home | stop" ;;
esac
