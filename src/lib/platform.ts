import { seedInitialDataIfNeeded } from "./db";
import { seedDemoIfEmpty } from "./demoStore";
import { httpSyncTransport, syncDataExistsElsewhere, type SyncTransport } from "./syncEngine";
import { IS_WEB_DEMO } from "./webDemo";

/**
 * What the app may reach beyond this browser tab. The native app (desktop launcher, tablets
 * on the LAN URL) has the laptop's sync hub (ADR-0002); the static browser demo (ADR-0010)
 * has no server at all. Views and the store ask this instead of assuming a server.
 *
 * OS notifications are decided in desktopReminders.ts (`notificationAccess`), and the
 * window-control buttons already hide without a sync key (ADR-0009), so neither is here.
 */
export interface HuntPlatform {
  id: "native" | "web-demo";
  /** Two-way sync with the laptop hub, or null when this build has no server to reach. */
  sync: {
    transport: SyncTransport;
    /** The seed's "is there data elsewhere?" check (see syncDataExistsElsewhere). */
    dataExistsElsewhere: () => Promise<boolean>;
  } | null;
  /**
   * Fills an empty local database on boot: the native starter template (only when no other
   * device holds data), or the demo's sample data (demoSeed.ts). Never touches existing rows.
   */
  seedIfEmpty: () => Promise<void>;
}

export const nativePlatform: HuntPlatform = {
  id: "native",
  sync: { transport: httpSyncTransport, dataExistsElsewhere: syncDataExistsElsewhere },
  seedIfEmpty: () => seedInitialDataIfNeeded(syncDataExistsElsewhere),
};

/** No sync, no network: every request this build would make is answered by not making it. */
export const webDemoPlatform: HuntPlatform = {
  id: "web-demo",
  sync: null,
  seedIfEmpty: async () => void (await seedDemoIfEmpty()),
};

/** Fixed at build time (NEXT_PUBLIC_HUNT_DEMO), so the unused platform drops out of the bundle. */
export const currentPlatform: HuntPlatform = IS_WEB_DEMO ? webDemoPlatform : nativePlatform;
