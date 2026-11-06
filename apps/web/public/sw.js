/* NIMBUS service worker — app shell only.
 * NEVER caches API responses, tokens or private service data.
 * The panel must never claim service operations work while offline. */
const SHELL = "nimbus-shell-v1";
const SHELL_ASSETS = ["/", "/login", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Network-first for everything; cache only same-origin GET navigations.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (event.request.mode === "navigate") {
          const copy = res.clone();
          caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then(
          (cached) =>
            cached ??
            new Response(
              JSON.stringify({ offline: true, message: "You are offline. Service controls require a connection." }),
              { status: 503, headers: { "content-type": "application/json" } },
            ),
        ),
      ),
  );
});
