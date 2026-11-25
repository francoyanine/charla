// Las llamadas de la app al servidor (backend-supabase.js con supabase-js de verdad) contra
// el Supabase de prueba y la función real. Y la franja en teléfono (iPhone y Android).
import puppeteer from 'puppeteer-core';
const STUB = 'http://localhost:54399';
let ok = 0, mal = 0;
const prueba = (n, c, d = '') => { if (c) { ok++; console.log('  ✓', n); } else { mal++; console.log('  ✗', n, d); } };
const post = async (ruta, cuerpo) => (await fetch(STUB + ruta, { method: 'POST', body: JSON.stringify(cuerpo) })).json();
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const p = await b.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:5185/manifest.webmanifest');
await post('/_prueba/mensaje', { autor: 'ana', canal: 'general', texto: 'hola @beto' });
await post('/_prueba/mensaje', { autor: 'ana', canal: 'dmAB', texto: 'directo' });
const e = await (await fetch(STUB + '/_prueba/estado')).json();
const r = await p.evaluate(async (STUB) => {
  const { crear } = await import('/backend-supabase.js');
  const B = crear({ supabaseUrl: STUB, supabaseAnonKey: 'tok-beto', dominios: [] });
  const res = {};
  const paso = async (k, f) => { try { res[k] = await f(); } catch (e) { res[k] = 'ERROR ' + e.message; } };
  await paso('avisos', () => B.avisos());
  await paso('clave', () => B.clavePush());
  const sus = { endpoint: 'https://fcm.googleapis.com/fcm/send/cliente-prueba:APA91bNoExiste', keys: { p256dh: 'BGBzmoPcmH96hr8zrjrCWxRNffRViQ-1RAtSHmxXD8w81AfK_pQY9051mXRTZ9wNn080VDgjEdeowkmSrwcr7Gg', auth: 'a1b2c3d4e5f6a7b8c9d0e1' } };
  await paso('guardar', async () => { await B.guardarSuscripcion(sus, 'Prueba de cliente'); return 'ok'; });
  await paso('guardarMala', async () => { await B.guardarSuscripcion({ endpoint: 'http://no-https', keys: sus.keys }, ''); return 'ok'; });
  res.endpoint = sus.endpoint;
  return res;
}, STUB);
prueba('avisos(): menciones y directos por conversación', Array.isArray(r.avisos) && r.avisos.some((x) => x.channel_id === e.c.general && x.menciones >= 1) && r.avisos.some((x) => x.channel_id === e.c.dmAB && x.directos >= 1), JSON.stringify(r.avisos));
prueba('clavePush(): llave pública del servidor', typeof r.clave === 'string' && r.clave.length === 87 && r.clave[0] === 'B', r.clave);
prueba('guardarSuscripcion(): queda a nombre de quien llama', r.guardar === 'ok' && (await (await fetch(STUB + '/_prueba/estado')).json()).suscripciones.some((s) => s.endpoint === r.endpoint && s.user_id === e.u.beto && s.dispositivo === 'Prueba de cliente'), r.guardar);
prueba('guardarSuscripcion() con datos malos: error claro', /no válida/.test(r.guardarMala), r.guardarMala);
const r2 = await p.evaluate(async (STUB, endpoint) => {
  const { crear } = await import('/backend-supabase.js');
  const B = crear({ supabaseUrl: STUB, supabaseAnonKey: 'tok-beto', dominios: [] });
  const res = {};
  try { res.probar = await B.probarAviso(); } catch (e) { res.probar = 'ERROR ' + e.message; }
  return res;
}, STUB, r.endpoint);
prueba('probarAviso(): la función responde (dispositivo falso: rechazado, y por ser nuevo no se borra)', r2.probar?.dispositivos === 1 && r2.probar.enviados === 0 && r2.probar.vencidos === 0 && r2.probar.fallidos === 1, JSON.stringify(r2.probar));
await post('/_prueba/sql', { q: `insert into push_suscripciones (endpoint, user_id, p256dh, auth) values ('https://fcm.googleapis.com/fcm/send/para-quitar', $1, 'x', 'y')`, p: [e.u.beto] });
const r3 = await p.evaluate(async (STUB) => {
  const { crear } = await import('/backend-supabase.js');
  const B = crear({ supabaseUrl: STUB, supabaseAnonKey: 'tok-beto', dominios: [] });
  try { await B.quitarSuscripcion('https://fcm.googleapis.com/fcm/send/para-quitar'); return 'ok'; } catch (e) { return 'ERROR ' + e.message; }
}, STUB);
prueba('quitarSuscripcion(): da de baja el dispositivo', r3 === 'ok' && !(await (await fetch(STUB + '/_prueba/estado')).json()).suscripciones.some((s) => /para-quitar/.test(s.endpoint)), r3);
await post('/_prueba/sql', { q: 'truncate public.push_suscripciones' });   // no dejar dispositivos de prueba
// Si el servidor de avisos no está publicado, la app sigue funcionando.
const r4 = await p.evaluate(async () => {
  const { crear } = await import('/backend-supabase.js');
  const B = crear({ supabaseUrl: 'http://localhost:9', supabaseAnonKey: 'x', dominios: [] });
  const res = {};
  for (const k of ['avisos', 'clavePush']) { try { await B[k](); res[k] = 'ok'; } catch (e) { res[k] = 'falla controlada'; } }
  return res;
});
prueba('sin servidor de avisos: las llamadas fallan sin romper nada', r4.avisos === 'falla controlada' && r4.clavePush === 'falla controlada', JSON.stringify(r4));
prueba('sin errores de página', errs.length === 0, errs.join(' | '));
await p.close();

