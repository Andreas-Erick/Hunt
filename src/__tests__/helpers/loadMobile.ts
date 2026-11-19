// jsdom harness for the phone page (android-app/app/src/main/assets/hunt-mobile.html).
//
// loadMobile() boots the real page with its inline script in a fresh JSDOM window and returns that
// window. The page's top-level functions (mergePayloads, completeTaskDirect, ...) are window
// properties; its `let`/`const` state is read with readState(). Call w.close() in afterEach (it
// stops the page's 500 ms ticker and every other timer).
//
// Clock: the page's Date.now() is wired to the test realm's Date.now(), and the page's timers are
// jsdom timers built on the test realm's setTimeout, so vi.useFakeTimers() (installed BEFORE
// loadMobile) controls both. `new Date()` without arguments inside the page still reads the real
// clock (only the Day Timeline's "now" line uses it). The page's Math.random is a seeded LCG
// (options.randomSeed, default 1), so generated ids and the retry jitter repeat run to run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

export const MOBILE_ASSET_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "android-app",
  "app",
  "src",
  "main",
  "assets",
  "hunt-mobile.html"
);
export const STATE_KEY = "hunt-mobile-standalone-v1";
export const SYNC_META_KEY = "hunt-sync-meta-v1";
export const LAPTOP_URL_KEY = "hunt-laptop-url-v1";
export const TOKEN_KEY = "hunt-sync-token-v1";

export interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchStub = (url: string, init?: FetchInit) => Promise<FakeResponse>;

/** The AndroidBridge methods the page may call (all optional, like an older or newer shell). */
export interface AndroidBridgeStub {
  loadState?: () => string;
  saveState?: (json: string) => void;
  getLaptopUrl?: () => string;
  saveLaptopUrl?: (url: string) => void;
  saveSyncToken?: (token: string) => boolean | undefined;
  syncWithLaptopAsync?: (id: string, candidatesJson: string, body: string, force: boolean) => boolean;
  setKeepScreenOn?: (on: boolean) => void;
  vibrateClick?: () => void;
  getAppVersion?: () => string;
}

export interface FocusShape {
  activeTaskId: string | null;
  isRunning: boolean;
  sessionStartedAt: number | null;
  updatedAt: number;
}

export interface PageRow {
  id: string;
  [field: string]: unknown;
}

export interface PageState {
  quests: PageRow[];
  tasks: PageRow[];
  timeLogs: PageRow[];
  deletedQuestIds: string[];
  deletedTaskIds: string[];
  deletedLogIds: string[];
  activeFocus: FocusShape;
  [field: string]: unknown;
}

export interface SyncStatus {
  phase: string;
  pending: number;
  inFlight: boolean;
  failures: number;
  retryAt: number;
  lastOkAt: number;
  lastAttemptAt: number;
  lastError: string | null;
  lastUrl: string | null;
  lanUrls: string[];
}

/** Page globals the tests drive (function declarations of the page's classic script). */
export interface MobilePageGlobals {
  AndroidBridge?: AndroidBridgeStub;
  escapeHtml(value: unknown): string;
  jsArg(value: unknown): string;
  isSafeSyncId(value: unknown, maxLength?: number): boolean;
  guardSyncState(input: unknown): { value: Record<string, unknown>; dropped: number };
  mergePayloads(base: unknown, inc: unknown, report?: { createdLocal: boolean }): unknown;
  applyRemotePayload(payload: unknown): boolean;
  renderApp(): void;
  switchView(view: string): void;
  tick(): void;
  persistState(json?: string): boolean;
  toLocalDateKey(ts?: number): string;
  dayKeyOffset(n: number, from?: number): string;
  getSyncStatus(): SyncStatus;
  syncNow(): Promise<unknown>;
  manualSyncFromSheet(): Promise<unknown>;
  applyLaptopUrlInput(value: string): boolean;
  openSyncSheet(): void;
  openNewTaskSheet(questId?: string | null, dateKey?: string): void;
  openNewQuestSheet(): void;
  openTaskInspectorSheet(taskId: string): void;
  openQuestEditorSheet(questId: string): void;
  closeSheet(discardDraft?: boolean): void;
  completeTaskDirect(taskId: string): void;
  reopenTaskDirect(taskId: string): void;
  updateTaskField(taskId: string, field: string, value: unknown): void;
  saveTaskText(taskId: string, field: string, value: unknown): void;
  saveQuestFromSheet(questId: string): void;
  deleteQuestItem(questId: string): void;
  deleteTaskItem(taskId: string): void;
  deleteLogItem(logId: string): void;
  initializeFocus(taskId?: string | null): void;
  toggleTimerPause(): void;
  returnToQueueFromFocus(): void;
  completeActiveTaskAndNext(): void;
  promoteTaskToTop(taskId: string): void;
  __huntSyncDone(result: unknown): void;
  __huntLifecycle(phase: string): void;
  __huntNetwork(info: { online: boolean }): void;
  __huntBack(): boolean;
  __pwned?: unknown;
}

