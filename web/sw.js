// Permite instalar Charla como app (Chrome/Android: "Instalar app"; iPhone: "Agregar a inicio").
// Abre al instante desde la caché y trae la versión nueva por detrás: un cambio publicado
// se ve en la apertura siguiente. Los datos (Supabase) nunca pasan por la caché.
const CACHE = 'charla-v3';
const BASE = ['./', 'index.html', 'app.js', 'app.css', 'config.js', 'iconos.js', 'backend-supabase.js',
  'vendor/supabase-2.45.4.js', 'manifest.webmanifest', 'icon.svg'];
const FUENTES = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin && !FUENTES.includes(url.origin)) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const guardada = await c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' });
    const nueva = fetch(e.request).then((r) => {
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    });
    if (guardada) { e.waitUntil(nueva.catch(() => {})); return guardada; }
    return nueva;
  }));
});
