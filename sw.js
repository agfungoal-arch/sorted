const CACHE = 'sorted-v4';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
// Network-first (updates ship instantly), cache fallback offline. Never touch the API.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.match(/\/(ask|event|followups|polls|push|cron)/)) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
// Push: lock screen is always discreet — never reveals content.
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('Sorted', {
    body: 'Sorted has a thought.',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: 'sorted-checkin'
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow('./');
  }));
});
