import os from "os";
import path from "path";
import { defineConfig, devices } from "@playwright/test";

/**
 * README screenshots: `npm run screenshots` rewrites docs/screenshots/*.png from the
 * current build with demo data (scripts/screenshots/). Uses the same isolated build
 * folder and throwaway data dir as the geometry suite, so it never touches data/.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "scripts/screenshots",
  workers: 1,
  reporter: "list",
  timeout: 120_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    reducedMotion: "reduce",
  },
  webServer: {
    command: `npm run build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/hunt-mobile.html`,
    reuseExistingServer: true,
    timeout: 300_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      HUNT_DIST_DIR: ".next/geometry",
      HUNT_DATA_DIR: path.join(os.tmpdir(), "hunt-screenshot-data"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
