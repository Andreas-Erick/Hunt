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
# Env: ANDROID_SDK_ROOT / ANDROID_HOME (default as build-apk.sh)
#      SMOKE_IMAGE (default: newest installed x86_64 phone image)
set -euo pipefail

die() { echo "android-smoke.sh: $*" >&2; exit 1; }

SDK=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${LOCALAPPDATA:+$LOCALAPPDATA/Android/Sdk}}}
SDK=${SDK:-$HOME/Android/Sdk}
[ -d "$SDK" ] || die "Android SDK not found at $SDK (set ANDROID_SDK_ROOT)"
EXE=""; [ -n "${WINDIR:-}" ] && EXE=".exe"
ADB="$SDK/platform-tools/adb$EXE"
EMU="$SDK/emulator/emulator$EXE"
AVDM="$SDK/cmdline-tools/latest/bin/avdmanager"
[ -n "$EXE" ] && AVDM="$AVDM.bat"
AVD=Hunt_Smoke
PKG=com.hunt.companion

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
  echo "creating AVD $AVD from $image"
  echo no | "$AVDM" create avd -n "$AVD" -k "$image" -d pixel_7 >/dev/null
}

wait_boot() {
  "$ADB" wait-for-device
  local i
  for i in $(seq 1 180); do
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] \
      && { echo "booted"; return; }
    sleep 2
  done
  die "emulator did not finish booting in 6 minutes"
}

running() { "$ADB" devices | tr -d '\r' | grep -q '^emulator-.*device$'; }

case "${1:-}" in
  boot)
    ensure_avd
    if running; then echo "already running"; exit 0; fi
    "$EMU" -avd "$AVD" -no-window -no-audio -no-boot-anim \
      -no-snapshot-save -gpu swiftshader_indirect >/dev/null 2>&1 &
    wait_boot
    "$ADB" shell settings put global window_animation_scale 0
    "$ADB" shell settings put global transition_animation_scale 0
    "$ADB" shell settings put global animator_duration_scale 0 ;;
  install)
    [ -f "${2:-}" ] || die "install needs an APK path"
    "$ADB" install -r "$2"
    "$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 \
      >/dev/null ;;
  shot)
    [ -n "${2:-}" ] || die "shot needs an output .png path"
    "$ADB" exec-out screencap -p > "$2"
    echo "saved $2" ;;
  tap) "$ADB" shell input tap "$2" "$3" ;;
  press) "$ADB" shell input swipe "$2" "$3" "$2" "$3" 1000 ;;
  home) "$ADB" shell input keyevent KEYCODE_HOME ;;
  stop) "$ADB" emu kill || true ;;
  *) die "usage: boot | install <apk> | shot <png> | tap x y | press x y | home | stop" ;;
esac
