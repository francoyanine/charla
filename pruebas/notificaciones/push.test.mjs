// Push real de punta a punta: Chrome de verdad se suscribe con la app (modo demo), la
// función "notificar" (en Deno) cifra y envía por el servicio de Google, y el proceso de
// avisos de la app muestra la notificación. La base es PGlite con el esquema real + 006.
import puppeteer from 'puppeteer-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://localhost:5185/?demo';
const STUB = 'http://localhost:54399';
const FUNCION = 'http://localhost:8000';
let ok = 0, mal = 0;
const prueba = (n, c, d = '') => { if (c) { ok++; console.log('  ✓', n); } else { mal++; console.log('  ✗', n, d); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const estado = async () => (await fetch(`${STUB}/_prueba/estado`)).json();
const sql = async (q, p = []) => (await fetch(`${STUB}/_prueba/sql`, { method: 'POST', body: JSON.stringify({ q, p }) })).json();
const mensaje = async (autor, canal, texto, extra) => (await (await fetch(`${STUB}/_prueba/mensaje`, { method: 'POST', body: JSON.stringify({ autor, canal, texto, extra }) })).json()).id;
const notificar = async (cuerpo, cab = {}) => { const r = await fetch(FUNCION, { method: 'POST', headers: { 'Content-Type': 'application/json', ...cab }, body: JSON.stringify(cuerpo) }); return { codigo: r.status, ...(await r.json()) }; };
async function hasta(f, ms = 25000) { const fin = Date.now() + ms; let v; while (Date.now() < fin) { v = await f(); if (v) return v; await espera(500); } return v; }

await sql('truncate public.push_suscripciones');   // nada de corridas anteriores
const e0 = await estado();
const SECRETO = { 'x-charla-secreto': e0.secreto };
const b = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false,
  userDataDir: mkdtempSync(join(tmpdir(), 'charla-push-')),
  ignoreDefaultArgs: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--enable-automation'],
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1100,820', '--window-position=40,40'],
});
try {
  await b.defaultBrowserContext().overridePermissions('http://localhost:5185', ['notifications']);
  const p = (await b.pages())[0] || await b.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.evaluateOnNewDocument((STUB, FUNCION) => {
    const cab = { Authorization: 'Bearer tok-beto', 'Content-Type': 'application/json' };
    window.__charlaPushPrueba = {
      funcion: FUNCION,
      guardar: async (s, disp) => { const r = await fetch(`${STUB}/rest/v1/rpc/guardar_suscripcion`, { method: 'POST', headers: cab, body: JSON.stringify({ p_endpoint: s.endpoint, p_p256dh: s.keys.p256dh, p_auth: s.keys.auth, p_dispositivo: disp }) }); if (!r.ok) throw new Error((await r.json()).message); },
      quitar: async (endpoint) => { await fetch(`${STUB}/rest/v1/rpc/quitar_suscripcion`, { method: 'POST', headers: cab, body: JSON.stringify({ p_endpoint: endpoint }) }); },
      probar: async () => (await fetch(FUNCION, { method: 'POST', headers: cab, body: JSON.stringify({ prueba: true }) })).json(),
    };
  }, STUB, FUNCION);
  await p.goto(APP, { waitUntil: 'networkidle0' });
  await p.evaluate(() => localStorage.clear()); await p.reload({ waitUntil: 'networkidle0' });
  await p.evaluate(() => document.querySelectorAll('[data-demo]')[1].click());
  await p.waitForSelector('#composerPrincipal textarea');
  prueba('permiso de notificaciones concedido en el navegador', (await p.evaluate(() => Notification.permission)) === 'granted');

  // 1. La app se suscribe sola (ya hay permiso) y guarda el dispositivo.
  const sus = await hasta(async () => (await estado()).suscripciones.find((s) => s.user_id === e0.u.beto), 40000);
  prueba('la app se suscribió y el dispositivo quedó guardado', !!sus, 'sin suscripción tras 40 s');
  if (!sus) throw new Error('sin suscripción no se puede seguir');
  prueba('la dirección es del servicio de Google (FCM)', new URL(sus.endpoint).hostname === 'fcm.googleapis.com', sus.endpoint.slice(0, 60));
  prueba('etiqueta del dispositivo', /Mac · Chrome/.test(sus.dispositivo), sus.dispositivo);
  const avisos = () => p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ titulo: n.title, cuerpo: n.body, tag: n.tag, data: n.data })));
  const cerrarAvisos = () => p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));

  // 2. Mensaje directo: la base pide el aviso (como el disparador) y llega la notificación.
  const m1 = await mensaje('ana', 'dmAB', 'hola Beto, esto es un push de verdad 🎉');
  const ll = (await estado()).llamadas.find((x) => x.body.message_id === m1);
  prueba('el disparador de la base llamó a la función con el secreto', !!ll && ll.headers['x-charla-secreto'] === e0.secreto && /notificar$/.test(ll.url));
  let r = await notificar({ message_id: m1 }, SECRETO);
  console.log('    (primer envío, recién suscrito:', JSON.stringify(r), ')');
  let intentos = 1; let mPrimero = m1;
  while (r.enviados !== 1 && intentos < 12) {   // el servicio aún no conoce al dispositivo: se reintenta con otro mensaje
    await espera(5000); intentos++;
    mPrimero = await mensaje('ana', 'dmAB', 'hola Beto, esto es un push de verdad 🎉');
    r = await notificar({ message_id: mPrimero }, SECRETO);
  }
  console.log(`    (aceptado al intento ${intentos}:`, JSON.stringify(r), ')');
  prueba('un rechazo a un dispositivo recién suscrito no lo da de baja', (await estado()).suscripciones.some((s) => s.user_id === e0.u.beto));
  prueba('la función envió 1 aviso', r.codigo === 200 && r.enviados === 1 && r.fallidos === 0, JSON.stringify(r));
  const t0 = Date.now();
  let ns = await hasta(async () => { const a = await avisos(); return a.length ? a : null; }, 45000);
  console.log(`    (primer aviso tras suscribirse: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  prueba('la notificación llegó al navegador por el servicio de push', !!ns, 'no llegó en 120 s');
  prueba('título, texto (con emoji) y chat correctos', ns?.[0]?.titulo === 'Ana Ríos' && ns[0].cuerpo === 'hola Beto, esto es un push de verdad 🎉' && ns[0].tag === e0.c.dmAB && ns[0].data?.canal === e0.c.dmAB, JSON.stringify(ns));

  // 3. El mismo mensaje no se avisa dos veces.
  r = await notificar({ message_id: mPrimero }, SECRETO);
  prueba('pedir el mismo mensaje otra vez: no se repite', r.enviados === 0 && r.repetido === true, JSON.stringify(r));

  // 4. Quién puede pedir un aviso.
  const m2 = await mensaje('ana', 'dmAB', 'segundo mensaje');
  prueba('sin sesión ni secreto: rechazado', (await notificar({ message_id: m2 })).codigo === 401);
  prueba('secreto equivocado: rechazado', (await notificar({ message_id: m2 }, { 'x-charla-secreto': 'x'.repeat(64) })).codigo === 401);
  r = await notificar({ message_id: m2 }, { Authorization: 'Bearer tok-beto' });
  prueba('otra persona no puede pedir el aviso de un mensaje ajeno', r.codigo === 200 && r.enviados === 0 && !r.repetido, JSON.stringify(r));
  await cerrarAvisos();
  r = await notificar({ message_id: m2 }, { Authorization: 'Bearer tok-ana' });
  prueba('quien lo escribió sí (camino de la app)', r.enviados === 1, JSON.stringify(r));
  ns = await hasta(async () => { const a = await avisos(); return a.find((x) => x.cuerpo === 'segundo mensaje') ? a : null; });
  prueba('…y llega', !!ns);
  prueba('un aviso por conversación: el nuevo reemplaza al anterior', ns?.length === 1, JSON.stringify(ns));
  prueba('message_id inválido: error claro', (await notificar({ message_id: 'no-es-uuid' }, SECRETO)).codigo === 400);

  // 5. Mención en un canal.
  await cerrarAvisos();
  const m3 = await mensaje('ana', 'general', 'oye @beto revisa el reporte 📊 ¿sí? — gracias');
  r = await notificar({ message_id: m3 }, SECRETO);
  ns = await hasta(async () => { const a = await avisos(); return a.length ? a : null; });
  prueba('mención: llega con el nombre del canal', r.enviados === 1 && ns?.[0]?.titulo === 'Ana Ríos en #general' && ns[0].tag === e0.c.general, JSON.stringify([r, ns]));
  prueba('emoji, tildes y signos llegan intactos', ns?.[0]?.cuerpo === 'oye @beto revisa el reporte 📊 ¿sí? — gracias', ns?.[0]?.cuerpo);
  const m4 = await mensaje('ana', 'general', 'mensaje de canal sin mención');
  r = await notificar({ message_id: m4 }, SECRETO);
  prueba('canal sin mención: no se envía nada', r.enviados === 0, JSON.stringify(r));

  // 6. Dispositivos malos: dirección ajena a un servicio de push, y suscripción vencida.
  const real = (await sql('select p256dh, auth from push_suscripciones where user_id = $1', [e0.u.beto]))[0];
  await sql(`insert into push_suscripciones (endpoint, user_id, p256dh, auth) values ('https://sitio-cualquiera.example/x', $1, $2, $3)`, [e0.u.caro, real.p256dh, real.auth]);
  await sql(`insert into push_suscripciones (endpoint, user_id, p256dh, auth, creado) values ('https://fcm.googleapis.com/fcm/send/cAduCado:APA91bVencida', $1, $2, $3, now() - interval '3 hours')`, [e0.u.dani, real.p256dh, real.auth]);
  r = await notificar({ message_id: await mensaje('ana', 'dmAC', 'para caro') }, SECRETO);
  prueba('dirección que no es de un servicio de push: no se le manda nada', r.enviados === 0 && r.fallidos === 1, JSON.stringify(r));
  r = await notificar({ message_id: await mensaje('ana', 'general', '@dani ¿estás?') }, SECRETO);
  const quedan = await sql('select count(*)::int n from push_suscripciones where user_id = $1', [e0.u.dani]);
  prueba('suscripción antigua y vencida: el servicio la rechaza y se borra sola', r.vencidos === 1 && quedan[0].n === 0, JSON.stringify([r, quedan]));

  // 7. "Probar notificación" desde el menú de la app.
  await cerrarAvisos(); await p.bringToFront();
  await p.evaluate(() => document.querySelector('#btnYo').click());
  const menu = await p.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].map((x) => x.textContent.trim()));
  prueba('el menú ofrece "Probar notificación"', menu.some((x) => /Probar notificación/.test(x)), menu.join(' / '));
  await p.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].find((x) => /Probar/.test(x.textContent)).click());
  ns = await hasta(async () => { const a = await avisos(); return a.find((x) => /funcionan/.test(x.cuerpo)) ? a : null; });
  prueba('el aviso de prueba llega', !!ns, JSON.stringify(await avisos()));

  // 8. Tocar la notificación abre ese chat. Se arma un chat en la base con el mismo id que
  //    uno de la demo, para que la app lo reconozca.
  await cerrarAvisos();
  const demo = await p.evaluate(() => { const b = [...document.querySelectorAll('#listaCanales [data-canal]')].find((x) => x.textContent.includes('marketing')); return { id: b.dataset.canal, actual: document.querySelector('#listaCanales .item.activo')?.textContent.trim() }; });
  await sql(`insert into channels (id, nombre) values ($1, $2)`, [demo.id, `marketing-${Date.now()}`]);
  r = await notificar({ message_id: await mensaje('ana', demo.id, '@beto mira marketing') }, SECRETO);
  ns = await hasta(async () => { const a = await avisos(); return a.find((x) => x.tag === demo.id) ? a : null; });
  prueba('aviso de #marketing (no es el chat a la vista)', r.enviados === 1 && !!ns && !/marketing/.test(demo.actual || ''), JSON.stringify([r, demo.actual]));
  const sw = await (await b.waitForTarget((t) => t.type() === 'service_worker')).worker();
  await sw.evaluate(async (tag) => { const n = (await self.registration.getNotifications()).find((x) => x.tag === tag); self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n })); }, demo.id);
  const abierto = await hasta(async () => (await p.evaluate(() => document.querySelector('#listaCanales .item.activo')?.textContent.trim()))?.includes('marketing'), 8000);
  prueba('tocar la notificación abre #marketing en la app', !!abierto, await p.evaluate(() => document.querySelector('#listaCanales .item.activo')?.textContent));
  prueba('…y la notificación se cierra', !(await avisos()).some((x) => x.tag === demo.id));

  // 9. Mirando ese chat: no hace falta el aviso (solo se puede comprobar si la ventana tiene el foco).
  await p.bringToFront(); await p.mouse.click(600, 400); await espera(600);
  const conFoco = await p.evaluate(() => document.hasFocus() && !document.hidden);
  r = await notificar({ message_id: await mensaje('ana', demo.id, '@beto sigues en marketing') }, SECRETO);
  await espera(6000);
  const hay = (await avisos()).some((x) => x.tag === demo.id);
  if (conFoco) prueba('mirando ese chat con la ventana activa: no aparece notificación', r.enviados === 1 && !hay, JSON.stringify(await avisos()));
  else console.log('  · (la ventana de prueba no tenía el foco del sistema: no se comprueba la omisión; apareció =', hay, ')');

  // 10. Abrir un chat retira su notificación pendiente.
  await p.evaluate(() => [...document.querySelectorAll('#listaCanales [data-canal]')].find((x) => x.textContent.includes('general')).click()); await espera(500);
  r = await notificar({ message_id: await mensaje('ana', demo.id, '@beto tercera de marketing') }, SECRETO);
  await hasta(async () => (await avisos()).some((x) => x.tag === demo.id));
  await p.evaluate(() => [...document.querySelectorAll('#listaCanales [data-canal]')].find((x) => x.textContent.includes('marketing')).click());
  const retirada = await hasta(async () => !(await avisos()).some((x) => x.tag === demo.id), 6000);
  prueba('abrir el chat retira su notificación', !!retirada);

  // 11. Cerrar sesión: el dispositivo deja de recibir avisos.
  await p.evaluate(() => document.querySelector('#btnYo').click());
  await p.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].find((x) => /Cerrar sesión/.test(x.textContent)).click());
  const sinDisp = await hasta(async () => !(await estado()).suscripciones.some((s) => s.user_id === e0.u.beto), 10000);
  prueba('al cerrar sesión, el dispositivo se da de baja', !!sinDisp);
  prueba('sin errores en la página', errs.length === 0, errs.join(' | '));
} catch (e) {
  mal++; console.log('  ✗ la prueba se cortó:', e.message);
} finally {
  await b.close();
}
console.log(`\nPush de punta a punta: ${ok} pruebas bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
