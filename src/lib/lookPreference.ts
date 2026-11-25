/**
 * The look this device shows (ADR-0005): "neon" (the original palette) or
 * "dawn". Per device, never synced. Applied as `data-theme` on <html>; the
 * tokens in globals.css do the rest.
 */
export type Look = "neon" | "dawn";

export const LOOKS: readonly Look[] = ["neon", "dawn"];
export const DEFAULT_LOOK: Look = "neon";
export const LOOK_STORAGE_KEY = "hunt-look";

/** Page ground per look, for the browser's theme-color. */
export const LOOK_THEME_COLOR: Record<Look, string> = {
  neon: "#0b0c0e",
  dawn: "#101826",
};

export const LOOK_LABEL: Record<Look, string> = {
  neon: "Neon",
  dawn: "Dawn",
};

export function isLook(value: unknown): value is Look {
  return value === "neon" || value === "dawn";
}

export function readLook(): Look {
  try {
    const stored = window.localStorage.getItem(LOOK_STORAGE_KEY);
    return isLook(stored) ? stored : DEFAULT_LOOK;
  } catch {
    // Storage blocked (private mode, policy): the default look is a safe answer.
    return DEFAULT_LOOK;
  }
}

export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = look;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = LOOK_THEME_COLOR[look];
}

/** Applies the look and remembers it. Returns false when it could not be saved. */
export function saveLook(look: Look): boolean {
  applyLook(look);
  try {
    window.localStorage.setItem(LOOK_STORAGE_KEY, look);
    return true;
  } catch {
    // Storage blocked: the look still applies for this visit; the caller says it won't be kept.
    return false;
  }
}

/**
 * Runs in the document head before first paint, so a Dawn device never
 * flashes Neon. Kept dependency-free: it is inlined as a string. Blocked
 * storage leaves the default look, which the app then applies itself.
 */
export const LOOK_BOOT_SCRIPT = `(function(){try{var l=localStorage.getItem(${JSON.stringify(
  LOOK_STORAGE_KEY
)});if(l==="neon"||l==="dawn"){document.documentElement.dataset.theme=l;}}catch(e){/* default look */}})();`;
