/**
 * web/sw.js — minimal offline app-shell cache for the mobile PWA.
 *
 * Network-first for same-origin GET requests (HTML/CSS/JS/icons), falling
 * back to the cached copy only when the network is unavailable. Kept
 * network-first (not cache-first) specifically so a deploy is never masked
 * by a stale cache: CACHE_NAME was pinned at 'mma-gym-shell-v1' since this
 * file's very first version and had never been bumped since, while the old
 * cache-first strategy served that same frozen snapshot to every returning
 * visitor indefinitely — silently hiding every subsequent deploy (a
 * production bug: "Commencer" appearing to do nothing was very likely a
 * returning visitor's browser still executing a much older, cached app.js
 * against the current index.html). Bump CACHE_NAME on every deploy that
 * changes the app shell (the `activate` handler below evicts every other
 * cache automatically) as a defense-in-depth belt-and-suspenders measure —
 * network-first no longer strictly requires it to stay fresh, but it keeps
 * the OFFLINE fallback itself from serving something too old to be useful.
 */

const CACHE_NAME = 'mma-gym-shell-v2';
const APP_SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