export type MobileWindow = Window & typeof globalThis & MobilePageGlobals;

export interface LoadMobileOptions {
  /** Saved phone state (JSON-serialised into localStorage before the page boots). */
  seedState?: unknown;
  /** Saved phone state stored verbatim (corrupt-state tests); wins over seedState. */
  rawState?: string;
  /** Further localStorage entries to seed (sync meta, laptop URL, token, ...). */
  storage?: Record<string, string>;
  /** window.AndroidBridge stub: present = APK mode, absent = browser copy. */
  bridge?: AndroidBridgeStub;
  /** window.fetch stub (default: a request that never settles). */
  fetchImpl?: FetchStub;
  /** Page URL (default http://localhost/), e.g. to pass ?token= to the browser copy. */
  url?: string;
  /** Seed of the page's Math.random (default 1). */
  randomSeed?: number;
  /** Runs on the fresh window before the page script (fault injection, extra stubs). */
  beforeBoot?: (w: MobileWindow) => void;
}

export interface ConsoleEntry {
  level: string;
  args: unknown[];
}

interface Capture {
  errors: unknown[];
  console: ConsoleEntry[];
}

const captures = new WeakMap<object, Capture>();

/** 32-bit LCG in [0, 1). */
export function seededRandom(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

let cachedHtml: string | null = null;

/** The page markup without the Google Fonts links (jsdom never needs them). */
export function mobileHtml(): string {
  if (cachedHtml === null) {
    cachedHtml = readFileSync(MOBILE_ASSET_PATH, "utf8").replace(
      /<link\b[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g,
      ""
    );
  }
  return cachedHtml;
}

export function loadMobile(options: LoadMobileOptions = {}): MobileWindow {
  const capture: Capture = { errors: [], console: [] };
  const virtualConsole = new VirtualConsole();
  for (const level of ["log", "info", "warn", "error"]) {
    virtualConsole.on(level, (...args: unknown[]) => capture.console.push({ level, args }));
  }
  virtualConsole.on("jsdomError", (e: unknown) => capture.errors.push(e));
  const never: FetchStub = () => new Promise<FakeResponse>(() => undefined);
  const dom = new JSDOM(mobileHtml(), {
    url: options.url ?? "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(w: MobileWindow) {
      w.addEventListener("error", (e: ErrorEvent) => capture.errors.push(e.error ?? e.message));
      w.Date.now = () => Date.now();
      w.Math.random = seededRandom(options.randomSeed ?? 1);
      if (options.rawState !== undefined) w.localStorage.setItem(STATE_KEY, options.rawState);
      else if (options.seedState !== undefined) w.localStorage.setItem(STATE_KEY, JSON.stringify(options.seedState));
      for (const [key, value] of Object.entries(options.storage ?? {})) w.localStorage.setItem(key, value);
      Object.defineProperty(w, "fetch", { value: options.fetchImpl ?? never, configurable: true, writable: true });
      Object.defineProperty(w, "AudioContext", { value: undefined, configurable: true, writable: true });
      if (options.bridge) w.AndroidBridge = options.bridge;
      options.beforeBoot?.(w);
    },
  });
  const w = dom.window as MobileWindow;
  captures.set(w, capture);
  return w;
}

/** Uncaught errors the page reported (window 'error' events and jsdom script errors). */
export function pageErrors(w: MobileWindow): unknown[] {
  return captures.get(w)?.errors ?? [];
}

/** console.* calls the page made. */
export function pageConsole(w: MobileWindow): ConsoleEntry[] {
  return captures.get(w)?.console ?? [];
}

function isStateShape(value: unknown): value is PageState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.quests) && Array.isArray(v.tasks) && Array.isArray(v.timeLogs);
}

/** A detached copy of the page's in-memory `state`. */
export function readState(w: MobileWindow): PageState {
  const json: unknown = w.eval("JSON.stringify(state)");
  const parsed: unknown = typeof json === "string" ? JSON.parse(json) : null;
  if (!isStateShape(parsed)) throw new Error("page state is not readable");
  return parsed;
}

export function jsonResponse(status: number, body: unknown): FakeResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
}

/** A canonical-looking 64-hex pairing key built at runtime (never a literal in the sources). */
export function fakePairingKey(seed = 7): string {
  const next = seededRandom(seed);
  let out = "";
  while (out.length < 64) out += Math.floor(next() * 16).toString(16);
  return out;
}

/** Dispatches a real click on an element of the page (inline on* handlers run). */
export function click(w: MobileWindow, el: Element | null): void {
  if (!el) throw new Error("click target missing");
  el.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
}
