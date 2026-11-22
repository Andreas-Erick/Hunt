#!/usr/bin/env bash
# =============================================================================
# build-apk.sh - direct (no Gradle) APK build for the Hunt Android app
#                (package com.hunt.companion, WebView wrapper around
#                 app/src/main/assets/hunt-mobile.html).
#
# Pipeline (same as the one that produced the shipped Hunt-Mobile.apk):
#   aapt2 compile res -> aapt2 link (manifest + android.jar + assets, emits R.java)
#   -> javac (every *.java under app/src/main/java + R.java; any *.kt / *.gradle.kts under android-app
#      fails the build: the old Gradle/Kotlin path built a different app with another key)
#   -> d8 -> add classes.dex to the APK (JDK jar tool by default)
#   -> zipalign -p 4 -> apksigner sign (v1+v2+v3, same key as the shipped APK)
#   -> apksigner verify + certificate SHA-256 pin + badging/asset checks
#   -> public/hunt-mobile.html mirror check + secret scan (data/hunt-sync.key must not ship).
#
# Usage (Git Bash on Windows, or any bash with the Android SDK + a JDK):
#   build-apk.sh <android-app-dir | app/src/main dir> <output.apk> [versionCode] [versionName]
#
#   e.g.
#   bash build-apk.sh "./android-app" "./Hunt-Mobile.apk" <versionCode above the installed one> <versionName>
#
# versionCode/versionName are optional; when given they REPLACE the values in
# AndroidManifest.xml (aapt2 --replace-version). A versionCode lower than the
# manifest's is refused (a downgrade cannot be installed over the phone's app).
# The source tree is never written:
# all intermediates go to WORK_DIR (default: <output dir>/.build-<output name>).
#
# Environment overrides (all optional):
#   ANDROID_SDK_ROOT / ANDROID_HOME   SDK dir   (default $HOME/AppData/Local/Android/Sdk or $HOME/Android/Sdk)
#   BUILD_TOOLS_VERSION               default 36.1.0 (what built the shipped APK)
#   PLATFORM                          default android-36.1 (shipped APK: compileSdk 36)
#   JAVA_HOME                         default Android Studio's bundled JBR
#   KEYSTORE                          default: <android-app>/app/build/direct-apk/debug.keystore,
#                                     falling back to <this script dir>/keystore/hunt-debug.keystore
#   KS_PASS / KEY_PASS / KEY_ALIAS    default android / android / androiddebugkey
#   EXPECTED_CERT_SHA256              signer cert pin; default = the shipped APK's cert.
#                                     Set to "skip" to disable (NOT recommended: a different
#                                     cert forces an uninstall, which wipes on-phone app data).
#   EXPECTED_PACKAGE                  default com.hunt.companion
#   WORK_DIR                          intermediates dir (wiped and recreated each run)
#   JAVAC_RELEASE                     default 11 (shipped classes are class-file major 55)
#   D8_MODE                           --release (default) or --debug
#   ZIP_TOOL                          auto (default: jar, then python, then zip) | jar | python | zip
# =============================================================================
set -euo pipefail

log()  { printf '\n[build-apk] %s\n' "$*"; }
info() { printf '[build-apk]   %s\n' "$*"; }
die()  { printf '\n[build-apk] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^# ====/p' "$0" | sed 's/^# \{0,1\}//' # the header comment block, banner to banner
  exit "${1:-1}"
}

