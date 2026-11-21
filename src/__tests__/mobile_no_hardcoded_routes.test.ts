// @vitest-environment node
// Phone page + Android shell: no laptop address is built in. The routes are only the paired / pasted /
// typed address, the route that answered last (syncMeta.lastUrl), (browser copy) the page's own
// origin and the LAN / Tailscale addresses the laptop advertised. An unpaired phone sends nothing and
// shows the "Not paired" state.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAPTOP_URL_KEY,
  MOBILE_ASSET_PATH,
  SYNC_META_KEY,
  loadMobile,
  mobileHtml,
  pageErrors,
  type AndroidBridgeStub,
  type FakeResponse,
  type FetchInit,
  type MobileWindow,
} from "./helpers/loadMobile";

const NOW = new Date("2026-11-18T10:00:00Z").getTime();
const JAVA_PATH = path.resolve(__dirname, "..", "..", "android-app", "app", "src", "main", "java", "com", "hunt", "companion", "MainActivity.java");
const PUBLIC_COPY = path.resolve(__dirname, "..", "..", "public", "hunt-mobile.html");
/** An http(s) URL whose host is an IPv4 literal, e.g. a laptop address baked into the sources. */
const IPV4_URL = /https?:\/\/\d{1,3}(?:\.\d{1,3}){3}/g;
/** Where the APK loads the page (no http origin to fall back to). */
const APK_PAGE = "file:///android_asset/hunt-mobile.html";

let w: MobileWindow | null = null;
function load(options: Parameters<typeof loadMobile>[0] = {}): MobileWindow {
  w = loadMobile(options);
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  w?.close();
  w = null;
  vi.useRealTimers();
});

function apkBridge(laptopUrl: string) {
  const syncs: string[][] = [];
  const bridge: AndroidBridgeStub = {
    loadState: () => "",
    saveState: () => undefined,
    getLaptopUrl: () => laptopUrl,
    saveLaptopUrl: () => undefined,
    saveSyncToken: () => true,
    syncWithLaptopAsync: (_id, candidatesJson) => {
      const parsed: unknown = JSON.parse(candidatesJson);
      syncs.push(Array.isArray(parsed) ? parsed.map(String) : []);
      return true;
    },
  };
  return { bridge, syncs };
}

/** Records every fetch; each one fails like an unreachable host, so every candidate is tried. */
function fetchRecorder() {
  const urls: string[] = [];
  const impl = (url: string, init?: FetchInit): Promise<FakeResponse> => {
    void init;
    urls.push(url);
    return Promise.reject(new Error("unreachable"));
  };
  return { urls, impl };
}

