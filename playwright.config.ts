import os from "os";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser layout ("geometry") smoke suite: `npm run test:geometry`.
 *
 * jsdom (vitest) has no layout engine, so overflow and off-screen popovers can
 * only be caught here. The web server builds the app into its own dist folder
 * (HUNT_DIST_DIR) and keeps sync data in a throwaway directory (HUNT_DATA_DIR),
 * so a local run never touches the .next build or the data/ folder of a Hunt
 * server that is already running.
 */
const PORT = 3100;
const DATA_DIR = path.join(os.tmpdir(), "hunt-geometry-data");

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Fixtures compute their date keys in UTC; the browser must agree.
    timezoneId: "UTC",
    locale: "en-US",
    // Resting layout is what is measured; entrance animations only add flake.
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/hunt-mobile.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      HUNT_DIST_DIR: ".next/geometry",
      HUNT_DATA_DIR: DATA_DIR,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
