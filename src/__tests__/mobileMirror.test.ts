// @vitest-environment node
//
// The phone page ships twice: inside the APK (android-app asset) and as the browser copy the
// laptop serves (public/). Both must be the very same bytes, or the two phones run different code.
// build-apk.sh enforces the same rule before it packages an APK.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const ASSET_PAGE = path.join(ROOT, "android-app", "app", "src", "main", "assets", "hunt-mobile.html");
const PUBLIC_PAGE = path.join(ROOT, "public", "hunt-mobile.html");

describe("hunt-mobile.html mirror", () => {
  it("the android asset and public/hunt-mobile.html are byte-identical", () => {
    const asset = fs.readFileSync(ASSET_PAGE);
    const served = fs.readFileSync(PUBLIC_PAGE);
    expect(asset.length).toBeGreaterThan(0);
    expect(
      asset.equals(served),
      `public/hunt-mobile.html (${served.length} bytes) differs from the asset (${asset.length} bytes); copy the asset over it`,
    ).toBe(true);
  });
});
