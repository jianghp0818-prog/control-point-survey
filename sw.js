// Keeps the app working without a network: the newest version from the server when it answers within a few
// seconds, otherwise the copy saved on the phone. Field data is in IndexedDB, not in this cache.

const CACHE = "cpsurvey-0.1.0";   // change with APP_VERSION in js/app.js so phones fetch the new version
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/db.js", "js/map.js", "js/photos.js", "js/export.js", "js/numbers.js",
  "vendor/jszip.min.js", "vendor/proj4.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
];
const NETWORK_WAIT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isShell(url) {
  return url.origin === self.location.origin && SHELL.some((path) => new URL(path, self.registration.scope).href === url.href);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const shell = isShell(new URL(url.origin + url.pathname));
  if (!shell) return;                       // packs opened from a link (office map view) always come from the server
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(url.origin + url.pathname, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS, null));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch {
      // offline: use the saved copy
    }
    const saved = await cache.match(url.origin + url.pathname) ||
      (req.mode === "navigate" ? await cache.match(new URL("index.html", self.registration.scope).href) : null);
    return saved || network;
  })());
});
