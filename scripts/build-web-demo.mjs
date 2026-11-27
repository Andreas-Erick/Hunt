// Builds the browser demo (ADR-0010) as a static folder: `npm run build:web`.
//
//   node scripts/build-web-demo.mjs            build into out/ for HUNT_WEB_BASE_PATH (default /demos/hunt)
//   node scripts/build-web-demo.mjs --no-build only prune and measure an existing out/
//
// After `next build` exports out/, the native-only files in public/ are removed (the phone
// app, its APK and the desktop reminder worker), and the script prints the raw and gzipped
// size of what a first visit downloads.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = path.join(ROOT, "out");

/** public/ files the static demo must not ship: none of them work without the native app. */
export const NATIVE_ONLY_FILES = ["Hunt-Mobile.apk", "hunt-mobile.html", "hunt-reminder-sw.js"];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function build() {
  const env = { ...process.env, HUNT_WEB_DEMO: "1", NEXT_TELEMETRY_DISABLED: "1" };
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function prune() {
  for (const name of NATIVE_ONLY_FILES) rmSync(path.join(OUT_DIR, name), { force: true });
}

function report() {
  const files = walk(OUT_DIR);
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    raw += bytes.length;
    gzip += gzipSync(bytes, { level: 9 }).length;
  }
  console.log(
    `\nWeb demo: ${path.relative(ROOT, OUT_DIR)}/ · ${files.length} files · ` +
      `${formatBytes(raw)} raw · ${formatBytes(gzip)} gzipped (every file; a first visit loads less)`
  );
}

if (!process.argv.includes("--no-build")) build();
if (!existsSync(OUT_DIR) || !statSync(OUT_DIR).isDirectory()) {
  console.error("out/ is missing: next build did not export the demo.");
  process.exit(1);
}
prune();
report();
