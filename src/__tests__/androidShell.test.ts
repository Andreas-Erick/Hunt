// @vitest-environment node
//
// Static guards for the Android shell (android-app/). The Java code cannot run under vitest, so
// these tests read the sources and check the security-relevant invariants: no compiled-in key,
// a write-only Keystore-encrypted token, the WebView allowlist and least-privilege settings, the
// bridge contract the page relies on, backup exclusion, and build hygiene.
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { hasJdk, runJavaProbe } from "./helpers/javaProbe";

const ROOT = path.resolve(__dirname, "..", "..");
const APP = path.join(ROOT, "android-app");
const MAIN = path.join(APP, "app", "src", "main");
const JAVA_FILE = path.join(MAIN, "java", "com", "hunt", "companion", "MainActivity.java");
const MANIFEST_FILE = path.join(MAIN, "AndroidManifest.xml");
const BACKUP_RULES_FILE = path.join(MAIN, "res", "xml", "backup_rules.xml");
const EXTRACTION_RULES_FILE = path.join(MAIN, "res", "xml", "data_extraction_rules.xml");
const ASSET_PAGE_FILE = path.join(MAIN, "assets", "hunt-mobile.html");
const BUILD_SCRIPT_FILE = path.join(APP, "build-apk.sh");
const TOKEN_FILE_NAME = "hunt-sync-token.txt";

const read = (file: string): string => fs.readFileSync(file, "utf8");

/** Index just past a Java string/char literal starting at `start` (escapes honoured). */
function skipLiteral(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote) i += src[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** Java source with comments blanked out (string and char literals kept): code-only checks. */
function stripJavaComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
    } else if (c === '"' || c === "'") {
      const end = skipLiteral(src, i);
      out += src.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The `{...}` block that follows the first match of `header` (braces in literals ignored). */
function blockAfter(code: string, header: RegExp): string {
  const m = header.exec(code);
  if (!m) throw new Error(`not found in MainActivity.java: ${header}`);
  const open = code.indexOf("{", m.index + m[0].length - 1);
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      i = skipLiteral(code, i);
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return code.slice(open, i + 1);
    i++;
  }
  throw new Error(`unbalanced block after ${header}`);
}