[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage 0
[ $# -ge 2 ] && [ $# -le 4 ] || usage 1

# -- path helpers --------------------------------------------------------------
# On Git Bash/MSYS we hand every path to native Windows tools in "mixed" form
# (C:/Users/...), and switch off MSYS' automatic argument conversion so nothing
# is rewritten behind our back. On Linux/macOS these are no-ops.
if command -v cygpath >/dev/null 2>&1; then
  IS_WINDOWS=1
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
  wp() { cygpath -m "$1"; }
  EXE=.exe
else
  IS_WINDOWS=0
  wp() { printf '%s' "$1"; }
  EXE=
fi
abspath() { # absolute path of a (possibly not yet existing) file/dir
  local p d b
  p=$(wp "$1")
  d=$(dirname "$p"); b=$(basename "$p")
  mkdir -p "$d"
  printf '%s/%s' "$(cd "$d" && wp "$(pwd)")" "$b"
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && wp "$(pwd)")

# -- arguments -----------------------------------------------------------------
SRC_ARG=$(wp "$1")
[ -d "$SRC_ARG" ] || die "source dir not found: $1"
SRC_ARG=$(cd "$SRC_ARG" && wp "$(pwd)")
if [ -f "$SRC_ARG/AndroidManifest.xml" ]; then
  MAIN_DIR=$SRC_ARG                       # given app/src/main directly
  APP_ROOT=$(cd "$MAIN_DIR/../../.." && wp "$(pwd)")
elif [ -f "$SRC_ARG/app/src/main/AndroidManifest.xml" ]; then
  APP_ROOT=$SRC_ARG                       # given the android-app root
  MAIN_DIR=$SRC_ARG/app/src/main
else
  die "no AndroidManifest.xml in $SRC_ARG or $SRC_ARG/app/src/main"
fi

OUT_APK=$(abspath "$2")
VERSION_CODE=${3:-}
VERSION_NAME=${4:-}
if [ -n "$VERSION_CODE" ]; then
  [[ "$VERSION_CODE" =~ ^[0-9]+$ ]] || die "versionCode must be a positive integer, got '$VERSION_CODE'"
fi

case "$OUT_APK" in
  "$MAIN_DIR"/*) die "refusing to write the output APK inside the source dir ($MAIN_DIR)";;
esac

# -- toolchain -----------------------------------------------------------------
DEFAULT_SDK="${LOCALAPPDATA:+$(wp "$LOCALAPPDATA")/Android/Sdk}"
DEFAULT_SDK="${DEFAULT_SDK:-$HOME/Android/Sdk}"
SDK_DIR=$(wp "${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$DEFAULT_SDK}}")
BUILD_TOOLS_VERSION=${BUILD_TOOLS_VERSION:-36.1.0}
PLATFORM=${PLATFORM:-android-36.1}
BT=$SDK_DIR/build-tools/$BUILD_TOOLS_VERSION
ANDROID_JAR=$SDK_DIR/platforms/$PLATFORM/android.jar

if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$(wp "$JAVA_HOME")/bin/javac$EXE" ]; then
  for cand in "${LOCALAPPDATA:+$(wp "$LOCALAPPDATA")/Programs/Android Studio/jbr}" \
              "/c/Program Files/Android/Android Studio/jbr"; do
    [ -n "$cand" ] && [ -x "$(wp "$cand")/bin/javac$EXE" ] && { JAVA_HOME=$cand; break; }
  done
fi
if [ -n "${JAVA_HOME:-}" ] && [ -x "$(wp "$JAVA_HOME")/bin/javac$EXE" ]; then
  JAVA_HOME=$(wp "$JAVA_HOME")
  JAVA=$JAVA_HOME/bin/java$EXE; JAVAC=$JAVA_HOME/bin/javac$EXE; JAR=$JAVA_HOME/bin/jar$EXE
else
  command -v javac >/dev/null 2>&1 || die "no JDK found (set JAVA_HOME)"
  JAVA=$(command -v java); JAVAC=$(command -v javac); JAR=$(command -v jar || true)
fi
export JAVA_HOME

AAPT2=$BT/aapt2$EXE
ZIPALIGN=$BT/zipalign$EXE
D8_JAR=$BT/lib/d8.jar
APKSIGNER_JAR=$BT/lib/apksigner.jar
for f in "$AAPT2" "$ZIPALIGN" "$D8_JAR" "$APKSIGNER_JAR" "$ANDROID_JAR" "$JAVA" "$JAVAC"; do
  [ -f "$f" ] || die "missing tool/file: $f"
done

# JDK 22+ prints noisy "restricted method" warnings for apksigner's conscrypt;
# silence them when the running JVM understands the flag.
JAVA_NATIVE_FLAG=()
if "$JAVA" --enable-native-access=ALL-UNNAMED -version >/dev/null 2>&1; then
  JAVA_NATIVE_FLAG=(--enable-native-access=ALL-UNNAMED)
fi
d8()        { "$JAVA" -Xmx1024M -Xss1m -cp "$D8_JAR" com.android.tools.r8.D8 "$@"; }
apksigner() { "$JAVA" -Xmx1024M -Xss1m "${JAVA_NATIVE_FLAG[@]}" -jar "$APKSIGNER_JAR" "$@"; }

# -- signing -------------------------------------------------------------------
if [ -z "${KEYSTORE:-}" ]; then
  for cand in "$APP_ROOT/app/build/direct-apk/debug.keystore" \
              "$SCRIPT_DIR/keystore/hunt-debug.keystore"; do
    if [ -f "$cand" ]; then KEYSTORE=$cand; break; fi
  done
fi
[ -n "${KEYSTORE:-}" ] && [ -f "$(wp "$KEYSTORE")" ] || die "signing keystore not found (set KEYSTORE)"
KEYSTORE=$(wp "$KEYSTORE")
KS_PASS=${KS_PASS:-android}
KEY_PASS=${KEY_PASS:-$KS_PASS}
KEY_ALIAS=${KEY_ALIAS:-androiddebugkey}
# SHA-256 of the signer cert of the shipped Hunt-Mobile.apk (CN=Android Debug, O=Android, C=US).
EXPECTED_CERT_SHA256=${EXPECTED_CERT_SHA256:-0d15a3169448449637e71bba9e5e22ed4bd951f78970de42d06fad8def1d111d}
EXPECTED_PACKAGE=${EXPECTED_PACKAGE:-com.hunt.companion}

# -- other settings ------------------------------------------------------------
JAVAC_RELEASE=${JAVAC_RELEASE:-11}
D8_MODE=${D8_MODE:---release}
ZIP_TOOL=${ZIP_TOOL:-auto}
MANIFEST=$MAIN_DIR/AndroidManifest.xml
RES_DIR=$MAIN_DIR/res
ASSETS_DIR=$MAIN_DIR/assets
JAVA_SRC_DIR=$MAIN_DIR/java
MIN_SDK=$(sed -n 's/.*android:minSdkVersion="\([0-9]*\)".*/\1/p' "$MANIFEST" | head -n1)
MIN_SDK=${MIN_SDK:-26}
MANIFEST_VERSION_CODE=$(sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' "$MANIFEST" | head -n1)
if [ -n "$VERSION_CODE" ] && [ -n "$MANIFEST_VERSION_CODE" ]; then
  [ "$VERSION_CODE" -ge "$MANIFEST_VERSION_CODE" ] 2>/dev/null \
    || die "versionCode $VERSION_CODE is lower than the manifest's $MANIFEST_VERSION_CODE (versionCode only goes up)"
fi

[ -d "$RES_DIR" ]    || die "res dir missing: $RES_DIR"
[ -f "$ASSETS_DIR/hunt-mobile.html" ] || die "assets/hunt-mobile.html missing in $ASSETS_DIR"
[ -d "$JAVA_SRC_DIR" ] || die "java dir missing: $JAVA_SRC_DIR"
# The Gradle/Kotlin path was retired (archived): it built an older app (versionCode 1) signed
# with a different key, and "fixing" the signature mismatch by uninstalling wipes phone data.
STALE_BUILD_FILES=$(find "$APP_ROOT" -type f \( -name '*.kt' -o -name '*.gradle.kts' \) | sort)
[ -z "$STALE_BUILD_FILES" ] || die "Kotlin/Gradle files found under $APP_ROOT (only build-apk.sh builds this app):
$STALE_BUILD_FILES"

WORK_DIR=$(wp "${WORK_DIR:-$(dirname "$OUT_APK")/.build-$(basename "$OUT_APK" .apk)}")
# The finished APK is copied next to OUT_APK under this temp name and then renamed over it, so an
# interrupted run (Ctrl+C, full disk) never leaves a truncated APK under the final name. The name
# ends in .apk (git-ignored); the EXIT trap removes a leftover one.
OUT_TMP="$(dirname "$OUT_APK")/.$(basename "$OUT_APK" .apk).partial-$$.apk"
trap 'rm -f "$OUT_TMP"' EXIT
case "$WORK_DIR" in
  "$MAIN_DIR"|"$MAIN_DIR"/*|"$APP_ROOT"|"$APP_ROOT"/app|"$APP_ROOT"/app/src*)
    die "refusing to use WORK_DIR inside the source tree: $WORK_DIR";;
esac
# Only wipe a WORK_DIR this script created (marker file) or an empty/missing one.
if [ -d "$WORK_DIR" ]; then
  if [ -f "$WORK_DIR/.hunt-apk-build" ]; then
    rm -rf "$WORK_DIR"
  elif [ -n "$(ls -A "$WORK_DIR")" ]; then
    die "WORK_DIR exists, is not empty and was not created by this script: $WORK_DIR"
  fi
fi
mkdir -p "$WORK_DIR"/{gen,classes,dex}
touch "$WORK_DIR/.hunt-apk-build"

log "Configuration"
info "sources      : $MAIN_DIR"
info "output       : $OUT_APK"
info "work dir     : $WORK_DIR"
info "build-tools  : $BT"
info "platform     : $ANDROID_JAR"
info "JDK          : $("$JAVA" -version 2>&1 | head -n1)"
info "javac        : --release $JAVAC_RELEASE ; d8: $D8_MODE --min-api $MIN_SDK"
info "keystore     : $KEYSTORE (alias $KEY_ALIAS)"
info "version      : ${VERSION_CODE:-<from manifest>} / ${VERSION_NAME:-<from manifest>}"

# -- 1. compile resources -------------------------------------------------------
log "1/8 aapt2 compile"
"$AAPT2" compile --dir "$RES_DIR" -o "$WORK_DIR/resources.zip"

# -- 2. link: manifest + resources + assets -> unaligned.apk (+ R.java) ---------
log "2/8 aapt2 link"
LINK_ARGS=(link -o "$WORK_DIR/unaligned.apk"
           -I "$ANDROID_JAR"
           --manifest "$MANIFEST"
           --java "$WORK_DIR/gen"
           -A "$ASSETS_DIR")
if [ -n "$VERSION_CODE" ] || [ -n "$VERSION_NAME" ]; then
  [ -n "$VERSION_CODE" ] && LINK_ARGS+=(--version-code "$VERSION_CODE")
  [ -n "$VERSION_NAME" ] && LINK_ARGS+=(--version-name "$VERSION_NAME")
  LINK_ARGS+=(--replace-version)
fi
LINK_ARGS+=("$WORK_DIR/resources.zip")
"$AAPT2" "${LINK_ARGS[@]}"
[ -f "$WORK_DIR/unaligned.apk" ] || die "aapt2 link produced no APK"

# -- 3. javac -------------------------------------------------------------------
log "3/8 javac"
mapfile -t JAVA_SOURCES < <(find "$JAVA_SRC_DIR" "$WORK_DIR/gen" -type f -name '*.java' | sort)
[ ${#JAVA_SOURCES[@]} -ge 2 ] || die "expected the app sources + R.java, found: ${JAVA_SOURCES[*]:-none}"
for s in "${JAVA_SOURCES[@]}"; do info "compile $s"; done
"$JAVAC" --release "$JAVAC_RELEASE" -encoding UTF-8 -Xlint:-options -g \
  -classpath "$ANDROID_JAR" -d "$WORK_DIR/classes" "${JAVA_SOURCES[@]}"

# -- 4. d8 ----------------------------------------------------------------------
log "4/8 d8"
mapfile -t CLASS_FILES < <(cd "$WORK_DIR/classes" && find . -type f -name '*.class' | sort)
[ ${#CLASS_FILES[@]} -gt 0 ] || die "javac produced no class files"
( cd "$WORK_DIR/classes" && d8 "$D8_MODE" --min-api "$MIN_SDK" --lib "$ANDROID_JAR" \
      --output "$WORK_DIR/dex" "${CLASS_FILES[@]}" )
[ -f "$WORK_DIR/dex/classes.dex" ] || die "d8 produced no classes.dex"
[ -z "$(find "$WORK_DIR/dex" -name 'classes2.dex')" ] || die "multidex output not handled by this script"
info "classes.dex: $(wc -c < "$WORK_DIR/dex/classes.dex") bytes"

# -- 5. add classes.dex at the APK root -----------------------------------------
log "5/8 add classes.dex to APK"
PYTHON=$(command -v python3 || command -v python || true)
ZIP=$(command -v zip || true)
add_dex() {
  case "$1" in
    jar)    [ -n "$JAR" ] && [ -f "$JAR" ] || return 2
            ( cd "$WORK_DIR/dex" && "$JAR" --update --no-manifest --file "$WORK_DIR/unaligned.apk" classes.dex ) ;;
    python) [ -n "$PYTHON" ] || return 2
            "$PYTHON" -I -c 'import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "a", zipfile.ZIP_DEFLATED) as z:
    z.write(sys.argv[2], "classes.dex")' "$WORK_DIR/unaligned.apk" "$WORK_DIR/dex/classes.dex" ;;
    zip)    [ -n "$ZIP" ] || return 2
            ( cd "$WORK_DIR/dex" && "$ZIP" -q -X "$WORK_DIR/unaligned.apk" classes.dex ) ;;
    *)      die "unknown ZIP_TOOL '$1'";;
  esac
}
if [ "$ZIP_TOOL" = auto ]; then
  ok=0
  for t in jar python zip; do
    if add_dex "$t"; then info "added with: $t"; ok=1; break; fi
  done
  [ $ok = 1 ] || die "no tool to add classes.dex (need JDK jar, python or zip)"
else
  add_dex "$ZIP_TOOL" || die "ZIP_TOOL=$ZIP_TOOL failed or is unavailable"
  info "added with: $ZIP_TOOL"
fi

# Sanity: classes.dex, hunt-mobile.html and the Day Widget resources present; resources.arsc must stay STORED
# (Android 11+ refuses targetSdk>=30 APKs with a compressed resources.arsc).
list_entries() {
  if command -v unzip >/dev/null 2>&1; then unzip -Z1 "$1"
  elif [ -n "$JAR" ]; then "$JAR" --list --file "$1"
  else "$PYTHON" -I -c 'import sys,zipfile;print("\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))' "$1"; fi
}
ENTRIES=$(list_entries "$WORK_DIR/unaligned.apk" | tr -d '\r')
for e in AndroidManifest.xml resources.arsc classes.dex assets/hunt-mobile.html res/xml/day_widget_info.xml res/layout/widget_day_neon.xml res/layout/widget_day_row_neon.xml; do
  grep -qx "$e" <<<"$ENTRIES" || die "APK is missing $e"
done
if command -v unzip >/dev/null 2>&1; then
  unzip -v "$WORK_DIR/unaligned.apk" | grep -E ' resources\.arsc$' | grep -q ' Stored ' \
    || die "resources.arsc got compressed (must be stored)"
elif [ -n "$PYTHON" ]; then
  "$PYTHON" -I -c 'import sys,zipfile; sys.exit(zipfile.ZipFile(sys.argv[1]).getinfo("resources.arsc").compress_type!=0)' \
    "$WORK_DIR/unaligned.apk" || die "resources.arsc got compressed (must be stored)"
fi

# -- 6. zipalign ----------------------------------------------------------------
log "6/8 zipalign"
"$ZIPALIGN" -p -f 4 "$WORK_DIR/unaligned.apk" "$WORK_DIR/aligned.apk"
"$ZIPALIGN" -c -p 4 "$WORK_DIR/aligned.apk" >/dev/null || die "zipalign check failed"

# -- 7. sign --------------------------------------------------------------------
log "7/8 apksigner sign"
apksigner sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KEY_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --v4-signing-enabled false \
  --out "$WORK_DIR/signed.apk" "$WORK_DIR/aligned.apk"

# -- 8. verify ------------------------------------------------------------------
log "8/8 verify"
VERIFY_OUT=$(apksigner verify --verbose --print-certs "$WORK_DIR/signed.apk" 2>&1 | tr -d '\r') \
  || { printf '%s\n' "$VERIFY_OUT" >&2; die "apksigner verify failed"; }
printf '%s\n' "$VERIFY_OUT" | grep -E '^(Verifies|Verified using v[123] |Number of signers|.*[Ss]igner.*certificate (DN|SHA-256))' | sed 's/^/[build-apk]   /'
grep -qx 'Verifies' <<<"$VERIFY_OUT" || die "apksigner verify did not report 'Verifies'"
# apksigner prints "Signer #1 certificate SHA-256 digest: ..." and/or per-scheme
# "V3.0 Signer: certificate SHA-256 digest: ..." lines depending on version; all must agree.
CERT_DIGESTS=$(printf '%s\n' "$VERIFY_OUT" | sed -n 's/.*[Ss]igner.*certificate SHA-256 digest: \([0-9a-f]\{64\}\).*/\1/p' | sort -u)
[ -n "$CERT_DIGESTS" ] || die "could not read signer certificate from apksigner output"
[ "$(printf '%s\n' "$CERT_DIGESTS" | wc -l)" -eq 1 ] || die "multiple signer certificates found: $CERT_DIGESTS"
CERT_SHA256=$CERT_DIGESTS
if [ "$EXPECTED_CERT_SHA256" != skip ]; then
  [ "$CERT_SHA256" = "$EXPECTED_CERT_SHA256" ] || die "signer cert $CERT_SHA256 != expected $EXPECTED_CERT_SHA256
  -> installing this APK over the existing app would FAIL (INSTALL_FAILED_UPDATE_INCOMPATIBLE);
     uninstalling first would WIPE the app's on-phone data. Use the original keystore."
  info "signer cert matches the shipped APK: $CERT_SHA256"
fi

BADGING=$("$AAPT2" dump badging "$WORK_DIR/signed.apk" | tr -d '\r')
PKG_LINE=$(printf '%s\n' "$BADGING" | head -n1)
info "$PKG_LINE"
printf '%s\n' "$BADGING" | grep -E '^(minSdkVersion|targetSdkVersion|launchable-activity|uses-permission)' | sed 's/^/[build-apk]   /'
PKG=$(printf '%s\n' "$PKG_LINE" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
[ "$PKG" = "$EXPECTED_PACKAGE" ] || die "package is '$PKG', expected '$EXPECTED_PACKAGE'"
if [ -n "$VERSION_CODE" ]; then
  grep -q "versionCode='$VERSION_CODE'" <<<"$PKG_LINE" || die "versionCode $VERSION_CODE was not applied"
fi
if [ -n "$VERSION_NAME" ]; then
  grep -qF "versionName='$VERSION_NAME'" <<<"$PKG_LINE" || die "versionName $VERSION_NAME was not applied"
fi
if grep -q 'ACCESS_WIFI_STATE' <<<"$BADGING"; then
  die "the APK requests ACCESS_WIFI_STATE, which the app does not use (remove it from the manifest)"
fi

# The packaged HTML must be byte-identical to the source asset.
if command -v unzip >/dev/null 2>&1; then
  unzip -p "$WORK_DIR/signed.apk" assets/hunt-mobile.html > "$WORK_DIR/packaged-hunt-mobile.html"
else
  ( mkdir -p "$WORK_DIR/x" && cd "$WORK_DIR/x" && "$JAR" --extract --file "$WORK_DIR/signed.apk" assets/hunt-mobile.html \
    && mv assets/hunt-mobile.html "$WORK_DIR/packaged-hunt-mobile.html" )
fi
cmp -s "$WORK_DIR/packaged-hunt-mobile.html" "$ASSETS_DIR/hunt-mobile.html" \
  || die "assets/hunt-mobile.html inside the APK differs from $ASSETS_DIR/hunt-mobile.html"
info "assets/hunt-mobile.html packaged ($(wc -c < "$ASSETS_DIR/hunt-mobile.html") bytes, identical to source)"
# The browser copy served by the laptop must be the same page.
PUBLIC_HTML=$APP_ROOT/../public/hunt-mobile.html
if [ -f "$PUBLIC_HTML" ]; then
  cmp -s "$WORK_DIR/packaged-hunt-mobile.html" "$PUBLIC_HTML" \
    || die "public/hunt-mobile.html differs from the asset; copy it first"
  info "public/hunt-mobile.html is identical to the asset"
fi

# Secret scan: the laptop's sync key must never ship in the APK. The patterns come from the
# key file through a pipe (BOM, CR and surrounding blanks stripped, blank lines dropped), so the
# key is never printed, stored in a variable or passed on a command line. The appended newline
# terminates the last line: the server writes the key without one, and `wc -l` would count 0.
# Fail closed: an unreadable key file or scan target stops the build.
KEY_FILE=$APP_ROOT/../data/hunt-sync.key
key_patterns() {
  { tr -d '\r' < "$KEY_FILE"; printf '\n'; } \
    | LC_ALL=C sed -e '1s/^\xEF\xBB\xBF//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d'
}
if [ -f "$KEY_FILE" ]; then
  [ -r "$KEY_FILE" ] || die "cannot read data/hunt-sync.key for the secret scan"
  if [ "$(key_patterns | wc -l)" -eq 0 ]; then
    info "secret scan skipped: the key file is empty"
  else
    for f in "$WORK_DIR/dex/classes.dex" "$WORK_DIR/packaged-hunt-mobile.html"; do
      rc=0
      grep -aqF -f <(key_patterns) "$f" || rc=$?
      [ "$rc" -ne 0 ] \
        || die "the sync key from data/hunt-sync.key is embedded in $(basename "$f"); remove it from the sources (key not shown)"
      [ "$rc" -eq 1 ] || die "secret scan could not read $(basename "$f")"
    done
    info "secret scan: the sync key is not in classes.dex or the packaged HTML"
  fi
fi

cp -f "$WORK_DIR/signed.apk" "$OUT_TMP"
mv -f "$OUT_TMP" "$OUT_APK"
log "OK -> $OUT_APK ($(wc -c < "$OUT_APK") bytes)"
info "install WITHOUT losing app data:  adb install -r \"$OUT_APK\""
info "(never 'adb uninstall' first; keep versionCode >= the installed one, else INSTALL_FAILED_VERSION_DOWNGRADE)"
