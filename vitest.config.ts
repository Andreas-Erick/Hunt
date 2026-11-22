import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    cache: false,
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Playwright suites, not vitest tests: e2e/ (npm run test:geometry) and scripts/screenshots/ (npm run screenshots).
    exclude: [...configDefaults.exclude, "e2e/**", "scripts/screenshots/**", ".claude/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
