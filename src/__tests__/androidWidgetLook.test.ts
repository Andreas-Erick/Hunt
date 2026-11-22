// @vitest-environment node
//
// Both widgets follow the chosen look, Neon or Dawn (ADR-0005, #12). The Java code cannot run under
// vitest, so these read colors.xml, the widget layouts and the sources: the widget colours must stay
// in step with the CSS look tokens (the desktop's globals.css and the phone page's :root blocks),
// and every Neon layout needs a Dawn twin with the same view ids and geometry, since RemoteViews
// before API 31 can only switch looks by inflating a different layout.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const MAIN = path.join(ROOT, "android-app", "app", "src", "main");
const RES = path.join(MAIN, "res");
const JAVA_DIR = path.join(MAIN, "java", "com", "hunt", "companion");
const read = (...parts: string[]): string => fs.readFileSync(path.join(...parts), "utf8");

const LOOKS = ["neon", "dawn"] as const;
type Look = (typeof LOOKS)[number];

/** `--name: R G B;` tokens of the first CSS rule that starts a line with `selector` (alone or first in a list). */
function cssTokens(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[[\]().*+?^$|\\]/g, "\\$&");
  const block = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no CSS block for ${selector}`);
  const tokens = new Map<string, string>();
  for (const m of block[1].matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    const hex = [m[2], m[3], m[4]].map((c) => Number(c).toString(16).padStart(2, "0")).join("");
    tokens.set(m[1], hex.toUpperCase());
  }
  return tokens;
}

const NEON_SELECTOR = ":root";
const DAWN_SELECTOR = ':root[data-theme="dawn"]';
const desktopCss = read(ROOT, "src", "app", "globals.css");
const phoneCss = read(ROOT, "public", "hunt-mobile.html");
const TOKENS: Record<"desktop" | "phone", Record<Look, Map<string, string>>> = {
  desktop: { neon: cssTokens(desktopCss, NEON_SELECTOR), dawn: cssTokens(desktopCss, DAWN_SELECTOR) },
  phone: { neon: cssTokens(phoneCss, NEON_SELECTOR), dawn: cssTokens(phoneCss, DAWN_SELECTOR) },
};

/** Widget colour role -> CSS token (and ARGB alpha byte), per look. `p-*` grounds exist only on the phone page. */
type Source = { token: string; alpha?: string };
const QUEST_KEYS = ["cyan", "emerald", "amber", "purple", "rose", "sky", "orange", "lime", "slate"];
const ROLES: Record<string, Record<Look, Source>> = {
  deep: { neon: { token: "p-0" }, dawn: { token: "p-0" } },
  ground: { neon: { token: "p-1" }, dawn: { token: "p-1" } },
  row: { neon: { token: "p-2" }, dawn: { token: "p-2" } },
  pressed: { neon: { token: "p-3" }, dawn: { token: "p-3" } },
  text: { neon: { token: "p-text" }, dawn: { token: "p-text" } },
  text_2: { neon: { token: "p-text-2" }, dawn: { token: "p-text-2" } },
  muted: { neon: { token: "p-muted" }, dawn: { token: "p-muted" } },
  dim: { neon: { token: "p-dim" }, dawn: { token: "p-dim" } },
  accent: { neon: { token: "c-accent" }, dawn: { token: "c-accent" } },
  success: { neon: { token: "c-success" }, dawn: { token: "c-success" } },
  ripple: { neon: { token: "c-accent", alpha: "33" }, dawn: { token: "c-accent", alpha: "33" } },
  // The widget's 1dp edge: Neon's cyan@25% ring stands in for its glow; Dawn has no glow, only a cream@7% hairline.
  outline: { neon: { token: "c-accent", alpha: "40" }, dawn: { token: "c-ink", alpha: "12" } },
  ...Object.fromEntries(
    QUEST_KEYS.map((k) => [`q_${k}`, { neon: { token: `q-${k}` }, dawn: { token: `q-${k}` } }]),
  ),
};

const colorsXml = read(RES, "values", "colors.xml");
const widgetColors = new Map(
  [...colorsXml.matchAll(/<color name="widget_(\w+?)_(\w+)">#([0-9A-Fa-f]{8})<\/color>/g)].map((m) => [
    `${m[1]}:${m[2]}`,
    m[3].toUpperCase(),
  ]),
);
const rolesOf = (look: Look) =>
  [...widgetColors.keys()].filter((k) => k.startsWith(`${look}:`)).map((k) => k.slice(look.length + 1)).sort();

describe("widget colours follow the CSS look tokens (ADR-0005)", () => {
  it("Neon and Dawn define the same colour roles, and every role has a token source", () => {
    expect(rolesOf("dawn")).toEqual(rolesOf("neon"));
    expect(rolesOf("neon")).toEqual(Object.keys(ROLES).sort());
  });

  for (const look of LOOKS) {
    it(`widget_${look}_* equals the phone page's ${look} tokens`, () => {
      for (const [role, sources] of Object.entries(ROLES)) {
        const { token, alpha = "FF" } = sources[look];
        const rgb = TOKENS.phone[look].get(token);
        expect(rgb, `--${token} in hunt-mobile.html (${look})`).toBeDefined();
        expect(widgetColors.get(`${look}:${role}`), `widget_${look}_${role}`).toBe(`${alpha}${rgb}`);
      }
    });

    it(`widget_${look}_* equals the desktop's ${look} tokens where the desktop has the token`, () => {
      let checked = 0;
      for (const [role, sources] of Object.entries(ROLES)) {
        const { token, alpha = "FF" } = sources[look];
        const rgb = TOKENS.desktop[look].get(token);
        if (token.startsWith("p-")) continue; // the phone page's own grounds
        expect(rgb, `--${token} in globals.css (${look})`).toBeDefined();
        expect(widgetColors.get(`${look}:${role}`), `widget_${look}_${role}`).toBe(`${alpha}${rgb}`);
        checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(QUEST_KEYS.length + 2);
    });
  }
});

