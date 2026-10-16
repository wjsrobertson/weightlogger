// Service worker: lets the app install to the home screen and work offline. learnthai's, cut down.
//
// - App files (SHELL) are cache-first, so the app opens instantly whatever the connection. Each
//   launch also checks the server for a new version in the background (refreshShell). If anything
//   changed, the whole set is fetched and swapped in together, so a page never mixes files from two
//   versions, and open pages are told (they show a "New version ready" bar).
// - Anything else on the site is network-first, falling back to the cache.
//
// The weigh-ins themselves are in localStorage, not here.

const SHELL_CACHE = 'weightlogger-shell-v1'; // bump if SHELL changes, so stale entries are dropped
const NETWORK_TIMEOUT_MS = 4000;
// Paths relative to the service worker's scope ('' is the app's root URL).
const SHELL = [
  '', 'index.html', 'app.js', 'styles.css', 'mobile.css', 'app.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];
const shellUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map((path) => new Request(shellUrl(path), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('weightlogger-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (SHELL.some((path) => shellUrl(path) === url.origin + url.pathname)) {
    event.respondWith(cacheFirst(req));
    if (req.mode === 'navigate') event.waitUntil(refreshShell());
  } else {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) await cache.put(req, res.clone());
  return res;
}

// What identifies a file's version: GitHub Pages sends an ETag, simpler servers a Last-Modified.
const versionOf = (res) => res.headers.get('etag') || res.headers.get('last-modified') || res.headers.get('content-length');

// Once per launch: revalidate the whole shell (mostly cheap 304s) and, if any file changed, store
// the new set and tell open pages. Offline, or a missing file, keeps the current version.
let refreshing = null;
function refreshShell() {
  refreshing ||= (async () => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      const fresh = await Promise.all(SHELL.map(async (path) => {
        const url = shellUrl(path);
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${res.status} ${url}`);
        return [url, res];
      }));
      let changed = false;
      for (const [url, res] of fresh) {
        const old = await cache.match(url);
        if (!old || versionOf(old) !== versionOf(res)) changed = true;
      }
      if (!changed) return;
      await Promise.all(fresh.map(([url, res]) => cache.put(url, res)));
      for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage({ type: 'update-ready' });
    } catch {
      // keep the current version
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  // 'no-cache' revalidates with the server (usually a cheap 304) instead of trusting the HTTP cache.
  const network = fetch(req.url, { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) await cache.put(req, res.clone());
    return res;
  });
  network.catch(() => {}); // a late failure after the timeout fallback isn't an error
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch {
    // offline: fall through to the cache
  }
  return (await cache.match(req, { ignoreSearch: true })) || network;
}
