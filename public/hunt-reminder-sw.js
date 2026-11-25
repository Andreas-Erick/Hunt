// Hunt reminder notifications (ADR-0007). Only a service worker can show a notification with
// buttons, which the launcher's Chromium window turns into Windows toast buttons. This worker
// handles no fetches and caches nothing: it hands a pressed button (Done, +1, Snooze) to one open
// Hunt window, which applies it through HuntCore's rules (src/lib/desktopReminderActions.ts).
// A plain click just brings Hunt forward. Nothing fires while no Hunt window is open.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const hunt = windows.find((w) => w.focused) || windows[0];
      if (!hunt) return undefined;
      // One window only: a +1 handed to two windows would count twice.
      if (event.action) {
        hunt.postMessage({ type: "hunt-reminder-action", action: event.action, data: event.notification.data });
        return undefined;
      }
      return hunt.focus();
    })
  );
});