/** Decodes the Java string literal assigned to `name` (e.g. SYNC_TOKEN_RE's pattern). */
function javaStringConstant(code: string, name: string, wrapper = ""): string {
  const re = new RegExp(`${name}\\s*=\\s*${wrapper ? `${wrapper}\\(` : ""}"((?:[^"\\\\]|\\\\.)*)"`);
  const m = re.exec(code);
  if (!m) throw new Error(`constant ${name} not found`);
  return m[1].replace(/\\(.)/g, "$1");
}

/** For every match of the global `re`: the requested capture groups, in order. */
function captures(text: string, re: RegExp, ...groups: number[]): string[][] {
  return Array.from(text.matchAll(re), (m) => groups.map((g) => m[g]));
}

/** The first capture group of every match of the global `re`. */
function firstCaptures(text: string, re: RegExp): string[] {
  return captures(text, re, 1).map(([value]) => value);
}

function walkFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

const javaSource = read(JAVA_FILE);
const javaCode = stripJavaComments(javaSource);
const manifest = read(MANIFEST_FILE);

/** Pairing-token boundary matrix (spec 2.8): [token, valid under ^[\x21-\x7E]{32,256}$]. */
const TOKEN_CASES: Array<[string, boolean]> = [
  ["", false],
  ["   ", false],
  ["a".repeat(31), false],
  ["a".repeat(32), true],
  ["f".repeat(64), true],
  ["~".repeat(256), true],
  ["!".repeat(257), false],
  ["a".repeat(10_000), false],
  [`${"a".repeat(16)} ${"a".repeat(16)}`, false],
  [`${"a".repeat(40)}\n`, false],
  [`${"a".repeat(40)}\r`, false],
  [`${"a".repeat(40)}\0`, false],
  [`${"a".repeat(31)}é`, false],
  [`${"a".repeat(30)}👨‍👩‍👧‍👦`, false],
  [`${"a".repeat(30)}مرحبا`, false],
  ["' OR 1=1 --".padEnd(40, "x"), false],
];

/** name -> return type of every method exposed to JS on window.AndroidBridge. */
function bridgeMethods(): Map<string, string> {
  const body = blockAfter(javaCode, /public\s+final\s+class\s+AndroidNativeBridge\s*\{/);
  const methods = new Map<string, string>();
  for (const [name, returnType] of captures(body, /@JavascriptInterface\s+public\s+(\w+)\s+(\w+)\s*\(/g, 2, 1)) {
    methods.set(name, returnType);
  }
  return methods;
}

describe("MainActivity.java: secret hygiene and token storage", () => {
  it("contains no 64-hex literal (the old compiled-in sync key) anywhere, comments included", () => {
    expect(javaSource).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(javaCode).not.toMatch(/DEFAULT_SYNC_TOKEN/);
  });

  it("encrypts the token with an AndroidKeyStore AES-256-GCM key in a 'v2:' envelope", () => {
    expect(javaCode).toContain('"AndroidKeyStore"');
    expect(javaCode).toContain('"AES/GCM/NoPadding"');
    expect(javaStringConstant(javaCode, "TOKEN_ENVELOPE_PREFIX")).toBe("v2:");
    const keyGen = blockAfter(javaCode, /SecretKey\s+tokenKey\(boolean\s+create\)[^{]*\{/);
    expect(keyGen).toMatch(/PURPOSE_ENCRYPT\s*\|\s*KeyProperties\.PURPOSE_DECRYPT/);
    expect(keyGen).toContain("BLOCK_MODE_GCM");
    expect(keyGen).toContain("ENCRYPTION_PADDING_NONE");
    expect(javaCode).toMatch(/TOKEN_KEY_BITS\s*=\s*256\s*;/);
    // Persisted only through the encrypted envelope, never the plain token.
    const persist = blockAfter(javaCode, /private\s+void\s+persistSyncToken\(\)\s*\{/);
    expect(persist).toMatch(/envelope\s*=\s*encryptToken\(token\)/);
    // An older token finishing its encryption late must never overwrite a newer one.
    expect(persist).toMatch(
      /synchronized\s*\(HuntFiles\.LOCK\)\s*\{\s*if\s*\(\s*!token\.equals\(syncTokenCache\.get\(\)\)\s*\)\s*return;\s*writeConfigFile\(SYNC_TOKEN_FILE,\s*envelope\);/,
    );
    expect(javaCode.match(/writeConfigFile\(SYNC_TOKEN_FILE,[^)]*\)/g)).toEqual([
      "writeConfigFile(SYNC_TOKEN_FILE, envelope)",
    ]);
  });

  it("decryption failures are treated as 'not paired', never thrown", () => {
    const decrypt = blockAfter(javaCode, /private\s+static\s+String\s+decryptToken\(String\s+envelope\)\s*\{/);
    expect(decrypt).toMatch(/catch\s*\(\s*GeneralSecurityException\s*\|\s*IOException\s*\|\s*RuntimeException\s+e\s*\)/);
    expect(decrypt).toMatch(/return\s+"";\s*\}\s*\}$/);
  });

  it("the native token rule matches the pairing contract ^[\\x21-\\x7E]{32,256}$ (boundary matrix)", () => {
    const pattern = javaStringConstant(javaCode, "SYNC_TOKEN_RE", "Pattern\\.compile");
    expect(pattern).toBe("^[\\x21-\\x7E]{32,256}$");
    const rule = new RegExp(pattern);
    for (const [token, valid] of TOKEN_CASES) {
      expect(rule.test(token), `token of length ${token.length}`).toBe(valid);
    }
  });

  it("validates a token before it is cached or persisted (saved and loaded alike)", () => {
    const save = blockAfter(javaCode, /private\s+boolean\s+saveSyncTokenInternal\(String\s+token\)\s*\{/);
    const reject = save.search(/if\s*\(\s*!isValidSyncToken\(clean\)\s*\)\s*\{[^}]*return\s+false;\s*\}/);
    expect(reject).toBeGreaterThan(-1);
    expect(save.indexOf("syncTokenCache.set(clean)")).toBeGreaterThan(reject);
    const load = blockAfter(javaCode, /private\s+String\s+syncToken\(\)\s*\{/);
    const check = load.search(/if\s*\(\s*!isValidSyncToken\(loaded\)\s*\)\s*\{[^}]*loaded\s*=\s*"";/);
    expect(check).toBeGreaterThan(-1);
    expect(load.indexOf("syncTokenCache.compareAndSet(null, loaded)")).toBeGreaterThan(check);
  });

  it("runSync answers 'auth' without any network I/O when no token is saved", () => {
    const runSync = blockAfter(javaCode, /private\s+JSONObject\s+runSync\([^)]*\)\s*\{/);
    const authAt = runSync.search(/if\s*\(\s*token\.isEmpty\(\)\s*\)\s*\{\s*return\s+syncResult\(requestId,\s*false,\s*"auth"/);
    expect(authAt).toBeGreaterThan(-1);
    expect(runSync.indexOf("syncToken()")).toBeLessThan(authAt);
    for (const io of ["hasActiveNetwork(", "anyVpnNetwork(", "postOnce("]) {
      expect(runSync.indexOf(io), io).toBeGreaterThan(authAt);
    }
  });

  it("never logs a token value", () => {
    const logCalls = javaCode.match(/Log\.[dwiev]\([^;]*;/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/\+\s*(token|clean|stored|loaded|envelope|syncTokenCache)\b/);
    }
  });
});

describe("MainActivity.java: WebView isolation", () => {
  it("overrides shouldOverrideUrlLoading and shouldInterceptRequest with the request-based signatures", () => {
    const client = blockAfter(javaCode, /private\s+final\s+class\s+HuntWebViewClient\s+extends\s+WebViewClient\s*\{/);
    expect(client).toMatch(/@Override\s+public\s+boolean\s+shouldOverrideUrlLoading\(WebView\s+\w+,\s*WebResourceRequest\s+\w+\)/);
    expect(client).toMatch(/@Override\s+public\s+WebResourceResponse\s+shouldInterceptRequest\(WebView\s+\w+,\s*WebResourceRequest\s+\w+\)/);
    expect(client).toMatch(/new\s+WebResourceResponse\("text\/plain",\s*"utf-8",\s*403,/);
    // Each override defers to its helper, which the JDK suite below runs against bypass attempts.
    expect(client).toMatch(/if\s*\(\s*uri\s*!=\s*null\s*&&\s*isPageUrl\(uri\.toString\(\)\)\s*\)\s*return\s+false;/);
    expect(client).toMatch(/if\s*\(\s*uri\s*!=\s*null\s*&&\s*isAllowedRequest\(uri\.toString\(\)\)\s*\)\s*return\s+null;/);
  });

  it("keeps the page on file:///android_asset (localStorage origin unchanged) and allowlists only fonts", () => {
    expect(javaStringConstant(javaCode, "PAGE_URL")).toBe("file:///android_asset/hunt-mobile.html");
    expect(javaStringConstant(javaCode, "ASSET_URL_PREFIX")).toBe("file:///android_asset/");
    const fonts = /FONT_URL_PREFIXES\s*=\s*\{([^}]*)\}/.exec(javaCode);
    expect(fonts).not.toBeNull();
    const hosts = firstCaptures(fonts?.[1] ?? "", /"([^"]*)"/g);
    expect(hosts).toEqual(["https://fonts.googleapis.com/", "https://fonts.gstatic.com/"]);
  });

  it("uses least-privilege WebView settings", () => {
    expect(javaCode).not.toMatch(/setAllowFileAccess\(\s*true\s*\)/);
    expect(javaCode).not.toMatch(/setAllowContentAccess\(\s*true\s*\)/);
    expect(javaCode).not.toContain("MIXED_CONTENT_ALWAYS_ALLOW");
    expect(javaCode).not.toContain("MIXED_CONTENT_COMPATIBILITY_MODE");
    expect(javaCode).not.toContain("setDatabaseEnabled");
    expect(javaCode).not.toMatch(/setAllow(Universal|File)AccessFromFileURLs\(\s*true\s*\)/);
    expect(javaCode).toMatch(/setAllowFileAccess\(\s*false\s*\)/);
    expect(javaCode).toMatch(/setAllowContentAccess\(\s*false\s*\)/);
    expect(javaCode).toContain("MIXED_CONTENT_NEVER_ALLOW");
  });
});

describe("MainActivity.java: bridge contract with hunt-mobile.html", () => {
  it("exposes exactly the contract methods with their return types", () => {
    expect(Object.fromEntries(bridgeMethods())).toEqual({
      loadState: "String",
      saveState: "void",
      saveCorruptState: "boolean",
      getLaptopUrl: "String",
      saveLaptopUrl: "void",
      saveSyncToken: "boolean",
      syncWithLaptopAsync: "boolean",
      setKeepScreenOn: "void",
      vibrateClick: "void",
      getAppVersion: "String",
      saveWidgetSnapshot: "void",
      readPendingTicks: "String",
      ackPendingTicks: "void",
      saveReminderPlan: "void",
      getReminderPermissions: "String",
      readReminderSnoozes: "String",
      requestReminderPermissions: "void",
    });
    // Nothing outside the bridge class is exposed to JS.
    expect(javaCode.match(/@JavascriptInterface/g)).toHaveLength(bridgeMethods().size);
  });

  it("no longer declares getSyncToken or isNetworkAvailable", () => {
    expect(javaCode).not.toMatch(/\bgetSyncToken\s*\(/);
    expect(javaCode).not.toMatch(/\bisNetworkAvailable\s*\(/);
  });

  it("the packaged page only calls bridge methods the shell exposes", () => {
    const page = read(ASSET_PAGE_FILE);
    const called = firstCaptures(page, /bridgeCall\(\s*"(\w+)"/g).concat(
      firstCaptures(page, /AndroidBridge\.(\w+)\s*\(/g),
    );
    expect(called.length).toBeGreaterThan(0);
    const exposed = bridgeMethods();
    for (const name of called) expect(exposed.has(name), `page calls AndroidBridge.${name}`).toBe(true);
  });

  it("saveState ignores input that is not shaped like a JSON object", () => {
    const save = blockAfter(javaCode, /private\s+void\s+saveStateInternal\(String\s+json\)\s*\{/);
    expect(save).toMatch(/^\{\s*if\s*\(\s*!looksLikeJsonObject\(json\)\s*\)\s*\{[^}]*return;\s*\}/);
    const guard = blockAfter(javaCode, /private\s+static\s+boolean\s+looksLikeJsonObject\(String\s+s\)\s*\{/);
    expect(guard).toContain("Character.isWhitespace");
    expect(guard).toMatch(/charAt\(start\)\s*==\s*'\{'/);
    expect(guard).toMatch(/charAt\(end\)\s*==\s*'\}'/);
  });

  it("saveLaptopUrl ignores non-empty values that are not http(s) URLs", () => {
    const save = blockAfter(javaCode, /private\s+void\s+saveLaptopUrlInternal\(String\s+url\)\s*\{/);
    const guardAt = save.search(/if\s*\(\s*!clean\.isEmpty\(\)\s*&&\s*!isHttpUrl\(clean\)\s*\)\s*\{[^}]*return;/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(save.indexOf("laptopUrlCache = clean")).toBeGreaterThan(guardAt);
  });
});

describe("AndroidManifest.xml and backup rules", () => {
  it("requests exactly INTERNET, ACCESS_NETWORK_STATE, VIBRATE and the three reminder permissions (ADR-0007)", () => {
    const permissions = firstCaptures(manifest, /<uses-permission\s+android:name="([^"]+)"/g).sort();
    expect(permissions).toEqual([
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.INTERNET",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.RECEIVE_BOOT_COMPLETED",
      "android.permission.SCHEDULE_EXACT_ALARM",
      "android.permission.VIBRATE",
    ]);
  });

  it("is versionCode >= 28 (1.17.0) so it installs over the shipped 1.16.1 (27)", () => {
    const code = Number(/android:versionCode="(\d+)"/.exec(manifest)?.[1]);
    expect(code).toBeGreaterThanOrEqual(28);
    expect(/android:versionName="([^"]+)"/.exec(manifest)?.[1]).toBe("1.17.0");
  });

  it("declares tablet screen support and multi-window resizeability", () => {
    expect(manifest).toMatch(/<supports-screens[\s\S]*?android:largeScreens="true"/);
    expect(manifest).toMatch(/<supports-screens[\s\S]*?android:xlargeScreens="true"/);
    expect(manifest).toMatch(/android:resizeableActivity="true"/);
    expect(manifest).toMatch(/android:launchMode="singleTask"/);
    expect(manifest).toMatch(/android:scheme="hunt"[\s\S]*?android:host="pair"/);
    expect(javaCode).toContain("handlePairingIntent");
    expect(javaCode).toContain("isAllowedSyncRouteUrl");
  });

  it("handles API 30+ system bars & IME via a padded FrameLayout container without panning WebView or jumping on Samsung IME bars", () => {
    expect(javaCode).toContain("FrameLayout container = new FrameLayout(this)");
    expect(javaCode).toContain("installSmoothImeInsets(container)");
    expect(javaCode).toContain("setDecorFitsSystemWindows(false)");
    expect(javaCode).toContain("WindowInsetsAnimation.Callback");
    expect(javaCode).toContain("onPrepare(WindowInsetsAnimation");
    expect(javaCode).toContain("imeAnimationDepth");
    expect(javaCode).toContain("HuntSmoothIme/1");
    expect(javaCode).toContain("getFocusedRect(Rect");
    expect(javaCode).toContain("WindowInsets.CONSUMED");
    expect(javaCode).toContain("__huntSetIme");
  });

  it("declares both backup rule files, and they exist", () => {
    expect(manifest).toMatch(/android:fullBackupContent="@xml\/backup_rules"/);
    expect(manifest).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
    expect(fs.existsSync(BACKUP_RULES_FILE)).toBe(true);
    expect(fs.existsSync(EXTRACTION_RULES_FILE)).toBe(true);
  });

  // The state file must stay in backups and transfers (it is the phone's only data copy).
  const STATE_EXCLUDE_RE = /<exclude\b[^>]*hunt-mobile-state\.json/;
  const excludesToken = (xml: string): boolean =>
    new RegExp(`<exclude\\s+domain="file"\\s+path="${TOKEN_FILE_NAME.replace(/\./g, "\\.")}"\\s*/>`).test(xml);

  it("backup_rules.xml excludes the token file and still backs up everything else", () => {
    const xml = read(BACKUP_RULES_FILE);
    expect(xml).toMatch(/<full-backup-content>/);
    expect(excludesToken(xml)).toBe(true);
    expect(xml).not.toMatch(/<include\b/); // an include would switch to allowlist mode
    expect(xml).not.toMatch(STATE_EXCLUDE_RE);
  });

  it("data_extraction_rules.xml excludes the token file from cloud backup AND device transfer", () => {
    const xml = read(EXTRACTION_RULES_FILE);
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = new RegExp(`<${section}\\b[^>]*>([\\s\\S]*?)</${section}>`).exec(xml)?.[1];
      expect(body, section).toBeDefined();
      expect(excludesToken(body ?? ""), section).toBe(true);
      expect(body ?? "", section).not.toMatch(/<include\b/);
    }
    expect(xml).not.toMatch(STATE_EXCLUDE_RE);
  });
});

describe("build hygiene", () => {
  it("has no *.kt or *.gradle.kts file anywhere under android-app", () => {
    const stale = walkFiles(APP).filter((f) => f.endsWith(".kt") || f.endsWith(".gradle.kts"));
    expect(stale).toEqual([]);
  });

  it("keeps the pinned signing keystore out of git, and release CI requires it from a secret", () => {
    const gitignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain("android-app/keystore/");
    const script = fs.readFileSync(path.join(APP, "build-apk.sh"), "utf8");
    expect(script).toContain('"$SCRIPT_DIR/keystore/hunt-debug.keystore"');
    const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
    expect(release).not.toContain("keystore=android-app/keystore/hunt-debug.keystore");
    expect(release).toContain("cert_pin=0d15a3169448449637e71bba9e5e22ed4bd951f78970de42d06fad8def1d111d");
    expect(release).not.toContain("cert_pin=skip");
  });

  const ARCHIVE_DIR = path.join(ROOT, "_archive", "pre-audit-2026-11-18");
  it.skipIf(!fs.existsSync(ARCHIVE_DIR))(
    "archives (never deletes) the retired Gradle/Kotlin files and public artifacts",
    () => {
      for (const rel of [
        "android-app/app/src/main/java/com/hunt/companion/MainActivity.kt",
        "android-app/app/build.gradle.kts",
        "android-app/build.gradle.kts",
        "android-app/settings.gradle.kts",
        "android-app/gradle.properties",
        "android-app/gradle/wrapper/gradle-wrapper.properties",
        "public/Hunt-Mobile.apk.bak",
        "public/Hunt-Mobile.apk.idsig",
        "public/sw.js",
      ]) {
        expect(fs.existsSync(path.join(ARCHIVE_DIR, rel)), rel).toBe(true);
      }
    }
  );

  it("public/ serves only the APK, the favicon, the logo, the phone page and the reminder worker", () => {
    const files = fs.readdirSync(path.join(ROOT, "public")).sort();
    const required = ["favicon.ico", "hunt-logo.png", "hunt-mobile.html", "hunt-reminder-sw.js"];
    const allowed = new Set([...required, "Hunt-Mobile.apk"]);
    for (const file of required) expect(files).toContain(file);
    for (const file of files) expect(allowed.has(file), `unexpected file in public/: ${file}`).toBe(true);
    // The desktop's notification buttons need a service worker (ADR-0007). It must never cache or
    // answer requests: a caching worker serves a stale app after an update.
    const worker = fs.readFileSync(path.join(ROOT, "public", "hunt-reminder-sw.js"), "utf8").replace(/\/\/[^\n]*/g, "");
    expect(worker).toMatch(/addEventListener\("notificationclick"/);
    expect(worker).not.toMatch(/"fetch"|\bcaches\b|importScripts/);
  });

  it("build-apk.sh refuses stale build files, downgrades, a stale public copy, Wi-Fi permission and an embedded key", () => {
    const script = read(BUILD_SCRIPT_FILE);
    expect(script).toMatch(/find "\$APP_ROOT" -type f \\\( -name '\*\.kt' -o -name '\*\.gradle\.kts' \\\)/);
    expect(script).not.toMatch(/ignoring \$KT_FILES Kotlin/);
    expect(script).toMatch(/\[ "\$VERSION_CODE" -ge "\$MANIFEST_VERSION_CODE" \]/);
    expect(script).toContain("public/hunt-mobile.html differs from the asset; copy it first");
    expect(script).toMatch(/grep -q 'ACCESS_WIFI_STATE' <<<"\$BADGING"/);
    expect(script).toMatch(/KEY_FILE=\$APP_ROOT\/\.\.\/data\/hunt-sync\.key/);
    expect(script).toMatch(/grep -aqF -f <\(key_patterns\)/);
    expect(script).not.toMatch(/(echo|printf|info|log|die)[^\n]*\$\(\s*(cat|key_patterns)\b/);
    expect(script).toContain("<versionCode above the installed one> <versionName>");
  });
});

describe("Day Widget (ADR-0006)", () => {
  const JAVA_DIR = path.dirname(JAVA_FILE);
  const RES = path.join(MAIN, "res");
  const widgetJava = fs
    .readdirSync(JAVA_DIR)
    .filter((f) => f.endsWith(".java") && f !== "MainActivity.java")
    .map((f) => ({ name: f, code: stripJavaComments(read(path.join(JAVA_DIR, f))) }));
  // Every widget class: the Widget* files plus the Day Widget's helpers named after what they hold.
  const widgetSources = widgetJava.filter((f) => /Widget/.test(f.name));
  const widgetHelpers = widgetJava.filter((f) => ["DayNav.java", "DaySelection.java", "SelectedDay.java", "UndoWindow.java", "TickKeys.java"].includes(f.name));
  const widgetLayouts = fs
    .readdirSync(path.join(RES, "layout"))
    .filter((f) => f.startsWith("widget_"))
    .map((f) => ({ name: f, xml: read(path.join(RES, "layout", f)) }));

  it("declares the widget receiver and its list service, neither exported", () => {
    const receiver = /<receiver\b[^>]*android:name="\.DayWidgetProvider"[^>]*>([\s\S]*?)<\/receiver>/.exec(manifest);
    expect(receiver, "DayWidgetProvider receiver").not.toBeNull();
    expect(receiver![0]).toMatch(/android:exported="false"/);
    expect(receiver![1]).toContain('<action android:name="android.appwidget.action.APPWIDGET_UPDATE" />');
    expect(receiver![1]).toMatch(
      /<meta-data\s+android:name="android\.appwidget\.provider"\s+android:resource="@xml\/day_widget_info"/,
    );
    const service = /<service\b[^>]*android:name="\.DayWidgetService"[^>]*>/.exec(manifest)?.[0] ?? "";
    expect(service).toMatch(/android:exported="false"/);
    expect(service).toMatch(/android:permission="android\.permission\.BIND_REMOTEVIEWS"/);
    expect(fs.existsSync(path.join(RES, "xml", "day_widget_info.xml"))).toBe(true);
  });

  it("the widget code never writes a file except appending a Pending Tick; only the bridge saves the snapshot", () => {
    expect(widgetSources.map((f) => f.name).sort()).toEqual([
      "DayWidgetProvider.java",
      "DayWidgetService.java",
      "DayWidgetTapActivity.java",
      "DayWidgetTaps.java",
      "DayWidgetUndo.java",
      "StatsWidgetFit.java",
      "StatsWidgetProvider.java",
      "WidgetDisplayText.java",
      "WidgetLook.java",
      "WidgetRequestCodes.java",
      "WidgetSupport.java",
    ]);
    expect(widgetHelpers).toHaveLength(5);
    for (const { name, code } of [...widgetSources, ...widgetHelpers]) {
      expect(code, name).not.toMatch(/hunt-mobile-state\.json|STATE_FILE/);
      expect(code, name).not.toMatch(/\bwriteText\s*\(|FileOutputStream|startWrite/);
      // The only queue operation a widget may use is appending; reading back is for hiding queued Tasks.
      const queueCalls = firstCaptures(code, /PendingTicks\.(\w+)\s*\(/g);
      for (const call of queueCalls) expect(["append", "queued"], `${name}: PendingTicks.${call}`).toContain(call);
    }
    expect(widgetSources.some(({ code }) => /PendingTicks\.append\s*\(/.test(code))).toBe(true);
    const save = blockAfter(javaCode, /public\s+void\s+saveWidgetSnapshot\(String\s+json\)\s*\{/);
    expect(save).toContain("saveWidgetSnapshotInternal(json)");
  });

  it("the Pending Tick queue only ever writes its own file, and only the bridge acknowledges", () => {
    const queue = widgetJava.find((f) => f.name === "PendingTicks.java")?.code ?? "";
    expect(queue, "PendingTicks.java").not.toBe("");
    expect(queue).not.toMatch(/hunt-mobile-state\.json|STATE_FILE|WIDGET_SNAPSHOT_FILE/);
    const writes = firstCaptures(queue, /HuntFiles\.writeText\(\s*([^,]+),/g);
    expect(writes.length).toBeGreaterThan(0);
    // Besides the queue, only its own set-aside copy of malformed entries (hunt-pending-ticks-*).
    for (const target of writes) expect(["queueFile(dir)", "aside"]).toContain(target.trim());
    expect(blockAfter(queue, /private\s+static\s+File\s+asideFile\([^)]*\)\s*\{/)).toContain('"hunt-pending-ticks-"');
    expect(blockAfter(queue, /static\s+File\s+queueFile\(File\s+dir\)\s*\{/)).toContain("HuntFiles.PENDING_TICKS_FILE");
    expect(read(path.join(JAVA_DIR, "HuntFiles.java"))).toMatch(/PENDING_TICKS_FILE\s*=\s*"hunt-pending-ticks\.json"/);
    // Acknowledging (which removes entries) happens only through the bridge, on the write thread.
    for (const { name, code } of widgetJava.filter((f) => f.name !== "PendingTicks.java")) {
      expect(code, name).not.toMatch(/PendingTicks\.ack\s*\(/);
    }
    expect(javaCode).toMatch(/PendingTicks\.ack\s*\(/);
    const ack = blockAfter(javaCode, /public\s+void\s+ackPendingTicks\(String\s+json\)\s*\{/);
    expect(ack).toContain("ackPendingTicksInternal(json)");
  });

  it("a newly queued tick tells a live, loaded page to drain (#10)", () => {
    const queue = widgetJava.find((f) => f.name === "PendingTicks.java")?.code ?? "";
    // The queue itself announces each new tick, after the write and outside the lock, so whatever
    // widget path appends (direct tap or after an undo window) reaches the page.
    const append = blockAfter(queue, /static\s+Queued\s+append\([^)]*\)\s*\{/);
    expect(append).toMatch(/notifyTickQueued\(\)/);
    expect(append.indexOf("notifyTickQueued()")).toBeGreaterThan(append.lastIndexOf("synchronized (HuntFiles.LOCK)"));
    const notify = blockAfter(queue, /private\s+static\s+void\s+notifyTickQueued\(\)\s*\{/);
    expect(notify).not.toMatch(/synchronized/);
    // MainActivity listens only while it exists; the signal is gated on a loaded page on the UI thread.
    const onCreate = blockAfter(javaCode, /protected\s+void\s+onCreate\(Bundle\s+savedInstanceState\)\s*\{/);
    expect(onCreate).toMatch(/PendingTicks\.setListener\(\s*tickQueuedListener\s*\)/);
    const onDestroy = blockAfter(javaCode, /protected\s+void\s+onDestroy\(\)\s*\{/);
    expect(onDestroy).toMatch(/PendingTicks\.clearListener\(\s*tickQueuedListener\s*\)/);
    const listener = blockAfter(javaCode, /tickQueuedListener\s*=\s*\(\)\s*->\s*main\.post\(\(\)\s*->\s*\{/);
    expect(listener).toMatch(/if\s*\(\s*pageLoaded\s*\)\s*callJs\(\s*"__huntPendingTicksArrived"\s*,\s*"null"\s*\)/);
    // ...and the packaged page answers it and also drains on resume.
    const page = read(ASSET_PAGE_FILE);
    expect(page).toMatch(/window\.__huntPendingTicksArrived\s*=\s*drainPendingTicksAndRender\b/);
    expect(blockAfter(page,/function\s+onAppVisible\(\)\s*\{/)).toMatch(/drainPendingTicks\(\)/);
  });

  it("a tickable row has its own tick target, separate from the open-Hunt row", () => {
    const service = widgetSources.find((f) => f.name === "DayWidgetService.java")?.code ?? "";
    expect(service).toMatch(/setOnClickFillInIntent\(\s*R\.id\.widget_row_tick\b/);
    expect(service).toMatch(/setOnClickFillInIntent\(\s*R\.id\.widget_row\b/);
  });

  it("every widget control is a touch target of at least 48dp", () => {
    const clickIds = new Set(
      widgetSources.flatMap(({ code }) =>
        firstCaptures(code, /setOn(?:Click(?:PendingIntent|FillInIntent))\(\s*R\.id\.(\w+)/g),
      ),
    );
    expect(clickIds.size).toBeGreaterThan(0);
    for (const id of clickIds) {
      const tag = widgetLayouts
        .map(({ xml }) => new RegExp(`<\\w+\\b[^>]*android:id="@\\+id/${id}"[^>]*>`).exec(xml)?.[0])
        .find(Boolean);
      expect(tag, `layout view for R.id.${id}`).toBeDefined();
      const dp = (attr: string) => Number(new RegExp(`android:${attr}="(\\d+)dp"`).exec(tag!)?.[1] ?? 0);
      expect(Math.max(dp("minHeight"), dp("layout_height")), `${id} height`).toBeGreaterThanOrEqual(48);
      const fillsWidth = /android:layout_width="match_parent"/.test(tag!);
      expect(fillsWidth || dp("minWidth") >= 48, `${id} width`).toBe(true);
    }
  });

  it("long titles stay on one line with an ellipsis", () => {
    const row = widgetLayouts.find((l) => l.name === "widget_day_row_neon.xml")?.xml ?? "";
    const title = /<TextView\b[^>]*android:id="@\+id\/widget_row_title"[^>]*>/.exec(row)?.[0] ?? "";
    expect(title).toMatch(/android:maxLines="1"/);
    expect(title).toMatch(/android:ellipsize="end"/);
    expect(title).toMatch(/android:layout_weight="1"/);
  });

  it("build-apk.sh refuses an APK without the widget resources", () => {
    const script = read(BUILD_SCRIPT_FILE);
    const list = /for e in ([^;]*); do\s*\n\s*grep -qx "\$e" <<<"\$ENTRIES"/.exec(script)?.[1] ?? "";
    for (const entry of ["res/xml/day_widget_info.xml", "res/layout/widget_day_neon.xml", "res/layout/widget_day_row_neon.xml"]) {
      expect(list.split(/\s+/), entry).toContain(entry);
    }
  });
});

// Runs build-apk.sh's real secret-scan block (KEY_FILE= up to the final copy, plus its info/die
// helpers) in bash against temp fixtures and a fake key. Never touches the real data/ folder.
const FAKE_KEY = `fake-sync-key-${"5a".repeat(20)}`;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hunt-android-shell-"));
const posixPath = (p: string): string => p.split(path.sep).join("/");
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function secretScanScript(): string {
  const script = read(BUILD_SCRIPT_FILE).replace(/\r\n/g, "\n");
  const start = script.indexOf("KEY_FILE=$APP_ROOT/");
  const end = script.indexOf('cp -f "$WORK_DIR/signed.apk"');
  if (start < 0 || end < start) throw new Error("secret-scan block not found in build-apk.sh");
  const helpers = script.split("\n").filter((line) => /^(info|die)\(\)/.test(line));
  return ["set -euo pipefail", ...helpers, script.slice(start, end)].join("\n");
}

/** A bash that sees node's paths (Git Bash on Windows, any bash elsewhere); WSL's does not. */
const bashUsable = ((): boolean => {
  const probe = path.join(tmpRoot, "probe");
  fs.writeFileSync(probe, "");
  const r = spawnSync("bash", ["-c", '[ -f "$PROBE" ]'], { env: { ...process.env, PROBE: posixPath(probe) } });
  return r.status === 0;
})();

interface ScanCase {
  name: string;
  keyFile: string | null;
  html: string | null;
  dex: string;
  status: number;
  says: string;
}

describe.skipIf(!bashUsable)("build-apk.sh secret scan, run in bash", () => {
  const cases: ScanCase[] = [
    { name: "key without a final newline (as the server writes it) in the page", keyFile: FAKE_KEY,
      html: `<script>const k="${FAKE_KEY}"</script>`, dex: "dex", status: 1, says: "embedded in packaged-hunt-mobile.html" },
    { name: "CRLF key file, key in classes.dex", keyFile: `${FAKE_KEY}\r\n`, html: "<p>ok</p>",
      dex: `\u0000\u0001${FAKE_KEY}\u0002`, status: 1, says: "embedded in classes.dex" },
    { name: "UTF-8 BOM and padding around the key, key in the page", keyFile: `﻿  ${FAKE_KEY}  \n\n`,
      html: FAKE_KEY, dex: "dex", status: 1, says: "embedded in packaged-hunt-mobile.html" },
    { name: "key in neither file", keyFile: FAKE_KEY, html: "<p>ok</p>", dex: "dex", status: 0,
      says: "the sync key is not in classes.dex or the packaged HTML" },
    { name: "blank key file", keyFile: "\r\n  \n", html: FAKE_KEY, dex: "dex", status: 0,
      says: "secret scan skipped: the key file is empty" },
    { name: "no key file", keyFile: null, html: FAKE_KEY, dex: "dex", status: 0, says: "" },
    { name: "unreadable scan target fails closed", keyFile: FAKE_KEY, html: null, dex: "dex", status: 1,
      says: "secret scan could not read packaged-hunt-mobile.html" },
  ];

  it.each(cases)("$name", ({ name, keyFile, html, dex, status, says }) => {
    const root = path.join(tmpRoot, name.replace(/\W+/g, "-"));
    fs.mkdirSync(path.join(root, "android-app"), { recursive: true });
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.mkdirSync(path.join(root, "work", "dex"), { recursive: true });
    if (keyFile !== null) fs.writeFileSync(path.join(root, "data", "hunt-sync.key"), keyFile, "utf8");
    if (html !== null) fs.writeFileSync(path.join(root, "work", "packaged-hunt-mobile.html"), html, "utf8");
    fs.writeFileSync(path.join(root, "work", "dex", "classes.dex"), dex, "latin1");

    const r = spawnSync("bash", ["-c", secretScanScript()], {
      encoding: "utf8",
      env: { ...process.env, APP_ROOT: posixPath(path.join(root, "android-app")), WORK_DIR: posixPath(path.join(root, "work")) },
    });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status, output).toBe(status);
    if (says) expect(output).toContain(says);
    else expect(output).not.toContain("secret scan");
    expect(output.includes(FAKE_KEY), "the key must never be printed").toBe(false);
  }, 15_000);
});

// Runs MainActivity.java's own pure helpers (copied verbatim into a probe class) on a JDK, so the
// navigation/request allowlist, the token rule and the saveState guard are tested as the real Java
// code rather than as a port. Skipped when no JDK 11+ is found (Android Studio bundles one).
const javaExe = ((): string | null => {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const homes = [
    process.env.JAVA_HOME,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Android Studio", "jbr"),
    "C:/Program Files/Android/Android Studio/jbr",
  ];
  const found = homes.flatMap((home) => (home ? [path.join(home, "bin", exe)] : [])).filter((p) => fs.existsSync(p));
  return [...found, "java"].find((java) => spawnSync(java, ["--version"]).status === 0) ?? null;
})();

const JAVA_PROBES = [
  "isPageUrl",
  "isAllowedRequest",
  "looksLikeJsonObject",
  "isValidSyncToken",
  "isAllowedSyncRouteUrl",
] as const;
type JavaProbe = (typeof JAVA_PROBES)[number];

/** A `private static` field declaration or method (header + body) from MainActivity.java. */
function javaMember(name: string): string {
  const field = new RegExp(`private\\s+static\\s+final\\s+[\\w\\[\\]]+\\s+${name}\\s*=[^;]*;`).exec(javaCode);
  if (field) return field[0];
  const header = new RegExp(`private\\s+static\\s+[\\w\\[\\]]+\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = header.exec(javaCode);
  if (!m) throw new Error(`member ${name} not found in MainActivity.java`);
  return javaCode.slice(m.index, m.index + m[0].length - 1) + blockAfter(javaCode, header);
}

/** Reads "<probe>\t<base64 arg | ->" lines on stdin and prints one 1/0 per line. */
function javaProbeSource(): string {
  const members = [
    "PAGE_URL",
    "ASSET_URL_PREFIX",
    "FONT_URL_PREFIXES",
    "SYNC_TOKEN_RE",
    "startsWithIgnoreCase",
    "isHttpUrl",
    "parseIpv4Literal",
    "isPrivateLanHost",
    "isCgnatHost",
    ...JAVA_PROBES,
  ];
  return [
    "import java.net.InetAddress;",
    "import java.net.MalformedURLException;",
    "import java.net.URL;",
    "import java.net.UnknownHostException;",
    "import java.nio.charset.StandardCharsets;",
    "import java.util.Base64;",
    "import java.util.Locale;",
    "import java.util.regex.Pattern;",
    "public class ShellHelpersProbe {",
    ...members.map(javaMember),
    "  public static void main(String[] args) throws Exception {",
    "    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8));",
    "    StringBuilder out = new StringBuilder();",
    "    for (String line; (line = in.readLine()) != null; ) {",
    '      String[] p = line.split("\\t", -1);',
    '      String arg = p[1].equals("-") ? null : new String(Base64.getDecoder().decode(p[1]), StandardCharsets.UTF_8);',
    "      boolean r;",
    "      switch (p[0]) {",
    ...JAVA_PROBES.map((fn) => `        case "${fn}": r = ${fn}(arg); break;`),
    "        default: throw new IllegalArgumentException(p[0]);",
    "      }",
    "      out.append(r ? '1' : '0');",
    "    }",
    "    System.out.print(out);",
    "  }",
    "}",
  ].join("\n");
}

const PAGE = "file:///android_asset/hunt-mobile.html";
const JAVA_CASES: Array<[JavaProbe, string | null, boolean]> = [
  // Navigation: only the page itself (an in-page #anchor is fine).
  ["isPageUrl", PAGE, true],
  ["isPageUrl", `${PAGE}#today`, true],
  ["isPageUrl", `${PAGE}?token=x`, false],
  ["isPageUrl", `${PAGE}.evil`, false],
  ["isPageUrl", "file:///android_asset/other.html", false],
  ["isPageUrl", "https://example.com/", false],
  ["isPageUrl", "about:blank", false],
  ["isPageUrl", "", false],
  // Requests: bundled assets, data:/blob:, about:blank and the two Google Fonts hosts only.
  ["isAllowedRequest", PAGE, true],
  ["isAllowedRequest", "file:///android_asset/hunt-logo.png", true],
  ["isAllowedRequest", "data:image/png;base64,AAAA", true],
  ["isAllowedRequest", "blob:null/6f1c6a7e-0000-4000-8000-000000000000", true],
  ["isAllowedRequest", "about:blank", true],
  ["isAllowedRequest", "https://fonts.googleapis.com/css2?family=Inter:wght@400", true],
  ["isAllowedRequest", "https://fonts.gstatic.com/s/inter/v13/a.woff2", true],
  ["isAllowedRequest", "file:///android_asset/../../data/data/com.hunt.companion/files/hunt-sync-token.txt", false],
  ["isAllowedRequest", "file:///data/data/com.hunt.companion/files/hunt-mobile-state.json", false],
  ["isAllowedRequest", "file:///android_res/raw/x", false],
  ["isAllowedRequest", "content://com.android.externalstorage.documents/x", false],
  ["isAllowedRequest", "about:srcdoc", false],
  ["isAllowedRequest", "https://fonts.googleapis.com.evil.example/css", false],
  ["isAllowedRequest", "https://fonts.googleapis.com@evil.example/", false],
  ["isAllowedRequest", "https://fonts.googleapis.com:8443/css", false],
  ["isAllowedRequest", "http://fonts.googleapis.com/css", false],
  ["isAllowedRequest", "https://evil.example/https://fonts.googleapis.com/", false],
  ["isAllowedRequest", "http://192.168.1.5:3000/api/sync", false],
  ["isAllowedRequest", "javascript:alert(1)", false],
  ["isAllowedRequest", "intent://scan/#Intent;scheme=zxing;end", false],
  ["isAllowedRequest", "", false],
  // saveState: only something shaped like a JSON object may replace the on-disk copy.
  ["looksLikeJsonObject", null, false],
  ["looksLikeJsonObject", "", false],
  ["looksLikeJsonObject", " \n\t ", false],
  ["looksLikeJsonObject", "{", false],
  ["looksLikeJsonObject", "}", false],
  ["looksLikeJsonObject", "{}", true],
  ["looksLikeJsonObject", ' \n{"tasks":[]}\t ', true],
  ["looksLikeJsonObject", "[]", false],
  ["looksLikeJsonObject", "null", false],
  ["looksLikeJsonObject", '"{}"', false],
  ["looksLikeJsonObject", "0", false],
  // Token rule: the same boundary matrix, through java.util.regex.
  ["isValidSyncToken", null, false],
  ...TOKEN_CASES.map(([token, valid]): [JavaProbe, string, boolean] => ["isValidSyncToken", token, valid]),
  // Pairing deep-link route allowlist: only private LAN, Tailscale CGNAT, or loopback HTTP(S) origins.
  ["isAllowedSyncRouteUrl", null, false],
  ["isAllowedSyncRouteUrl", "", false],
  ["isAllowedSyncRouteUrl", "http://192.168.1.5:3000", true],
  ["isAllowedSyncRouteUrl", "http://10.0.0.5:3000", true],
  ["isAllowedSyncRouteUrl", "http://172.16.4.2:3000", true],
  ["isAllowedSyncRouteUrl", "http://100.64.1.2:3000", true],
  ["isAllowedSyncRouteUrl", "http://localhost:3000", true],
  ["isAllowedSyncRouteUrl", "http://127.0.0.1:3000", true],
  ["isAllowedSyncRouteUrl", "http://192.168.1.5:3000@evil.example", false],
  ["isAllowedSyncRouteUrl", "https://evil.example:3000", false],
  ["isAllowedSyncRouteUrl", "http://8.8.8.8:3000", false],
  ["isAllowedSyncRouteUrl", "http://172.32.0.1:3000", false],
  ["isAllowedSyncRouteUrl", "ftp://192.168.1.5:3000", false],
];

describe.skipIf(!javaExe)("MainActivity.java helpers, run on the JDK", () => {
  it("the allowlist, token rule and saveState guard decide every case as the contract says", () => {
    const file = path.join(tmpRoot, "ShellHelpersProbe.java");
    fs.writeFileSync(file, javaProbeSource(), "utf8");
    const input = JAVA_CASES.map(([fn, arg]) => `${fn}\t${arg === null ? "-" : Buffer.from(arg, "utf8").toString("base64")}`);
    const r = spawnSync(javaExe ?? "java", [file], { cwd: tmpRoot, input: input.join("\n"), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toHaveLength(JAVA_CASES.length);
    JAVA_CASES.forEach(([fn, arg, want], i) => {
      expect(r.stdout[i] === "1", `${fn}(${JSON.stringify(arg).slice(0, 80)})`).toBe(want);
    });
  }, 60_000);
});

// MainActivity is exported with a BROWSABLE hunt://pair filter, so any web page or app can
// fire a pairing link. The first pairing stays one tap; replacing an existing pairing (another key
// or another laptop) must save nothing until the user taps Pair in a native dialog.
describe("pairing deep link cannot silently replace an existing pairing", () => {
  it("handlePairingIntent only validates and decides; the save happens in applyPairing, behind the dialog", () => {
    const handler = blockAfter(javaCode, /private\s+void\s+handlePairingIntent\s*\(/);
    expect(handler).not.toMatch(/saveSyncTokenInternal|saveLaptopUrlInternal|notifyPagePaired|pendingPairedToastUrl/);
    expect(handler).toContain("isAllowedSyncRouteUrl(baseUrl)");
    expect(handler).toContain("isValidSyncToken(key)");
    // the saved key is read (Keystore work) on ioExec, never on the UI thread
    expect(handler).toMatch(/executeQuietly\(ioExec,[\s\S]*needsPairingConfirmation\(syncToken\(\), laptopUrl\(\), key, baseUrl\)/);
    expect(handler).toMatch(/if \(confirm\) \{\s*confirmReplacePairing\(key, baseUrl\);\s*\} else \{\s*applyPairing\(key, baseUrl\);\s*\}/);

    const confirm = blockAfter(javaCode, /private\s+void\s+confirmReplacePairing\s*\(/);
    expect(confirm).not.toMatch(/saveSyncTokenInternal|saveLaptopUrlInternal|notifyPagePaired/);
    expect(confirm.match(/applyPairing\(/g)).toHaveLength(1);
    expect(confirm).toMatch(/setPositiveButton\("Pair", \(\w+, \w+\) -> applyPairing\(key, baseUrl\)\)/);
    expect(confirm).toContain('setNegativeButton("Cancel", null)');
    expect(confirm).toContain('"Pair with " + host + "?"');

    const apply = blockAfter(javaCode, /private\s+void\s+applyPairing\s*\(/);
    expect(apply).toContain("saveSyncTokenInternal(key)");
    expect(apply).toContain("saveLaptopUrlInternal(baseUrl)");
    // applyPairing is reached only from those two places (first pairing, or the Pair button)
    expect(javaCode.match(/applyPairing\(key, baseUrl\)/g)).toHaveLength(2);

    // framework dialog only (javac --release 11 against android.jar, no AndroidX), dismissed on destroy
    expect(javaCode).toContain("import android.app.AlertDialog;");
    expect(javaCode).not.toMatch(/\bandroidx\./);
    expect(blockAfter(javaCode, /protected\s+void\s+onDestroy\s*\(\s*\)/)).toContain("pairingDialog.dismiss()");
  });
});

/** Reads "<savedToken>\t<savedUrl>\t<newToken>\t<newUrl>" (base64 or "-" for null) lines, prints 1/0 each. */
function pairingProbeSource(): string {
  return [
    "import java.nio.charset.StandardCharsets;",
    "import java.util.Base64;",
    "public class PairingDecisionProbe {",
    javaMember("needsPairingConfirmation"),
    "  static String arg(String s) {",
    '    return s.equals("-") ? null : new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);',
    "  }",
    "  public static void main(String[] args) throws Exception {",
    "    java.io.BufferedReader in = new java.io.BufferedReader(new java.io.InputStreamReader(System.in, StandardCharsets.UTF_8));",
    "    StringBuilder out = new StringBuilder();",
    "    for (String line; (line = in.readLine()) != null; ) {",
    '      String[] p = line.split("\t", -1);',
    "      out.append(needsPairingConfirmation(arg(p[0]), arg(p[1]), arg(p[2]), arg(p[3])) ? '1' : '0');",
    "    }",
    "    System.out.print(out);",
    "  }",
    "}",
  ].join("\n");
}

describe.skipIf(!javaExe)("needsPairingConfirmation, run on the JDK", () => {
  const key = "k".repeat(40);
  const other = "z".repeat(40);
  const lan = "http://192.168.1.5:3000";
  const attacker = "http://192.168.2.99:3000";
  const cases: Array<[string | null, string | null, string, string, boolean, string]> = [
    ["", lan, key, lan, false, "first pairing (no key saved): one tap"],
    [null, lan, key, attacker, false, "first pairing, any allowed laptop"],
    [key, lan, key, lan, false, "the same pairing again"],
    [key, lan, other, lan, true, "another key for the same laptop"],
    [key, lan, key, attacker, true, "the same key pointed at another laptop"],
    [key, lan, other, attacker, true, "a whole new pairing"],
    [key, null, key, lan, true, "no saved laptop URL to compare with"],
  ];

  it("asks only when an existing pairing would be replaced", () => {
    const file = path.join(tmpRoot, "PairingDecisionProbe.java");
    fs.writeFileSync(file, pairingProbeSource(), "utf8");
    const enc = (v: string | null) => (v === null ? "-" : Buffer.from(v, "utf8").toString("base64"));
    const input = cases.map(([a, b, c, d]) => [a, b, c, d].map(enc).join("\t"));
    const r = spawnSync(javaExe ?? "java", [file], { cwd: tmpRoot, input: input.join("\n"), encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toHaveLength(cases.length);
    cases.forEach(([, , , , want, label], i) => expect(r.stdout[i] === "1", label).toBe(want));
  }, 60_000);
});

// Day Widget ‹ › navigation (#7): today to today + 6, back to today at local midnight.
const JAVA_DIR_SHELL = path.dirname(JAVA_FILE);
const dayProviderCode = stripJavaComments(read(path.join(JAVA_DIR_SHELL, "DayWidgetProvider.java")));
const dayNavCode = stripJavaComments(read(path.join(JAVA_DIR_SHELL, "DayNav.java")));
const dayLayoutXml = read(path.join(MAIN, "res", "layout", "widget_day_neon.xml"));

describe("Day Widget ‹ › navigation", () => {
  const tagOf = (id: string) => new RegExp(`<\\w+\\b[^>]*android:id="@\\+id/${id}"[^>]*>`).exec(dayLayoutXml)?.[0] ?? "";
  const dp = (tag: string, attr: string) => Number(new RegExp(`android:${attr}="(\\d+)dp"`).exec(tag)?.[1] ?? 0);

  it("‹ and › are 48dp square targets in the header, 8dp clear of the day label", () => {
    for (const id of ["widget_prev", "widget_next"]) {
      const tag = tagOf(id);
      expect(tag, id).not.toBe("");
      expect(dp(tag, "minWidth"), `${id} minWidth`).toBeGreaterThanOrEqual(48);
      expect(dp(tag, "minHeight"), `${id} minHeight`).toBeGreaterThanOrEqual(48);
      expect(tag, `${id} label`).toMatch(/android:contentDescription="@string\/day_widget_(prev|next)"/);
      expect(dayProviderCode).toContain(`R.id.${id}`);
    }
    const label = tagOf("widget_header");
    expect(dp(label, "layout_marginStart")).toBeGreaterThanOrEqual(8);
    expect(dp(label, "layout_marginEnd")).toBeGreaterThanOrEqual(8);
  });

  it("the header and the rows arrive in one update, at once, after an arrow tap", () => {
    // API 31+: an Intent-served list makes the system send only "update deferred", so the
    // launcher redrew the header late; the rows ride inline as RemoteCollectionItems instead.
    expect(dayProviderCode).toMatch(
      /if\s*\(Build\.VERSION\.SDK_INT\s*>=\s*Build\.VERSION_CODES\.S\)\s*\{\s*views\.setRemoteAdapter\(R\.id\.widget_list,\s*DayWidgetService\.items\(ctx,\s*widgetId,\s*day\)\);/,
    );
    // The tap's broadcast is foreground, so a cached app does not queue it behind background work.
    expect(blockAfter(dayProviderCode, /static\s+PendingIntent\s+navIntent\s*\([^)]*\)\s*\{/)).toContain(
      "Intent.FLAG_RECEIVER_FOREGROUND",
    );
  });

  it("the arrows are explicit, immutable broadcasts to the non-exported provider", () => {
    const nav = blockAfter(dayProviderCode, /static\s+PendingIntent\s+navIntent\s*\([^)]*\)\s*\{/);
    expect(nav).toContain("new Intent(ctx, DayWidgetProvider.class)");
    expect(nav).toContain("setAction(ACTION_NAV)");
    expect(nav).toContain("PendingIntent.getBroadcast(");
    expect(nav).toContain("PendingIntent.FLAG_IMMUTABLE");
    // Explicit only: no intent filter lets another app send the nav action.
    expect(manifest).not.toContain("DAY_WIDGET_NAV");
  });

  it("the selected day lives only in the widget's own private preferences", () => {
    const prefs = captures(dayNavCode, /getSharedPreferences\(\s*(\w+)\s*,\s*([\w.]+)\s*\)/g, 1, 2);
    expect(prefs.length).toBeGreaterThan(0);
    for (const [name, mode] of prefs) {
      expect(name).toBe("NAV_PREFS");
      expect(mode).toBe("Context.MODE_PRIVATE");
    }
  });
});

describe.skipIf(!hasJdk)("Day Widget day selection and labels, run on the JDK", () => {
  const nothingLeft = /name="day_widget_nothing_left">([^<]*)</.exec(read(path.join(MAIN, "res", "values", "strings.xml")))?.[1] ?? "";

  it("clamps the selected day to today .. today + 6 and expires it at local midnight", () => {
    // [savedOn, savedOffset, todayKey] -> offset
    const cases: Array<[string | null, number, string, string]> = [
      ["2026-11-22", 3, "2026-11-22", "3"],
      ["2026-11-22", 6, "2026-11-22", "6"],
      ["2026-11-22", 7, "2026-11-22", "6"], // stops at today + 6
      ["2026-11-22", -1, "2026-11-22", "0"], // stops at today
      ["2026-11-22", 3, "2026-11-23", "0"], // local midnight passed: back to today
      [null, 3, "2026-11-22", "0"], // never navigated
    ];
    const main = cases
      .map(([on, off, today]) => `System.out.println(DaySelection.selectedOffset(${on ? `"${on}"` : "null"}, ${off}, "${today}"));`)
      .join("\n");
    expect(runJavaProbe({ classes: ["DaySelection.java"], main })).toEqual(cases.map((c) => c[3]));
  }, 60_000);

  it("draws today's view only on the current date, and labels the header Today, Tomorrow, then Tue 24", () => {
    const lines = runJavaProbe({
      classes: ["DaySelection.java"],
      imports: ["java.time.LocalDate"],
      main: [
        'System.out.println(DaySelection.viewFor("2026-11-22", "2026-11-22").key);',
        'System.out.println(DaySelection.viewFor("2026-11-23", "2026-11-22").key);',
        'System.out.println(DaySelection.headerLabel(0, LocalDate.parse("2026-11-22")));',
        'System.out.println(DaySelection.headerLabel(1, LocalDate.parse("2026-11-23")));',
        'System.out.println(DaySelection.headerLabel(2, LocalDate.parse("2026-11-24")));',
        'System.out.println(DaySelection.headerLabel(6, LocalDate.parse("2026-12-01")));',
      ].join("\n"),
    });
    expect(lines).toEqual(["today", "future", "Today", "Tomorrow", "Tue 24", "Tue 1"]);
  }, 60_000);

  it("an empty day reads 'Nothing left for today', '… for tomorrow', then '… for Tue 24'", () => {
    expect(nothingLeft).toBe("Nothing left for %1$s");
    const lines = runJavaProbe({
      classes: ["DaySelection.java"],
      imports: ["java.time.LocalDate"],
      main: [0, 1, 2]
        .map((i) => `System.out.println(String.format("${nothingLeft}", DaySelection.inSentence(${i}, LocalDate.parse("2026-11-2${2 + i}"))));`)
        .join("\n"),
    });
    expect(lines).toEqual(["Nothing left for today", "Nothing left for tomorrow", "Nothing left for Tue 24"]);
  }, 60_000);
});

// the build script's final hand-off and its help text.
describe("build-apk.sh output and help", () => {
  it("writes the APK atomically: a temp file next to the output (git-ignored *.apk), renamed over it", () => {
    const script = read(BUILD_SCRIPT_FILE);
    expect(script).toContain('OUT_TMP="$(dirname "$OUT_APK")/.$(basename "$OUT_APK" .apk).partial-$$.apk"');
    expect(script).toContain(`trap 'rm -f "$OUT_TMP"' EXIT`);
    expect(script).toMatch(/cp -f "\$WORK_DIR\/signed\.apk" "\$OUT_TMP"\nmv -f "\$OUT_TMP" "\$OUT_APK"\n/);
    expect(script).not.toMatch(/cp -f "\$WORK_DIR\/signed\.apk" "\$OUT_APK"/);
    expect(read(path.join(ROOT, ".gitignore")).split(/\r?\n/)).toContain("*.apk");
  });

  it.skipIf(!bashUsable)("--help prints the header comment block only (no stray 'set -euo pipefail')", () => {
    const r = spawnSync("bash", [posixPath(BUILD_SCRIPT_FILE), "--help"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n");
    expect(r.stdout).not.toContain("set -euo pipefail");
    expect(lines[0]).toMatch(/^=+$/);
    expect(lines[lines.length - 1]).toMatch(/^=+$/);
    expect(r.stdout).toContain("Usage (Git Bash on Windows");
  }, 15_000);
});
