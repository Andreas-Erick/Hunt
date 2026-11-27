/**
 * The browser demo build (ADR-0010). `npm run build:web` sets NEXT_PUBLIC_HUNT_DEMO=1, which
 * Next inlines at build time, so every `IS_WEB_DEMO` branch folds away in the native bundle
 * and the native-only code folds away in the demo. A leaf module: it imports nothing, so
 * db.ts and the platform modules can all read it without an import cycle.
 */
export const IS_WEB_DEMO = process.env.NEXT_PUBLIC_HUNT_DEMO === "1";

/** Where the demo banner and its stand-ins send people for the real app. */
export const RELEASES_URL = "https://github.com/Andreas-Erick/Hunt/releases";

/**
 * The demo's own IndexedDB name. The demo is served from someone else's site (a portfolio
 * under a sub-path), so it never opens the native app's `JourneyCommandDB` by name.
 */
export const DEMO_DATABASE_NAME = "HuntWebDemo";

/** The native app's IndexedDB name (unchanged since the first release). */
export const NATIVE_DATABASE_NAME = "JourneyCommandDB";
