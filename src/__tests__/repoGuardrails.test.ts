// @vitest-environment node
// Repository guardrails: mechanical rules for code, tests and docs that review should never have to
// catch by eye. The UI rules live next door in sourceScan_uiGuardrails.test.ts. Each failure message
// says how to fix it; change a budget or an allowlist here only with the reason next to it.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const lineCount = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}
const rel = (file: string) => path.relative(ROOT, file).replace(/\\/g, "/");

const TEST_DIR = path.join(ROOT, "src", "__tests__");
const testFiles = walk(TEST_DIR, (f) => /\.test\.tsx?$/.test(f));
const productionFiles = walk(path.join(ROOT, "src"), (f) => /\.tsx?$/.test(f) && !f.includes("__tests__"));

// ---------------------------------------------------------------------------
// README states facts the repo can check
// ---------------------------------------------------------------------------
describe("README facts match the repo", () => {
  const readme = read("README.md");

  it("TypeScript badge matches the version the lockfile installs", () => {
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string }> };
    const [major, minor] = (lock.packages["node_modules/typescript"]?.version ?? "").split(".");
    expect(readme, "update the TypeScript badge in README.md").toContain(`TypeScript-${major}.${minor}`);
  });

  it("Android badge matches minSdkVersion and targetSdkVersion in the manifest", () => {
    const manifest = read("android-app", "app", "src", "main", "AndroidManifest.xml");
    const min = /minSdkVersion="(\d+)"/.exec(manifest)?.[1];
    const target = /targetSdkVersion="(\d+)"/.exec(manifest)?.[1];
    expect(readme, "update the Android badge in README.md").toContain(`min%20${min}%20%C2%B7%20target%20${target}`);
  });

  it("Design decisions table links every ADR in docs/adr", () => {
    const adrs = fs.readdirSync(path.join(ROOT, "docs", "adr")).filter((f) => /^\d{4}-.+\.md$/.test(f));
    expect(adrs.length).toBeGreaterThan(0);
    const missing = adrs.filter((f) => !readme.includes(`](docs/adr/${f})`));
    expect(missing, "add a row to README.md's Design decisions table").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Markdown reads on a 375px phone (GitHub app) as well as on desktop
// ---------------------------------------------------------------------------
describe("Markdown renders on narrow screens", () => {
  const docs = [path.join(ROOT, "README.md"), ...walk(path.join(ROOT, "docs"), (f) => f.endsWith(".md"))];

  it.each(docs.map((f) => [rel(f), f]))("%s: code lines fit 66 characters, diagrams run top-down, images are fluid", (_name, file) => {
    const lines = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n");
    let inCode = false;
    const problems: string[] = [];
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        inCode = !inCode;
        return;
      }
      if (inCode && line.length > 66) problems.push(`line ${i + 1}: code line is ${line.length} chars; wrap with \\`);
      if (/\b(?:flowchart|graph)\s+(?:LR|RL)\b/.test(line)) problems.push(`line ${i + 1}: use flowchart TB`);
      const width = /\bwidth="(\d+)"/.exec(line);
      if (width && Number(width[1]) > 120) problems.push(`line ${i + 1}: width="${width[1]}" overflows a phone; use a percentage`);
      if (/<table\b/i.test(line)) problems.push(`line ${i + 1}: HTML tables crush on phones; use a list or a <=3-column Markdown table`);
    });
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phone page: shared rules come from HuntCore, not hand-written copies
// ---------------------------------------------------------------------------
describe("phone page uses the shared core for domain rows", () => {
  it("builds TimeLog rows only inside the generated HUNT-CORE block", () => {
    const html = read("public", "hunt-mobile.html");
    const begin = html.indexOf("<!-- HUNT-CORE:BEGIN");
    const end = html.indexOf("<!-- HUNT-CORE:END -->");
    expect(begin).toBeGreaterThan(-1);
    const outside = html.slice(0, begin) + html.slice(end);
    const handBuilt = outside
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /\b(?:taskTitleSnapshot|questCodeSnapshot|accentColorSnapshot)\s*:/.test(line));
    expect(handBuilt, "build log rows with HuntCore.buildBurstLog (src/lib/taskQueue.ts)").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests are named after behaviour and exercise behaviour
// ---------------------------------------------------------------------------
describe("tests describe behaviour", () => {
  it("test files are named after what they test, not after an audit or a release", () => {
    const bad = testFiles.map(rel).filter((f) => /\/(?:audit[_-]|v\d+|release)[^/]*\.test\./i.test(f));
    expect(bad).toEqual([]);
  });

  it("test titles carry no audit-pass ids (they point at notes outside the repo)", () => {
    const titleRe = /\b(?:describe|it|test)(?:\.\w+(?:\([^)]*\))?)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    const idRe = /\b(?:P\d\d-\d+|[A-Z]{2,4}-\d\d)\b|\bPrompts? \d/;
    const bad: string[] = [];
    for (const file of testFiles) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(titleRe)) {
        if (idRe.test(m[2])) bad.push(`${rel(file)}: "${m[2]}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Reading production TypeScript as text passes even when behaviour breaks. These suites do it on
  // purpose; any other test asserts on behaviour (render, call, fire the event) instead.
  const READS_SOURCE_ON_PURPOSE: Record<string, string> = {
    "src/__tests__/architectureTopology.test.ts": "builds the import graph from the TypeScript AST",
    "src/__tests__/sourceScan_uiGuardrails.test.ts": "AST scanner for the UI rules",
    "src/__tests__/repoGuardrails.test.ts": "this file",
    "src/__tests__/syncClient.test.ts": "secret scan: no key literal in the sync client source",
    "src/__tests__/syncRouteSecurity.test.ts": "secret scan: no key literal or echo in the route source",
    "src/__tests__/readModel.test.ts": "layering scan: only reads.ts / the store touch db tables",
    "src/__tests__/appShell.test.tsx": "scans components for raw error text",
    "src/__tests__/uiFoundation.test.tsx": "reads the look token blocks in globals.css to check contrast in both looks",
    "src/__tests__/desktopShellDetails.test.tsx": "no Google font request in layout.tsx (a network fact jsdom can't observe)",
  };

  it("only the allowlisted suites read production TypeScript as text", () => {
    const readers = testFiles
      .filter((f) => {
        const text = fs.readFileSync(f, "utf8");
        return /readFileSync/.test(text) && /["'`][\w./-]+\.tsx?["'`]/.test(text.replace(/["'`](?:\.d\.ts|index\.tsx?)["'`]/g, ""));
      })
      .map(rel)
      .filter((f) => !(f in READS_SOURCE_ON_PURPOSE));
    expect(readers, "assert on behaviour, or add the file to READS_SOURCE_ON_PURPOSE with a reason").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// File-size ratchet: new modules stay small, the big ones only shrink
// ---------------------------------------------------------------------------
describe("module size ratchet", () => {
  const NEW_FILE_BUDGET = 600;
  // Over budget when the ratchet was added (2026-11-22). A file may shrink; lower its number when it
  // does. A file that must grow past its number gets split instead.
  const FROZEN: Record<string, number> = {
    "src/components/GuideLabSection.tsx": 767,
    "src/components/MobileSyncModal.tsx": 772,
    "src/components/PlanWeekView.tsx": 809,
    "src/components/QuestMatrixPanel.tsx": 1161,
    "src/components/TelemetryDashboardView.tsx": 929,
    "src/lib/questScience.ts": 618,
    "src/lib/reviewAnalytics.ts": 1012,
    "src/lib/syncTypes.ts": 776,
    "src/store/useCommandStore.ts": 803,
  };

  it(`keeps production modules within ${NEW_FILE_BUDGET} lines, or within their frozen size`, () => {
    const over = productionFiles
      .map((f) => ({ file: rel(f), lines: lineCount(fs.readFileSync(f, "utf8")) }))
      .filter(({ file, lines }) => lines > (FROZEN[file] ?? NEW_FILE_BUDGET))
      .map(({ file, lines }) => `${file}: ${lines} lines (budget ${FROZEN[file] ?? NEW_FILE_BUDGET}); split it`);
    expect(over).toEqual([]);
  });

  it("frozen entries still exist (remove an entry when its file is deleted or split under budget)", () => {
    const stale = Object.keys(FROZEN).filter((f) => {
      const full = path.join(ROOT, f);
      return !fs.existsSync(full) || lineCount(fs.readFileSync(full, "utf8")) <= NEW_FILE_BUDGET;
    });
    expect(stale).toEqual([]);
  });
});
