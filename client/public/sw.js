// Roammail service worker (web and phone apps):
//  - app shell: the page and its code are kept on the device, so Roammail opens without a connection
//  - recent mail: folder lists, message lists and messages you opened are kept, so you can read them offline
//    (only if you ticked "Keep me signed in", always in the phone apps: the app marks those requests X-Offline-Ok)
//    (always fetched fresh when online; the saved copy is only used when the network fails)
//  - push notifications for new mail (web; the phone apps use native push)
// Everything saved is deleted when you sign out ({type: 'signout'} message) or the server says you're signed out.
const SHELL = 'shell-v3';
const SHARE = 'share-v1'; // something shared to Roammail from another app, until the app picks it up
const DATA = 'mail-v2';
const MAX_DATA = 300; // saved API answers
let signedOutAt = 0; // answers to requests made before sign-out are never saved
const OFFLINE_API = /^\/api\/(me|folders|messages|message|thread|accounts|identities|signup\/config|ai\/status|premium|push\/key)(\/|$|\?)/;

self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![SHELL, DATA, SHARE].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

const offlinePage = () => new Response(
  '<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:sans-serif;text-align:center;padding:20vh 20px;color:#444"><h2>You\'re offline</h2><p>Your mail will be here when you reconnect.</p><button onclick="location.reload()">Try again</button></body>',
  { headers: { 'Content-Type': 'text/html' } });

async function trim() {
  const c = await caches.open(DATA);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DATA))) await c.delete(k);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // "Share" → Roammail from another app (photos, files, links): keep it for a moment and open a new email with it
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const c = await caches.open(SHARE);
        for (const k of await c.keys()) await c.delete(k);
        const files = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size <= 25 * 1024 * 1024).slice(0, 10);
        await c.put('/share/meta', new Response(JSON.stringify({ title: String(form.get('title') || '').slice(0, 300), text: String(form.get('text') || '').slice(0, 5000), url: String(form.get('url') || '').slice(0, 2000), files: files.map((f, i) => ({ i, name: f.name, type: f.type })), at: Date.now() })));
        await Promise.all(files.map((f, i) => c.put(`/share/file/${i}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))));
      } catch { /* open the app anyway */ }
      return Response.redirect('/app?share=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages: network first, then the saved app page (the app shows whatever mail it has saved)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) caches.open(SHELL).then((c) => c.put('/__shell', res.clone()));
      return res;
    }).catch(async () => (await caches.match('/__shell')) || offlinePage()));
    return;
  }
  // Built code and styles have unique names: keep them
  if (url.pathname.startsWith('/app-assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // Mail data: always fresh when online; the saved copy only when the network fails
  if (OFFLINE_API.test(url.pathname + url.search) && !url.pathname.startsWith('/api/attachment')) {
    const started = Date.now();
    e.respondWith(fetch(req).then((res) => {
      if (started <= signedOutAt) return res;
      if (res.status === 401) e.waitUntil(caches.delete(DATA)); // signed out: forget the saved mail
      // keep a copy only for people who chose to stay signed in
      else if (res.ok && req.headers.get('x-offline-ok') === '1') { const copy = res.clone(); e.waitUntil(caches.open(DATA).then((c) => c.put(req, copy)).then(trim)); }
      return res;
    }).catch(async () => (await caches.match(req)) || new Response(JSON.stringify({ error: 'You’re offline. This hasn’t been saved on this device yet.', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } })));
  }
});

// Keep the app shell after the page has loaded (its first load happens before we're in control).
// The page to keep is the one that asked, as the browser reports it (never an address from the message).
async function keepShell(clientId) {
  const client = clientId && await self.clients.get(clientId);
  if (!client) return;
  const url = new URL(client.url);
  if (url.origin !== self.location.origin || !/^\/(\d{8}|\d{6}-\d{3}-[A-Z]{2})\//.test(url.pathname)) return; // only our own app pages
  const res = await fetch(url.origin + url.pathname, { credentials: 'same-origin' });
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return;
  const html = await res.text();
  const c = await caches.open(SHELL);
  await c.put('/__shell', new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
  const assets = [...html.matchAll(/(?:src|href)="(\/app-assets\/[^"]+)"/g)].map((m) => m[1]);
  await Promise.all(assets.map(async (a) => { if (!(await c.match(a))) { const r = await fetch(a); if (r.ok) await c.put(a, r); } }));
}
self.addEventListener('message', (e) => {
  // only from Roammail's own pages (service workers get an empty e.origin, so check the sending page)
  let from = ''; try { from = new URL(e.source?.url || '').origin; } catch { return; }
  if (from !== self.location.origin) return;
  if (e.data?.type === 'signout') signedOutAt = Date.now();
  if (e.data?.type === 'signout') e.waitUntil(Promise.all([caches.delete(DATA), caches.delete(SHELL), caches.delete(SHARE)]));
  if (e.data?.type === 'shell') e.waitUntil(keepShell(e.source?.id).catch(() => {}));
});

// Push notifications for new mail (sent by the server even when Roammail isn't open)
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'New mail' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'New mail', { body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/favicon.png', data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => new URL(c.url).origin === self.location.origin);
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
