/* saasmail push service worker.
 * Kept intentionally minimal — it renders notifications and handles clicks.
 */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    // Payload was not JSON; fall back to empty.
  }
  const title = data.title || "New email";
  const options = {
    body: data.body || "",
    tag: data.tag,
    icon: data.icon || "/saasmail-logo.png",
    badge: data.badge || "/saasmail-logo.png",
    data: data.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((wins) => {
        for (const w of wins) {
          try {
            const u = new URL(w.url);
            if (u.pathname === url || u.pathname.startsWith(url)) {
              return w.focus();
            }
          } catch (_) {}
        }
        return self.clients.openWindow(url);
      }),
  );
});

// No-op install/activate so the SW activates immediately on first load.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