/** `<Tag ...>` openings of a layout, in document order, as {tag, attrs}. */
function elements(xml: string): { tag: string; attrs: Map<string, string> }[] {
  const body = xml.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\?[\s\S]*?\?>/g, " ");
  return [...body.matchAll(/<([A-Za-z][\w.]*)\b([^>]*?)\/?>/g)].map((m) => ({
    tag: m[1],
    attrs: new Map([...m[2].matchAll(/([\w:]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
  }));
}
/** Attributes that decide where things sit and how big a target is; a look may change type and colour, not these. */
const GEOMETRY =
  /^(android:id|style|android:layout_\w+|android:min(Width|Height)|android:padding\w*|android:orientation|android:gravity|android:visibility|android:maxLines|android:ellipsize|android:max|android:divider\w*|android:src)$/;
const geometry = (xml: string) =>
  elements(xml).map(({ tag, attrs }) => ({
    tag,
    attrs: Object.fromEntries([...attrs].filter(([name]) => GEOMETRY.test(name))),
  }));

const twins = (dir: string) =>
  fs
    .readdirSync(path.join(RES, dir))
    .filter((f) => /^widget_\w+_neon\.xml$/.test(f))
    .map((f) => ({ neon: f, dawn: f.replace(/_neon\.xml$/, "_dawn.xml") }));

describe("every Neon widget resource has a Dawn twin", () => {
  it("covers the Day Widget, its row and message, the tick, and the Stats Widget", () => {
    expect(twins("layout").map((t) => t.neon)).toEqual(
      expect.arrayContaining([
        "widget_day_neon.xml",
        "widget_day_row_neon.xml",
        "widget_day_message_neon.xml",
        "widget_stats_neon.xml",
      ]),
    );
    expect(twins("drawable").map((t) => t.neon)).toEqual(
      expect.arrayContaining(["widget_tick_neon.xml", "widget_row_neon.xml"]),
    );
  });

  for (const dir of ["layout", "drawable"]) {
    for (const { neon, dawn } of twins(dir)) {
      it(`${dir}/${dawn} exists and only uses Dawn resources`, () => {
        expect(fs.existsSync(path.join(RES, dir, dawn)), `${dir}/${dawn}`).toBe(true);
        expect(read(RES, dir, dawn)).not.toMatch(/@(color|drawable|layout)\/\w*_neon\b/);
        expect(read(RES, dir, neon)).not.toMatch(/@(color|drawable|layout)\/\w*_dawn\b/);
      });
    }
  }

  for (const { neon, dawn } of twins("layout")) {
    it(`layout/${dawn} has the same view ids and geometry as ${neon}`, () => {
      const dawnXml = fs.existsSync(path.join(RES, "layout", dawn)) ? read(RES, "layout", dawn) : "";
      expect(geometry(dawnXml)).toEqual(geometry(read(RES, "layout", neon)));
    });
  }
});

/** Java with block and line comments removed (enough for these sources: no "//" in literals). */
const javaCode = (file: string): string =>
  read(JAVA_DIR, file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the widgets draw the snapshot's look", () => {
  const widgetJava = fs.readdirSync(JAVA_DIR).filter((f) => /Widget\w*\.java$/.test(f));
  const lookCode = javaCode("WidgetLook.java");

  it("only WidgetLook names a look's layouts and colours", () => {
    expect(widgetJava).toEqual(expect.arrayContaining(["DayWidgetProvider.java", "DayWidgetService.java", "StatsWidgetProvider.java"]));
    for (const file of widgetJava.filter((f) => f !== "WidgetLook.java")) {
      expect(javaCode(file), file).not.toMatch(/R\.(layout|color|drawable)\.widget_/);
    }
  });

  it("WidgetLook has a Dawn resource for every Neon one, and Dawn only for the exact look name", () => {
    const refs = new Set([...lookCode.matchAll(/R\.(?:layout|color)\.(widget_\w+)/g)].map((m) => m[1]));
    const neon = [...refs].filter((r) => /_neon\b|widget_neon_/.test(r));
    expect(neon).toEqual(
      expect.arrayContaining(["widget_day_neon", "widget_day_row_neon", "widget_day_message_neon", "widget_stats_neon"]),
    );
    for (const r of neon) expect(refs, `Dawn twin of ${r}`).toContain(r.replace("neon", "dawn"));
    for (const r of refs) expect(r, "every look resource is Neon or Dawn").toMatch(/neon|dawn/);
    expect(lookCode).toMatch(/"dawn"\.equals\(look\)/);
  });

  it("the Day Widget's list declares a view type per look, so a look change can swap row layouts", () => {
    const service = javaCode("DayWidgetService.java");
    const count = /int\s+getViewTypeCount\(\)\s*\{\s*return\s+([\w.]+)\s*;/.exec(service)?.[1];
    expect(count).toBe("WidgetLook.COUNT");
    expect(lookCode).toMatch(/static\s+final\s+int\s+COUNT\s*=\s*2\s*;/);
  });
});
