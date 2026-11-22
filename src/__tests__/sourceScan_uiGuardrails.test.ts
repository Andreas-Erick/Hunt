/**
 * Repo-wide UI guardrails, checked on the source rather than per view.
 *
 * Hunt's desktop app also runs on touch tablets (LAN URL), so mouse-only habits
 * ship as real bugs there. Each rule below encodes a defect class found by the
 * 2026-11-22 UI audit; the message on failure names the fix.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const COMPONENT_DIRS = ["src/components", "src/app"];
const MOBILE_HTML = "public/hunt-mobile.html";

/** Elements that render a <button>. */
const BUTTON_TAGS = new Set(["button", "motion.button", "ConfirmDeleteButton"]);

function sourceFiles(): string[] {
  return COMPONENT_DIRS.flatMap((dir) =>
    readdirSync(path.join(ROOT, dir))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => path.join(dir, f).replace(/\\/g, "/"))
  );
}

interface ButtonClass {
  file: string;
  line: number;
  /** Literal class text (template expressions dropped, identifiers kept as `{Name}`). */
  classes: string;
}

/** Collects literal class text from a className initializer, keeping identifier names. */
function classText(node: ts.Node | undefined): string {
  if (!node) return "";
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteralLike(n)) parts.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      n.templateSpans.forEach((s) => {
        visit(s.expression);
        parts.push(s.literal.text);
      });
    } else if (ts.isIdentifier(n)) parts.push(`{${n.text}}`);
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return parts.join(" ");
}

function buttonClasses(): ButtonClass[] {
  const out: ButtonClass[] = [];
  for (const file of sourceFiles().filter((f) => f.endsWith(".tsx"))) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = n.tagName.getText(sf);
        if (BUTTON_TAGS.has(tag)) {
          const attr = n.attributes.properties.find(
            (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === "className"
          );
          if (attr?.initializer) {
            out.push({
              file,
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              classes: classText(attr.initializer),
            });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const has = (classes: string, re: RegExp) => re.test(` ${classes} `);
const where = (b: ButtonClass) => `${b.file}:${b.line}`;

describe("UI guardrails (source scan)", () => {
  const buttons = buttonClasses();

  it("finds the app's buttons (scanner sanity check)", () => {
    expect(buttons.length).toBeGreaterThan(100);
  });

  it("never uses transition-all: name the animated properties", () => {
    const offenders = sourceFiles().flatMap((file) =>
      readFileSync(path.join(ROOT, file), "utf8")
        .split("\n")
        .flatMap((line, i) => (/\btransition-all\b/.test(line) ? [`${file}:${i + 1}`] : []))
    );
    const mobile = readFileSync(path.join(ROOT, MOBILE_HTML), "utf8")
      .split("\n")
      .flatMap((line, i) => (/transition:\s*all\b/.test(line) ? [`${MOBILE_HTML}:${i + 1}`] : []));
    expect(
      [...offenders, ...mobile],
      "use transition-[color,background-color,border-color,opacity,transform] (or transition: <props>)"
    ).toEqual([]);
  });

  it("reveals hover-hidden buttons on touch and keyboard", () => {
    const offenders = buttons
      .filter((b) => has(b.classes, /\sopacity-0\s/))
      .filter(
        (b) =>
          !has(b.classes, /\shoverless:opacity-/) || !has(b.classes, /\sfocus-visible:opacity-100\s/)
      )
      .map(where);
    expect(
      offenders,
      "an opacity-0 button needs hoverless:opacity-* and focus-visible:opacity-100 (row deletes: ROW_DELETE_CLASS)"
    ).toEqual([]);
  });

  it("gives 16-20px buttons a hit area of at least 36px", () => {
    const offenders = buttons
      .filter((b) => has(b.classes, /\sh-[45]\s/) && has(b.classes, /\sw-[45]\s/))
      .filter((b) => !has(b.classes, /\sbefore:-inset-(2\.5|3|4)\s/))
      .map(where);
    expect(
      offenders,
      "add relative before:absolute before:-inset-3 (h-5) / before:-inset-2.5 (h-4) before:content-['']"
    ).toEqual([]);
  });

  it("keeps text-xs chip buttons at least 32px tall", () => {
    const offenders = buttons
      .filter((b) => has(b.classes, /\spy-(0|0\.5|1)\s/) && has(b.classes, /\stext-(xs|\[1[01]px\])\s/))
      .filter((b) => !has(b.classes, /\smin-h-/))
      .map(where);
    expect(offenders, "add min-h-8 coarse:min-h-11 (and py-1.5)").toEqual([]);
  });
});