// ---------- franja en teléfonos ----------
async function telefono(nombre, ua, extra) {
  const q = await b.newPage();
  await q.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await q.setUserAgent(ua);
  const es = []; q.on('pageerror', (e) => es.push(e.message));
  await q.evaluateOnNewDocument(extra);
  await q.goto('http://localhost:5185/?demo', { waitUntil: 'networkidle0' });
  await q.evaluate(() => { localStorage.clear(); }); await q.reload({ waitUntil: 'networkidle0' });
  await q.evaluate(() => document.querySelectorAll('[data-demo]')[0].click());
  await q.waitForSelector('#composerPrincipal textarea'); await new Promise((r) => setTimeout(r, 500));
  const f = await q.evaluate(() => { const el = document.querySelector('.franja-avisos'); return el ? { texto: el.innerText.replace(/\s+/g, ' '), boton: !!el.querySelector('.franja-activar'), alto: el.offsetHeight, ancho: el.scrollWidth, pantalla: innerWidth } : null; });
  await q.screenshot({ path: `franja-${nombre}.png` });
  await q.close();
  return { f, es };
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
let t = await telefono('iphone-safari', IPHONE, () => { delete window.Notification; });
prueba('iPhone en Safari (sin instalar): explica cómo agregarla al inicio', /Agregar a pantalla de inicio/.test(t.f?.texto || '') && !t.f.boton, JSON.stringify(t.f));
prueba('iPhone: la franja cabe en la pantalla', t.f && t.f.ancho <= t.f.pantalla && t.es.length === 0, JSON.stringify([t.f, t.es]));
t = await telefono('iphone-instalada', IPHONE.replace(' Version/17.5', '').replace(' Safari/604.1', ''), () => { Object.defineProperty(navigator, 'standalone', { get: () => true }); const N = function () {}; N.permission = 'default'; N.requestPermission = async () => 'granted'; window.Notification = N; });
prueba('iPhone con la app instalada: ofrece Activar', /Activa las notificaciones/.test(t.f?.texto || '') && t.f.boton, JSON.stringify(t.f));
t = await telefono('android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', () => { const N = function () {}; N.permission = 'default'; N.requestPermission = async () => 'granted'; window.Notification = N; });
prueba('Android: ofrece Activar', /Activa las notificaciones/.test(t.f?.texto || '') && t.f.boton && t.es.length === 0, JSON.stringify([t.f, t.es]));
console.log(`\nCliente y teléfono: ${ok} pruebas bien, ${mal} mal`);
await b.close(); process.exit(mal ? 1 : 0);