describe("phone: no built-in laptop address", () => {
  it("the page and the shell carry no IPv4 laptop URL literal", () => {
    expect(mobileHtml().match(IPV4_URL)).toBeNull();
    expect(readFileSync(JAVA_PATH, "utf8").match(IPV4_URL)).toBeNull();
    expect(readFileSync(JAVA_PATH, "utf8")).not.toMatch(/DEFAULT_LAPTOP_URL/);
    expect(readFileSync(PUBLIC_COPY, "utf8")).toBe(readFileSync(MOBILE_ASSET_PATH, "utf8"));
  });

  it("unpaired APK: no sync request is handed to native, the sheet shows Not paired with a generic hint", async () => {
    const b = apkBridge("");
    const p = load({ url: APK_PAGE, bridge: b.bridge });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.syncs).toEqual([]);
    expect(p.getSyncStatus().lastError).toBe("auth");
    expect(await p.syncNow()).toMatchObject({ ok: false, reason: "auth", attempts: [] });
    expect(b.syncs).toEqual([]);

    p.openSyncSheet();
    expect(p.document.getElementById("syncStatusCard")?.textContent).toContain("Not paired, or the key was rejected");
    const input = p.document.getElementById("modalLaptopUrl");
    if (!(input instanceof p.HTMLInputElement)) throw new Error("no address field");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Pairing link or http://<laptop-ip>:3000");
    expect(p.document.querySelectorAll("#syncRoutePills .route-pill")).toHaveLength(0);
    expect(pageErrors(p)).toEqual([]);
  });

  it("unpaired older shell (no async bridge, fetch transport) never calls fetch either", async () => {
    const net = fetchRecorder();
    const p = load({ url: APK_PAGE, bridge: { loadState: () => "", saveState: () => undefined, getLaptopUrl: () => "" }, fetchImpl: net.impl });
    await vi.advanceTimersByTimeAsync(60_000);
    await p.syncNow();
    expect(net.urls).toEqual([]);
  });

  it("paired APK: the candidates are exactly the saved address and the advertised routes", async () => {
    const b = apkBridge("http://192.168.1.5:3000");
    const p = load({
      bridge: b.bridge,
      storage: { [SYNC_META_KEY]: JSON.stringify({ lanUrls: ["http://192.168.1.5:3000", "http://100.64.1.2:3000"] }) },
    });
    void p.syncNow();
    expect(b.syncs.at(-1)).toEqual(["http://192.168.1.5:3000", "http://100.64.1.2:3000"]);

    p.openSyncSheet();
    const pills = Array.from(p.document.querySelectorAll("#syncRoutePills .route-pill")).map((el) => el.getAttribute("aria-label") ?? "");
    expect(pills).toHaveLength(2);
    expect(pills.join(" | ")).not.toMatch(/Home Wi-Fi/);
  });

  it("browser copy: only its own origin and the saved address are tried", async () => {
    const net = fetchRecorder();
    const p = load({ url: "http://192.168.1.5:3000/hunt-mobile.html", storage: { [LAPTOP_URL_KEY]: "http://10.0.0.7:3000" }, fetchImpl: net.impl });
    await p.syncNow();
    const hosts = new Set(net.urls.map((u) => new URL(u).origin));
    expect([...hosts].sort()).toEqual(["http://10.0.0.7:3000", "http://192.168.1.5:3000"]);
  });

  it("the address hints name a placeholder, not a real laptop", () => {
    const p = load({ url: APK_PAGE, bridge: apkBridge("").bridge });
    p.openSyncSheet();
    expect(p.applyLaptopUrlInput("")).toBe(false);
    expect(p.document.getElementById("syncUrlHint")?.textContent).toBe(
      "Paste the pairing link from the laptop's Phone & Sync window, or enter its address, for example http://<laptop-ip>:3000"
    );
    expect(p.applyLaptopUrlInput("not a url at all")).toBe(false);
    expect(p.document.getElementById("syncUrlHint")?.textContent).toBe("That doesn't look like an address or a pairing link. Try http://<laptop-ip>:3000");
  });
});

describe("MainActivity.java: an unpaired shell sends nothing", () => {
  const java = readFileSync(JAVA_PATH, "utf8");
  const runSync = java.slice(java.indexOf("private JSONObject runSync("), java.indexOf("for (String url : candidates) {", java.indexOf("private JSONObject runSync(")));

  it("laptopUrl() reports \"\" when nothing is saved and getLaptopUrl() never invents one", () => {
    expect(java).toMatch(/private String laptopUrl\(\) \{[\s\S]*?\n        return u;\n    \}/);
    expect(java).toMatch(/return laptopUrl\(\);\s*\} catch \(RuntimeException e\) \{\s*return "";\s*\}/);
  });

  it("runSync answers \"auth\" without network I/O when there is no candidate and no saved address", () => {
    expect(runSync).toContain("if (isHttpUrl(saved)) candidates.add(saved);");
    expect(runSync).toMatch(/if \(candidates\.isEmpty\(\)\) \{\s*return syncResult\(requestId, false, "auth", null, 0, started, new JSONArray\(\), ""\);\s*\}/);
    // decided before the network check and before any attempt
    expect(runSync.indexOf('"auth", null, 0, started, new JSONArray(), "");\n        }\n\n        if (!hasActiveNetwork())')).toBeGreaterThan(0);
  });
});
