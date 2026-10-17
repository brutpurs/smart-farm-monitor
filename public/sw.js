// Minimal service worker: lets the dashboard install as an app and shows a friendly page when offline.
// Live data and API calls are never cached.
const OFFLINE_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Offline</title><body style="margin:0;min-height:100vh;display:grid;place-content:center;text-align:center;' +
  'background:#070b12;color:#eef2f7;font-family:system-ui,sans-serif;padding:24px">' +
  '<h2>You are offline</h2><p style="color:#8b97a9">The Smart Farm Monitor needs an internet connection.</p>' +
  '<p><button onclick="location.reload()" style="padding:12px 22px;border-radius:12px;border:0;font-size:16px">Try again</button></p></body>';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    );
  }
});
