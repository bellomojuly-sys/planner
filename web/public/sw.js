/**
 * Service worker: offline shell, plan caching, and the outgoing capture queue.
 *
 * The requirement is that the app works without a connection. That splits into
 * three jobs handled here:
 *   1. Cache the app shell so it opens at all.
 *   2. Serve the last-known plan from cache when the network is unavailable,
 *      so today's schedule is readable on the train.
 *   3. Hold voice captures made offline and flush them via Background Sync
 *      when signal returns — a captured thought is never lost.
 */

const VERSION = 'v1';
const SHELL_CACHE = `planner-shell-${VERSION}`;
const DATA_CACHE = `planner-data-${VERSION}`;
const QUEUE_DB = 'planner-queue';
const QUEUE_STORE = 'captures';

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individual failures must not abort the install; a missing icon should
      // not stop the app from working offline.
      .then((cache) => Promise.allSettled(SHELL_ASSETS.map((a) => cache.add(a))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch strategies
// ---------------------------------------------------------------------------

const CACHEABLE_API = [/^\/api\/plan/, /^\/api\/shopping/, /^\/api\/tasks/];

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API.some((re) => re.test(url.pathname))) {
      event.respondWith(networkFirst(request));
    }
    return;
  }

  // Navigations fall back to the cached shell so a cold offline launch still
  // renders instead of showing the browser's error page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html')),
    );
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      // Tag the response so the UI can show an "offline, dati del …" banner
      // rather than presenting stale data as live.
      const headers = new Headers(cached.headers);
      headers.set('X-Planner-Offline', '1');
      return new Response(cached.body, { status: 200, headers });
    }
    return new Response(
      JSON.stringify({
        error: 'offline',
        message: 'Sei offline e non ho dati salvati per questa vista.',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

// ---------------------------------------------------------------------------
// Offline capture queue
// ---------------------------------------------------------------------------

function openQueue() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(QUEUE_DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function queueAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const req = tx.objectStore(QUEUE_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function queueDelete(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    tx.objectStore(QUEUE_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function flushQueue() {
  const db = await openQueue();
  const pending = await queueAll(db);

  for (const item of pending) {
    try {
      const res = await fetch('/api/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          text: item.text,
          source: 'web',
          // The id doubles as the idempotency key, so a retry after a partial
          // failure cannot create the task twice.
          clientRequestId: item.id,
        }),
      });

      // 4xx means the server understood and rejected it — retrying forever
      // would block the whole queue behind one bad entry.
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        await queueDelete(db, item.id);
      }
    } catch {
      // Still offline; leave the rest queued for the next sync event.
      break;
    }
  }

  const remaining = await queueAll(db);
  const clients = await self.clients.matchAll();
  for (const client of clients) {
    client.postMessage({ type: 'queue-flushed', remaining: remaining.length });
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'planner-captures') event.waitUntil(flushQueue());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'flush-queue') event.waitUntil(flushQueue());
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Planner', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Planner', {
      body: payload.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      // The tag collapses a re-sent briefing rather than stacking duplicates.
      tag: payload.tag,
      data: { url: payload.url ?? '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus an existing window rather than opening a second copy of the app.
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
