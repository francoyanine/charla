// Permite instalar Charla como app (Chrome/Edge: "Instalar app"; iPhone: "Agregar a inicio").
// Red primero: siempre se usa la versión publicada y la caché solo sirve sin conexión.
const CACHE = 'charla-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copia));
    return r;
  }).catch(() => caches.match(e.request)));
});
