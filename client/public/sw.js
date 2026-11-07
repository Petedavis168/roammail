// Minimal service worker: makes the app installable and shows a friendly page when offline.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:sans-serif;text-align:center;padding:20vh 20px;color:#444"><h2>You\'re offline</h2><p>Your mail will be here when you reconnect.</p></body>',
    { headers: { 'Content-Type': 'text/html' } })));
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
