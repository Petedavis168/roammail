// Minimal service worker: makes the app installable and shows a friendly page when offline.
self.addEventListener('install', (e) => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:sans-serif;text-align:center;padding:20vh 20px;color:#444"><h2>You\'re offline</h2><p>Your mail will be here when you reconnect.</p></body>',
    { headers: { 'Content-Type': 'text/html' } })));
});
