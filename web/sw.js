// Permite instalar Charla como app (Chrome/Android: "Instalar app"; iPhone: "Agregar a inicio")
// y recibe los avisos push cuando la app está cerrada.
// Abre al instante desde la caché y trae la versión nueva por detrás: un cambio publicado
// se ve en la apertura siguiente. Los datos (Supabase) nunca pasan por la caché.
const CACHE = 'charla-v6';
const BASE = ['./', 'index.html', 'app.js', 'app.css', 'config.js', 'iconos.js', 'avisos.js', 'backend-supabase.js',
  'vendor/supabase-2.45.4.js', 'manifest.webmanifest', 'icon.svg', 'icono-192.png', 'icono-aviso.png'];
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

// ---------- avisos push ----------
// Cada ventana de Charla cuenta qué chat tiene a la vista, para no avisar de lo que la
// persona ya está leyendo. Si este proceso se reinicia y lo olvida, simplemente avisa.
const viendo = new Map(); // id de la ventana -> id del canal (o null)
self.addEventListener('message', (e) => {
  if (e.data?.tipo === 'viendo' && e.source?.id) viendo.set(e.source.id, e.data.canal || null);
});

// Safari (iPhone, iPad y Mac) exige mostrar una notificación por cada push; si no, retira
// el permiso. En los demás se puede omitir cuando la persona ya está mirando ese chat.
const ES_WEBKIT = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { cuerpo: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    if (typeof d.insignia === 'number' && self.navigator.setAppBadge) {
      try { if (d.insignia > 0) await self.navigator.setAppBadge(d.insignia); else await self.navigator.clearAppBadge(); } catch { /* sin número en el ícono */ }
    }
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const leyendo = d.canal && ventanas.some((v) => v.visibilityState === 'visible' && v.focused && viendo.get(v.id) === d.canal);
    if (leyendo && !ES_WEBKIT) return;
    await self.registration.showNotification(d.titulo || 'Charla', {
      body: d.cuerpo || 'Mensaje nuevo',
      tag: d.canal || d.id || 'charla',   // un aviso por conversación: el último reemplaza al anterior
      renotify: true,
      icon: 'icono-192.png',
      badge: 'icono-aviso.png',
      data: { canal: d.canal || null, id: d.id || null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const { canal } = e.notification.data || {};
  e.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const v = ventanas.find((x) => x.url.startsWith(self.registration.scope));
    if (v) {
      await v.focus().catch(() => {});
      v.postMessage({ tipo: 'ir', canal });
      return;
    }
    await self.clients.openWindow(canal ? `${self.registration.scope}?canal=${encodeURIComponent(canal)}` : self.registration.scope);
  })());
});
