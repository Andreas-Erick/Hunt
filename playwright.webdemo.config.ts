import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke test of the static browser demo (ADR-0010): `npm run test:web-demo`.
 *
 * Builds the export (`npm run build:web`, base path /demos/hunt) and serves out/ with the
 * same static server as `npm run preview:web`: its root is a host page that embeds the demo
 * in an iframe, as a portfolio site would.
 */
const PORT = 4174;

export default defineConfig({
  testDir: "e2e-web",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report-web" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "en-US",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build:web && node scripts/serve-web-demo.mjs --port ${PORT}`,
    url: `http://localhost:${PORT}/demos/hunt/`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    env: { HUNT_WEB_BASE_PATH: "/demos/hunt", NEXT_TELEMETRY_DISABLED: "1" },
  },
});
