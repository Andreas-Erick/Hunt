/**
 * Browser demo build (`npm run build:web`, ADR-0010). HUNT_WEB_DEMO=1 turns the app into a
 * static export served under HUNT_WEB_BASE_PATH: no server, no API routes, demo platform.
 */
const WEB_DEMO = process.env.HUNT_WEB_DEMO === "1";

/** `/demos/hunt` by default; "" or "/" serves from the site root. No trailing slash. */
function webBasePath() {
  const raw = (process.env.HUNT_WEB_BASE_PATH ?? "/demos/hunt").trim().replace(/\/+$/, "");
  if (raw === "") return "";
  if (!raw.startsWith("/")) throw new Error(`HUNT_WEB_BASE_PATH must start with "/" (got "${raw}")`);
  return raw;
}

const webDemoConfig = WEB_DEMO
  ? {
      output: "export",
      basePath: webBasePath(),
      // Next 16 writes a static export into distDir itself. out/ keeps it apart from the .next
      // build a local Hunt server is serving.
      distDir: "out",
      // `/demos/hunt/` loads index.html on every static host, with or without the slash.
      trailingSlash: true,
      // Only .tsx/.jsx files are routes: drops src/app/api/*/route.ts (sync hub, window control) and
      // the PWA manifest, none of which a static demo can serve.
      // Two entries: Next passes a one-entry list to its app loader as a string and fails.
      pageExtensions: ["tsx", "jsx"],
      env: {
        NEXT_PUBLIC_HUNT_DEMO: "1",
        NEXT_PUBLIC_HUNT_BASE_PATH: webBasePath(),
      },
    }
  : {};

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app never uses next/image; disabling the optimizer turns off the /_next/image
  // endpoint and its image-optimizer advisories on the LAN-exposed server.
  images: { unoptimized: true },
  // Enabled only by the GitHub Release desktop packager so local `next start` is unchanged.
  ...(process.env.HUNT_STANDALONE === "1" ? { output: "standalone" } : {}),
  // Set only by the Playwright geometry suite (playwright.config.ts): it builds into its own
  // folder so it never overwrites the .next build a running local Hunt server is serving.
  ...(process.env.HUNT_DIST_DIR ? { distDir: process.env.HUNT_DIST_DIR } : {}),
  ...webDemoConfig,
  // Static exports have no server to send headers; the native server keeps its cache rule.
  ...(WEB_DEMO
    ? {}
    : {
        async headers() {
          return [
            {
              source: "/(favicon\\.ico|hunt-logo\\.png)",
              headers: [
                {
                  key: "Cache-Control",
                  value: "no-cache, must-revalidate",
                },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
