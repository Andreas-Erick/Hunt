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
      /synchronized\s*\(FILE_LOCK\)\s*\{\s*if\s*\(\s*!token\.equals\(syncTokenCache\.get\(\)\)\s*\)\s*return;\s*writeConfigFile\(SYNC_TOKEN_FILE,\s*envelope\);/,
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

describe("MainActivity.java: WebView isolation (AND-01, AND-06)", () => {
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
      getLaptopUrl: "String",
      saveLaptopUrl: "void",
      saveSyncToken: "boolean",
      syncWithLaptopAsync: "boolean",
      setKeepScreenOn: "void",
      vibrateClick: "void",
      getAppVersion: "String",
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

  it("saveState ignores input that is not shaped like a JSON object (AND-04)", () => {
    const save = blockAfter(javaCode, /private\s+void\s+saveStateInternal\(String\s+json\)\s*\{/);
    expect(save).toMatch(/^\{\s*if\s*\(\s*!looksLikeJsonObject\(json\)\s*\)\s*\{[^}]*return;\s*\}/);
    const guard = blockAfter(javaCode, /private\s+static\s+boolean\s+looksLikeJsonObject\(String\s+s\)\s*\{/);
    expect(guard).toContain("Character.isWhitespace");
    expect(guard).toMatch(/charAt\(start\)\s*==\s*'\{'/);
    expect(guard).toMatch(/charAt\(end\)\s*==\s*'\}'/);
  });

  it("saveLaptopUrl ignores non-empty values that are not http(s) URLs (AND-04)", () => {
    const save = blockAfter(javaCode, /private\s+void\s+saveLaptopUrlInternal\(String\s+url\)\s*\{/);
    const guardAt = save.search(/if\s*\(\s*!clean\.isEmpty\(\)\s*&&\s*!isHttpUrl\(clean\)\s*\)\s*\{[^}]*return;/);
    expect(guardAt).toBeGreaterThan(-1);
    expect(save.indexOf("laptopUrlCache = clean")).toBeGreaterThan(guardAt);
  });
});

describe("AndroidManifest.xml and backup rules", () => {
  it("requests exactly INTERNET, ACCESS_NETWORK_STATE and VIBRATE (AND-05)", () => {
    const permissions = firstCaptures(manifest, /<uses-permission\s+android:name="([^"]+)"/g).sort();
    expect(permissions).toEqual([
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.INTERNET",
      "android.permission.VIBRATE",
    ]);
  });

  it("is versionCode >= 8 (1.5.2) so it installs over the shipped 1.5.1 (7)", () => {
    const code = Number(/android:versionCode="(\d+)"/.exec(manifest)?.[1]);
    expect(code).toBeGreaterThanOrEqual(8);
    expect(/android:versionName="([^"]+)"/.exec(manifest)?.[1]).toBe("1.5.2");
  });

  it("handles API 30+ system bars & IME via a padded FrameLayout container (never webView.setPadding)", () => {
    expect(javaCode).toContain("FrameLayout container = new FrameLayout(this)");
    expect(javaCode).toContain("installSmoothImeInsets(container)");
    expect(javaCode).toContain("setDecorFitsSystemWindows(false)");
    expect(javaCode).toContain("WindowInsetsAnimation.Callback");
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

describe("build hygiene (ARC-12, AND-09, SRV-09)", () => {
  it("has no *.kt or *.gradle.kts file anywhere under android-app", () => {
    const stale = walkFiles(APP).filter((f) => f.endsWith(".kt") || f.endsWith(".gradle.kts"));
    expect(stale).toEqual([]);
  });

  it("keeps the pinned signing keystore", () => {
    expect(fs.existsSync(path.join(APP, "keystore", "hunt-debug.keystore"))).toBe(true);
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

  it("public/ serves only the APK, the favicon, the logo and the phone page", () => {
    expect(fs.readdirSync(path.join(ROOT, "public")).sort()).toEqual([
      "Hunt-Mobile.apk",
      "favicon.ico",
      "hunt-logo.png",
      "hunt-mobile.html",
    ]);
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

describe.skipIf(!bashUsable)("build-apk.sh secret scan (AND-09), run in bash", () => {
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

const JAVA_PROBES = ["isPageUrl", "isAllowedRequest", "looksLikeJsonObject", "isValidSyncToken"] as const;
type JavaProbe = (typeof JAVA_PROBES)[number];

/** A `private static` field declaration or method (header + body) from MainActivity.java. */
function javaMember(name: string): string {
  const field = new RegExp(`private\\s+static\\s+final\\s+[\\w\\[\\]]+\\s+${name}\\s*=[^;]*;`).exec(javaCode);
  if (field) return field[0];
  const header = new RegExp(`private\\s+static\\s+\\w+\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = header.exec(javaCode);
  if (!m) throw new Error(`member ${name} not found in MainActivity.java`);
  return javaCode.slice(m.index, m.index + m[0].length - 1) + blockAfter(javaCode, header);
}

/** Reads "<probe>\t<base64 arg | ->" lines on stdin and prints one 1/0 per line. */
function javaProbeSource(): string {
  const members = ["PAGE_URL", "ASSET_URL_PREFIX", "FONT_URL_PREFIXES", "SYNC_TOKEN_RE", "startsWithIgnoreCase", ...JAVA_PROBES];
  return [
    "import java.nio.charset.StandardCharsets;",
    "import java.util.Base64;",
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
  ["isAllowedRequest", "http://192.168.2.136:3000/api/sync", false],
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
];

describe.skipIf(!javaExe)("MainActivity.java helpers, run on the JDK (AND-01, AND-02, AND-04)", () => {
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
