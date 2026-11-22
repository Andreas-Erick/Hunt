import React from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import tailwindConfig from "../../tailwind.config";
import { QUEST_ACCENT_KEYS } from "@/lib/domainTypes";
import { QUEST_ACCENT_STYLES, accentStyle } from "@/lib/questAccents";
import {
  dateFromKey,
  dateKeyFromOffset,
  formatChronoMMSS,
  formatTacticalDuration,
  toLocalDateKey,
} from "@/lib/dateUtils";
import {
  CONFIRM_DELETE_DISARM_MS,
  ConfirmDeleteButton,
  type ConfirmDeleteButtonProps,
} from "@/components/ConfirmDeleteButton";

/** Small deterministic PRNG (mulberry32) for the seeded fuzz loops. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// accentStyle (DUI-02)
// ---------------------------------------------------------------------------
describe("accentStyle()", () => {
  it.each([...QUEST_ACCENT_KEYS, "slate"] as const)("maps %s to its own style", (key) => {
    expect(accentStyle(key)).toBe(QUEST_ACCENT_STYLES[key]);
  });

  it.each([
    ["an unknown colour", "violet"],
    ["a differently cased key", "CYAN"],
    ["undefined", undefined],
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["a number", 5],
    ["an object", { hex: "#fff" }],
  ])("falls back to slate for %s", (_name, key) => {
    const style = accentStyle(key);
    expect(style).toBe(QUEST_ACCENT_STYLES.slate);
    expect(style.hex).toBe("#64748b");
  });
});

// ---------------------------------------------------------------------------
// DST-safe date helpers (DUI-V02 exports)
// ---------------------------------------------------------------------------
describe("dateFromKey() / dateKeyFromOffset() in Europe/Berlin", () => {
  const DAY_MS = 86_400_000;
  let savedTz: string | undefined;
  let savedZone = "UTC";

  beforeAll(() => {
    savedTz = process.env.TZ;
    savedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    process.env.TZ = "Europe/Berlin";
  });

  afterAll(() => {
    // Deleting TZ alone does not reset Node's zone cache (seen on Node 24 /
    // Windows), so assign the original zone first, then drop the variable.
    process.env.TZ = savedTz ?? savedZone;
    if (savedTz === undefined) delete process.env.TZ;
  });

  /** Calendar-day number of a YYYY-MM-DD key, computed in UTC (no DST). */
  function utcDayNumber(key: string): number {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / DAY_MS;
  }

  function utcKey(ms: number): string {
    const d = new Date(ms);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${d.getUTCFullYear()}-${mm}-${dd}`;
  }

  it("runs on a clock that really switches DST (guards against a no-op TZ)", () => {
    expect(new Date(2026, 2, 29, 1).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 2, 29, 4).getTimezoneOffset()).toBe(-120);
    expect(new Date(2026, 9, 25, 4).getTimezoneOffset()).toBe(-60);
  });

  it.each([
    { when: "00:30 on 2026-03-30 (after spring-forward)", y: 2026, m: 2, d: 30, h: 0, today: "2026-03-30" },
    { when: "00:30 on 2026-10-25 (fall-back day)", y: 2026, m: 9, d: 25, h: 0, today: "2026-10-25" },
    { when: "23:30 on 2026-10-25 (fall-back day)", y: 2026, m: 9, d: 25, h: 23, today: "2026-10-25" },
    { when: "23:30 on 2026-03-29 (spring-forward day)", y: 2026, m: 2, d: 29, h: 23, today: "2026-03-29" },
  ])("builds 7 distinct, consecutive day keys back from $when", ({ y, m, d, h, today }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(y, m, d, h, 30));

    const todayKey = toLocalDateKey(Date.now());
    expect(todayKey).toBe(today);
    const keys = Array.from({ length: 7 }, (_, i) => dateKeyFromOffset(todayKey, -i));

    expect(new Set(keys).size, keys.join(", ")).toBe(7);
    for (let i = 1; i < keys.length; i++) {
      expect(utcDayNumber(keys[i - 1]) - utcDayNumber(keys[i]), keys.join(", ")).toBe(1);
    }
    for (let i = 0; i < 7; i++) {
      expect(dateKeyFromOffset(keys[6], i)).toBe(keys[6 - i]);
    }
  });

  it("is needed: fixed 24 h steps skip or repeat a day around these DST changes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 30, 0, 30));
    expect(toLocalDateKey(Date.now() - DAY_MS)).toBe("2026-03-28");
    expect(dateKeyFromOffset(toLocalDateKey(Date.now()), -1)).toBe("2026-03-29");

    vi.setSystemTime(new Date(2026, 9, 25, 23, 30));
    expect(toLocalDateKey(Date.now() - DAY_MS)).toBe("2026-10-25");
    expect(dateKeyFromOffset(toLocalDateKey(Date.now()), -1)).toBe("2026-10-24");
  });

  it("anchors dateFromKey at local noon on the requested calendar day", () => {
    for (const key of ["2026-03-29", "2026-10-25", "2028-02-29"]) {
      const date = dateFromKey(key);
      expect(date.getHours()).toBe(12);
      expect(toLocalDateKey(date.getTime())).toBe(key);
    }
    expect(toLocalDateKey(dateFromKey("2026-03-29", 1).getTime())).toBe("2026-03-30");
  });

  it("handles leap days, month ends and year boundaries", () => {
    expect(dateKeyFromOffset("2028-02-29", 1)).toBe("2028-03-01");
    expect(dateKeyFromOffset("2028-02-29", -1)).toBe("2028-02-28");
    expect(dateKeyFromOffset("2028-02-28", 1)).toBe("2028-02-29");
    expect(dateKeyFromOffset("2028-03-01", -1)).toBe("2028-02-29");
    expect(dateKeyFromOffset("2027-02-28", 1)).toBe("2027-03-01");
    expect(dateKeyFromOffset("2027-12-31", 1)).toBe("2028-01-01");
    expect(dateKeyFromOffset("2028-01-01", -1)).toBe("2027-12-31");
    expect(dateKeyFromOffset("2024-01-01", 366)).toBe("2025-01-01");
    expect(dateKeyFromOffset("2026-03-29", 0)).toBe("2026-03-29");
  });

  it("round-trips every day of 2024-2028 and steps exactly one day at a time", () => {
    const first = Date.UTC(2024, 0, 1);
    const last = Date.UTC(2028, 11, 31);
    let previous: string | null = null;
    let days = 0;
    for (let ms = first; ms <= last; ms += DAY_MS) {
      const key = utcKey(ms);
      expect(dateKeyFromOffset(key, 0), key).toBe(key);
      if (previous !== null) expect(dateKeyFromOffset(previous, 1), previous).toBe(key);
      previous = key;
      days++;
    }
    expect(days).toBe(366 + 365 + 365 + 365 + 366);
  });

  it("handles midnight rollovers", () => {
    const beforeMidnight = new Date(2026, 9, 25, 23, 59, 59, 999).getTime();
    expect(toLocalDateKey(beforeMidnight)).toBe("2026-10-25");
    expect(toLocalDateKey(beforeMidnight + 1)).toBe("2026-10-26");
    expect(dateKeyFromOffset(toLocalDateKey(beforeMidnight), 1)).toBe(
      toLocalDateKey(beforeMidnight + 1)
    );
  });
});

// ---------------------------------------------------------------------------
// Formatter guards (ARC-10)
// ---------------------------------------------------------------------------
describe("formatChronoMMSS() / formatTacticalDuration() boundary matrix", () => {
  const BAD_TEXT = /NaN|Infinity|undefined/;
  const BOUNDARY_SECONDS: Array<[string, unknown, string, string]> = [
    ["0", 0, "00:00", "0s"],
    ["-1", -1, "00:00", "0s"],
    ["NaN", NaN, "00:00", "0s"],
    ["Infinity", Infinity, "00:00", "0s"],
    ["-Infinity", -Infinity, "00:00", "0s"],
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER, "2501999792983:36:31", "2501999792983h 36m"],
    ["0.1 + 0.2", 0.1 + 0.2, "00:00", "0s"],
    ["'120' (string from a bad row)", "120", "02:00", "2m 00s"],
  ];

  it.each(BOUNDARY_SECONDS)("formatChronoMMSS(%s)", (_name, input, chrono) => {
    const res = formatChronoMMSS(input as number);
    expect(JSON.stringify(res)).not.toMatch(BAD_TEXT);
    expect(res.formatted).toBe(chrono);
  });

  it.each(BOUNDARY_SECONDS)("formatTacticalDuration(%s)", (_name, input, _chrono, tactical) => {
    const out = formatTacticalDuration(input as number);
    expect(out).not.toMatch(BAD_TEXT);
    expect(out).toBe(tactical);
  });

  it("never renders NaN/Infinity and parses back to the clamped whole seconds (seeded fuzz)", () => {
    const seed = 0x5eed04;
    const rand = mulberry32(seed);
    const specials = [NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER, Number.MIN_VALUE];
    for (let i = 0; i < 500; i++) {
      const roll = rand();
      const input =
        roll < 0.1
          ? specials[Math.floor(rand() * specials.length)]
          : roll < 0.4
          ? (rand() - 0.5) * 1e6
          : rand() * 10 ** Math.floor(rand() * 13);
      const msg = `seed=${seed} i=${i} input=${input}`;
      const chrono = formatChronoMMSS(input).formatted;
      const tactical = formatTacticalDuration(input);
      expect(chrono, msg).not.toMatch(BAD_TEXT);
      expect(tactical, msg).not.toMatch(BAD_TEXT);
      expect(chrono, msg).toMatch(/^(?:\d+:\d{2}|\d{2}):\d{2}$/);
      expect(tactical, msg).toMatch(/^(?:\d+h \d{2}m|\d+m \d{2}s|\d+s)$/);

      const expected = Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0;
      const parts = chrono.split(":").map(Number);
      const parsed =
        parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      expect(parsed, msg).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// ConfirmDeleteButton (DIX-01)
// ---------------------------------------------------------------------------
describe("ConfirmDeleteButton", () => {
  function renderButton(props: Partial<ConfirmDeleteButtonProps> = {}) {
    const onConfirm = props.onConfirm ?? vi.fn();
    const onRowClick = vi.fn();
    const utils = render(
      <div onClick={onRowClick}>
        <ConfirmDeleteButton label="Delete task" {...props} onConfirm={onConfirm}>
          <svg aria-hidden="true" />
          <span>Delete</span>
        </ConfirmDeleteButton>
      </div>
    );
    const button = () => screen.getByRole("button");
    return { ...utils, onConfirm, onRowClick, button };
  }

  function useTimers() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  it("renders a native button named by `label` while idle", () => {
    const { button } = renderButton();
    expect(button().tagName).toBe("BUTTON");
    expect(button()).toHaveAttribute("type", "button");
    expect(button()).toHaveAccessibleName("Delete task");
    expect(button()).toHaveAttribute("data-state", "idle");
    expect(button()).toHaveTextContent("Delete");
  });

  it("arms on the first click without deleting, and announces the confirm label", () => {
    const { button, onConfirm, onRowClick } = renderButton();
    fireEvent.click(button(), { detail: 1 });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirm delete?" })).toBe(button());
    expect(button()).toHaveAttribute("data-state", "armed");
    const live = button().querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Confirm delete?");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("calls onConfirm exactly once on a second, separate click, then disarms", () => {
    const { button, onConfirm, onRowClick } = renderButton();
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 1 });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button()).toHaveAccessibleName("Delete task");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("confirms with keyboard activation (click detail 0)", () => {
    const { button, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 0 });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(button(), { detail: 0 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("ignores the second click of a double-click while armed", () => {
    const { button, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 2 });
    fireEvent.click(button(), { detail: 3 });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(button()).toHaveAccessibleName("Confirm delete?");

    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("produces exactly one call for 10 clicks in one tick after arming", async () => {
    const { button, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 1 });
    for (let i = 0; i < 10; i++) fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {});
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button()).toHaveAccessibleName("Delete task");

    // Usable again afterwards: it needs a fresh two-step confirm.
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("ignores activations while an async onConfirm is pending", async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const { button } = renderButton({ onConfirm });
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {});
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button()).toHaveAccessibleName("Delete task");

    await act(async () => finish());
    fireEvent.click(button(), { detail: 1 });
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("disk full"))],
    [
      "throws",
      () => {
        throw new Error("boom");
      },
    ],
  ])("logs and recovers when onConfirm %s", async (_name, impl) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onConfirm = vi.fn(impl);
    const { button } = renderButton({ onConfirm });
    fireEvent.click(button(), { detail: 1 });
    expect(() => fireEvent.click(button(), { detail: 1 })).not.toThrow();
    await act(async () => {});

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("Confirmed delete failed:", expect.any(Error));
    fireEvent.click(button(), { detail: 1 });
    expect(button()).toHaveAccessibleName("Confirm delete?");
  });

  it(`disarms after ${CONFIRM_DELETE_DISARM_MS} ms without a confirming click`, () => {
    useTimers();
    const { button, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 1 });

    act(() => {
      vi.advanceTimersByTime(CONFIRM_DELETE_DISARM_MS - 1);
    });
    expect(button()).toHaveAccessibleName("Confirm delete?");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button()).toHaveAccessibleName("Delete task");
    expect(vi.getTimerCount()).toBe(0);

    // The next click only re-arms.
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button()).toHaveAccessibleName("Confirm delete?");
  });

  it("honours a custom disarmAfterMs and confirmLabel", () => {
    useTimers();
    const { button } = renderButton({ disarmAfterMs: 1000, confirmLabel: "Delete quest and move 3 tasks?" });
    fireEvent.click(button(), { detail: 1 });
    expect(button()).toHaveAccessibleName("Delete quest and move 3 tasks?");
    expect(button()).toHaveTextContent("Delete quest and move 3 tasks?");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(button()).toHaveAccessibleName("Delete task");
  });

  it("disarms on Escape without letting it reach window shortcuts; idle Escape passes through", () => {
    useTimers();
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      const { button, onConfirm } = renderButton();
      fireEvent.click(button(), { detail: 1 });
      fireEvent.keyDown(button(), { key: "Escape" });

      expect(button()).toHaveAccessibleName("Delete task");
      expect(windowKeys).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.keyDown(button(), { key: "Escape" });
      expect(windowKeys).toHaveBeenCalledTimes(1);

      fireEvent.click(button(), { detail: 1 });
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("disarms on blur", () => {
    useTimers();
    const { button, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 1 });
    fireEvent.blur(button());

    expect(button()).toHaveAccessibleName("Delete task");
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(button(), { detail: 1 });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("blocks a held Enter key's auto-repeat from confirming", () => {
    const { button } = renderButton();
    expect(fireEvent.keyDown(button(), { key: "Enter", repeat: true })).toBe(false);
    expect(fireEvent.keyDown(button(), { key: "Enter" })).toBe(true);
  });

  it("leaves no timer behind when unmounted while armed", () => {
    useTimers();
    const { button, unmount, onConfirm } = renderButton();
    fireEvent.click(button(), { detail: 1 });
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(CONFIRM_DELETE_DISARM_MS * 2);
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("matches a reference model over a seeded random sequence of user actions", async () => {
    useTimers();
    const seed = 0xd1501;
    const rand = mulberry32(seed);
    const { button, onConfirm } = renderButton();
    // Reference model: armed flag plus the time spent armed.
    let armed = false;
    let armedForMs = 0;
    let expectedCalls = 0;
    for (let step = 0; step < 300; step++) {
      const roll = rand();
      let action: string;
      if (roll < 0.45) {
        const detail = rand() < 0.25 ? 2 : 1;
        action = `click(detail=${detail})`;
        fireEvent.click(button(), { detail });
        if (!armed) {
          armed = true;
          armedForMs = 0;
        } else if (detail === 1) {
          expectedCalls++;
          armed = false;
        }
      } else if (roll < 0.6) {
        action = "Escape";
        fireEvent.keyDown(button(), { key: "Escape" });
        armed = false;
      } else if (roll < 0.7) {
        action = "blur";
        fireEvent.blur(button());
        armed = false;
      } else {
        const ms = Math.floor(rand() * 3000);
        action = `wait(${ms})`;
        act(() => {
          vi.advanceTimersByTime(ms);
        });
        armedForMs += ms;
        if (armed && armedForMs >= CONFIRM_DELETE_DISARM_MS) armed = false;
      }
      await act(async () => {});
      const msg = `seed=${seed} step=${step} action=${action}`;
      expect(onConfirm, msg).toHaveBeenCalledTimes(expectedCalls);
      expect(button().getAttribute("data-state"), msg).toBe(armed ? "armed" : "idle");
    }
    expect(expectedCalls, `seed=${seed}`).toBeGreaterThan(0);
  });

  it("carries the shared interaction affordances and the caller's classes", () => {
    const { button } = renderButton({ className: "text-neutral-500 px-2" });
    const classes = button().className.split(/\s+/);
    for (const cls of [
      "transition-colors",
      "duration-150",
      "active:opacity-80",
      "focus-visible:opacity-100",
      "text-neutral-500",
      "px-2",
    ]) {
      expect(classes).toContain(cls);
    }
    fireEvent.click(button(), { detail: 1 });
    const live = button().querySelector('[aria-live="polite"]');
    expect(live?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["text-hud-crimson", "font-medium"])
    );
  });
});

// ---------------------------------------------------------------------------
// Tailwind config: content globs (DUI-V01) and the muted token (DIX-08)
// ---------------------------------------------------------------------------
describe("tailwind.config.ts", () => {
  function hexChannelToLinear(hex: string, offset: number): number {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  /** WCAG 2.x relative luminance of a #rrggbb colour. */
  function relativeLuminance(color: string): number {
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`not a #rrggbb colour: ${color}`);
    return (
      0.2126 * hexChannelToLinear(color, 1) +
      0.7152 * hexChannelToLinear(color, 3) +
      0.0722 * hexChannelToLinear(color, 5)
    );
  }

  function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  function hudColor(name: string): string {
    const colors: unknown = tailwindConfig.theme?.extend?.colors;
    const hud = isRecord(colors) ? colors.hud : undefined;
    const value = isRecord(hud) ? hud[name] : undefined;
    if (typeof value !== "string") throw new Error(`hud.${name} is not defined`);
    return value;
  }

  function contentGlobs(): string[] {
    const content = tailwindConfig.content;
    const entries: unknown[] = Array.isArray(content) ? content : content.files;
    return entries.filter((g): g is string => typeof g === "string");
  }

  it("has a WCAG helper that reproduces known ratios", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it.each(["#0b0c0e", "#111318", "#0d0f14", "#14171f"])(
    "hud.muted reads at >= 4.5:1 on %s",
    (surface) => {
      const ratio = contrastRatio(hudColor("muted"), surface);
      expect(ratio, `${hudColor("muted")} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  );

  it.each(["#0b0c0e", "#111318", "#0d0f14", "#14171f", "#05070a"])(
    "all 8 quest accent colours read at >= 4.5:1 WCAG AA on %s",
    (surface) => {
      for (const key of QUEST_ACCENT_KEYS) {
        const hex = QUEST_ACCENT_STYLES[key].hex;
        const ratio = contrastRatio(hex, surface);
        expect(ratio, `${key} (${hex}) on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
        expect(hudColor(key)).toBe(hex);
      }
    }
  );

  it("includes a content glob covering src/lib", () => {
    expect(contentGlobs()).toContain("./src/lib/**/*.{js,ts,jsx,tsx,mdx}");
  });

  it("generates the accent classes that only QUEST_ACCENT_STYLES uses", async () => {
    const libGlobs = contentGlobs().filter((g) => g.includes("src/lib/"));
    expect(libGlobs.length).toBeGreaterThan(0);

    const result = await postcss([
      tailwindcss({ ...tailwindConfig, content: libGlobs, corePlugins: { preflight: false } }),
    ]).process("@tailwind utilities;", { from: undefined });

    for (const selector of [
      ".bg-slate-500",
      ".border-\\[\\#00f0ff\\]\\/40",
      ".border-\\[\\#00ff9d\\]\\/40",
      ".border-\\[\\#b388ff\\]\\/40",
      ".border-\\[\\#ff6b9d\\]\\/40",
      ".border-\\[\\#38bdf8\\]\\/40",
      ".border-\\[\\#ff8547\\]\\/40",
      ".border-\\[\\#a3e635\\]\\/40",
      ".bg-neutral-500",
    ]) {
      expect(result.css).toContain(`${selector} {`);
    }
  });
});
