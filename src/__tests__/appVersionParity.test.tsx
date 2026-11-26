// The app version shown in the UI matches package.json, the Android manifest and the installer.
import fs from "fs";
import path from "path";
import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { APP_VERSION } from "@/lib/version";
import { TopTelemetryBar } from "@/components/TopTelemetryBar";
import { MobileSyncModal } from "@/components/MobileSyncModal";
import { loadMobile, pageErrors } from "./helpers/loadMobile";
import { ROOT, resetStoreAroundEachTest } from "./helpers/storeFixtures";

resetStoreAroundEachTest();

// ---------------------------------------------------------------------------
// 2. App Version Display & Cross-File Sync
// ---------------------------------------------------------------------------
describe("App version v1.16.0 display & cross-artifact parity", () => {
  it("keeps APP_VERSION synchronized across package.json, installer, AndroidManifest, and hunt-mobile.html", () => {
    expect(APP_VERSION).toBe("1.16.0");

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      version: string;
    };
    expect(pkg.version).toBe(APP_VERSION);

    const iss = fs.readFileSync(path.join(ROOT, "installer", "hunt-desktop.iss"), "utf8");
    expect(iss).toContain(`#define AppVersion "${APP_VERSION}"`);

    const androidManifest = fs.readFileSync(
      path.join(ROOT, "android-app", "app", "src", "main", "AndroidManifest.xml"),
      "utf8"
    );
    expect(androidManifest).toContain(`android:versionName="${APP_VERSION}"`);

    const mobileHtml = fs.readFileSync(path.join(ROOT, "public", "hunt-mobile.html"), "utf8");
    expect(mobileHtml).toMatch(new RegExp(`const\\s+APP_VERSION\\s*=\\s*['"]${APP_VERSION}['"]`));
  });

  it("displays v1.16.0 in Desktop TopTelemetryBar, MobileSyncModal, and Mobile/Tablet header + Sync sheet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            primaryUrl: "http://192.168.1.50:3000",
            urls: ["http://192.168.1.50:3000"],
          }),
        }) as unknown as Response
      )
    );

    const bar = render(<TopTelemetryBar />);
    expect(screen.getByTestId("app-version").textContent).toBe(`v${APP_VERSION}`);
    const logoSvg = screen.getByTestId("hunt-logo");
    expect(logoSvg.querySelector("circle")?.getAttribute("fill")).toBe("#e5aa50");
    expect(logoSvg.innerHTML).not.toContain("23.62,16.89");
    bar.unmount();

    const iconSvg = fs.readFileSync(path.join(ROOT, "src", "app", "icon.svg"), "utf8");
    expect(iconSvg).toContain('fill="url(#gold)"');
    expect(iconSvg).not.toContain("290.8,172.9");

    await act(async () => {
      render(<MobileSyncModal isOpen={true} onClose={() => undefined} />);
    });
    expect(screen.getByTestId("sync-modal-app-version").textContent).toBe(`v${APP_VERSION}`);
    expect(screen.getAllByText(/phone or tablet/i).length).toBeGreaterThanOrEqual(2);

    const w = loadMobile();
    try {
      const badge = w.document.getElementById("headerVersionBadge");
      expect(badge?.textContent).toBe(`v${APP_VERSION}`);
      w.openSyncSheet();
      expect(w.document.getElementById("sheetContainer")?.textContent).toContain(`v${APP_VERSION}`);
      expect(pageErrors(w)).toEqual([]);
    } finally {
      w.close();
    }
  });
});
