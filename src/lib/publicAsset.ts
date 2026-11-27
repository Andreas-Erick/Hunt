/**
 * URL of a file in public/. Next adds its basePath to scripts, styles and fonts but not to
 * hand-written paths such as metadata icons, so those go through here. Empty for the native
 * app (served at `/`); the browser demo build sets it from HUNT_WEB_BASE_PATH (ADR-0010).
 */
export const PUBLIC_BASE_PATH = process.env.NEXT_PUBLIC_HUNT_BASE_PATH ?? "";

/** `publicAssetUrl("/hunt-logo.png")` → `/hunt-logo.png`, or `/demos/hunt/hunt-logo.png` in the demo. */
export function publicAssetUrl(pathFromRoot: string): string {
  return `${PUBLIC_BASE_PATH}${pathFromRoot}`;
}
