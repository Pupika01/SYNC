const CACHE = "sync-pwa-v19";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./config.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});

// Network-first: users always get fresh code after a deploy; the cache is only the offline fallback.
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request.mode === "navigate" ? new Request(request.url) : request, { cache: "no-cache" })
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
        if (cached) return cached;
        if (request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      })
  );
});
