// Número del ícono, avisos y sonido, en modo demo con tres personas (A recibe).
// Modo "mac": simula el puente de la app de Mac. Modo "web": navegador con Notification.
import puppeteer from 'puppeteer-core';
const U = process.argv[2] || 'http://localhost:5185/?demo';
let ok = 0, mal = 0;
const prueba = (n, c, d = '') => { if (c) ok++; else { mal++; console.log('  ✗', n, d); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

async function entrar(i, modo) {
  const p = await b.newPage(); await p.setViewport({ width: 1280, height: 800 });
  await p.evaluateOnNewDocument((modo) => {
    window.__mac = []; window.__notif = []; window.__sonidos = 0; window.__permisoPedido = 0;
    if (modo === 'mac') { window.charlaEscritorio = true; window.webkit = { messageHandlers: { charla: { postMessage: (m) => window.__mac.push(m) } } }; }
    if (modo === 'web' || modo === 'web-sin-permiso') {
      const N = function (titulo, op) { window.__notif.push({ titulo, ...op }); this.close = () => {}; };
      N.permission = modo === 'web' ? 'granted' : 'default';
      N.requestPermission = async () => { window.__permisoPedido++; N.permission = 'granted'; return 'granted'; };
      window.Notification = N;
      const AC = function () { this.state = 'running'; this.currentTime = 0; this.destination = {};
        this.createOscillator = () => { window.__sonidos++; return { frequency: {}, connect: (x) => x, start() {}, stop() {} }; };
        this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }); this.resume = () => {}; };
      window.AudioContext = AC;
    }
  }, modo);
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errs.push(m.text())); p.errs = errs;
  await p.goto(U, { waitUntil: 'networkidle0' });
  await p.evaluate((i) => document.querySelectorAll('[data-demo]')[i].click(), i);
  await p.waitForSelector('#composerPrincipal textarea'); await espera(400);
  await p.evaluate(() => document.querySelector('#btnYo').click());
  p.nombre = await p.evaluate(() => document.querySelector('.menu-cab b').textContent);
  p.usuario = await p.evaluate(() => document.querySelector('.menu-cab span').textContent.split('@')[1].trim());
  p.menu = await p.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].map((x) => x.textContent.trim()));
  await p.evaluate(() => document.querySelector('.menu-flotante')?.remove());
  return p;
}
const abrir = async (p, nombre, lista = '#listaDMs') => { await p.bringToFront(); await p.evaluate((n, l) => [...document.querySelectorAll(`${l} .item`)].find((x) => x.textContent.includes(n)).click(), nombre, lista); await espera(500); };
const enviar = async (p, t) => { await p.bringToFront(); await p.focus('#composerPrincipal textarea'); await p.keyboard.type(t); await p.keyboard.press('Enter'); await espera(350); };
const enviarAtras = async (p, t) => { await p.focus('#composerPrincipal textarea'); await p.keyboard.type(t); await p.keyboard.press('Enter'); await espera(350); };
const dice = async (de, donde, texto, lista) => { await abrir(de, donde, lista); await enviar(de, texto); };
const insignia = (p) => p.evaluate(() => (window.__mac.filter((m) => m.tipo === 'insignia').pop() || {}).n);
const avisosMac = (p) => p.evaluate(() => window.__mac.filter((m) => m.tipo === 'aviso').map((m) => m.titulo + ' | ' + m.cuerpo));
const titulo = (p) => p.title();
const limpiar = (p) => p.evaluate(() => { window.__mac = window.__mac.filter((m) => m.tipo === 'insignia').slice(-1); window.__notif = []; window.__sonidos = 0; });

const pre = await b.newPage(); await pre.goto(U); await pre.evaluate(() => localStorage.clear()); await pre.close();

// ================= App de Mac =================
let A = await entrar(0, 'mac'); const B = await entrar(1, 'x'); const C = await entrar(2, 'x');
await A.bringToFront(); await espera(300);
prueba('mac: al abrir, el ícono está sin número', (await insignia(A)) === 0, await insignia(A));
prueba('mac: el menú no ofrece activar notificaciones ni sonido (son nativos)', !A.menu.some((x) => /Activar notificaci|Sonido/i.test(x)), A.menu.join(' / '));
prueba('mac: el menú ofrece "Probar notificación"', A.menu.some((x) => /Probar notificación/.test(x)), A.menu.join(' / '));
{
  const antes = await A.evaluate(() => window.__mac.filter((m) => m.tipo === 'aviso').length);
  await A.evaluate(() => document.querySelector('#btnYo').click());
  await A.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].find((x) => /Probar notificación/.test(x.textContent)).click());
  await espera(300);
  const avisosMac = await A.evaluate(() => window.__mac.filter((m) => m.tipo === 'aviso'));
  const ultimo = avisosMac[avisosMac.length - 1];
  prueba('mac: "Probar notificación" manda un aviso nativo de prueba', avisosMac.length === antes + 1 && /^prueba-/.test(ultimo?.id) && ultimo?.titulo === 'Charla' && ultimo?.canal === '', JSON.stringify(ultimo));
  // El aviso de prueba no debe contarse en las pruebas que siguen.
  await A.evaluate(() => { document.querySelector('.menu-flotante')?.remove(); window.__mac = window.__mac.filter((m) => !/^prueba-/.test(m.id || '')); });
}

await dice(B, A.nombre, 'hola, ¿tienes un minuto?');
prueba('mac: 1 mensaje directo → ícono 1', (await insignia(A)) === 1, await insignia(A));
prueba('mac: aviso nativo con el nombre de quien escribe', (await avisosMac(A)).join() === `${B.nombre} | hola, ¿tienes un minuto?`, (await avisosMac(A)).join());
prueba('mac: el título de la ventana muestra (1)', (await titulo(A)).startsWith('(1) '), await titulo(A));
await enviar(B, 'segundo'); await enviar(B, 'tercero');
prueba('mac: 3 directos → ícono 3', (await insignia(A)) === 3, await insignia(A));
await dice(C, 'random', 'mensaje normal en un canal, sin mencionar a nadie', '#listaCanales');
prueba('mac: un mensaje de canal sin mención no sube el número', (await insignia(A)) === 3, await insignia(A));
prueba('mac: …ni avisa', (await avisosMac(A)).length === 3, (await avisosMac(A)).length);
await enviar(C, `oye @${A.usuario} mira esto`);
prueba('mac: una mención sube el número a 4', (await insignia(A)) === 4, await insignia(A));
prueba('mac: aviso de mención con el canal', (await avisosMac(A)).pop().startsWith(`${C.nombre} en # random`), (await avisosMac(A)).pop());
await dice(C, 'marketing', '@canal reunión a las 5', '#listaCanales');
prueba('mac: @canal cuenta como mención → 5', (await insignia(A)) === 5, await insignia(A));
await enviar(C, `escríbele a alguien@${A.usuario}.com`);
prueba('mac: un correo no es una mención', (await insignia(A)) === 5, await insignia(A));

// Recargar: los conteos vienen del servidor (demo) y deben coincidir.
await A.bringToFront(); await A.evaluate(() => localStorage.setItem('charla-ultimo-canal', [...document.querySelectorAll('#listaCanales [data-canal]')].find((x) => x.textContent.includes('general')).dataset.canal));
await A.reload({ waitUntil: 'networkidle0' }); await A.waitForSelector('#composerPrincipal textarea'); await espera(700);
prueba('mac: al recargar, el número sigue en 5', (await insignia(A)) === 5, await insignia(A));
await abrir(A, B.nombre);
prueba('mac: abrir el chat con B baja a 2', (await insignia(A)) === 2, await insignia(A));
await abrir(A, 'random', '#listaCanales');
prueba('mac: abrir #random baja a 1', (await insignia(A)) === 1, await insignia(A));
await abrir(A, 'marketing', '#listaCanales');
prueba('mac: abrir #marketing deja 0', (await insignia(A)) === 0, await insignia(A));
prueba('mac: título sin número', !/^\(/.test(await titulo(A)), await titulo(A));

// Mirando el chat: no avisa ni cuenta.
await abrir(B, A.nombre); await abrir(A, B.nombre); await A.mouse.move(500, 400); await limpiar(A);
await enviarAtras(B, 'te escribo mientras miras'); await espera(400);
prueba('mac: si estoy mirando ese chat, no avisa', (await avisosMac(A)).length === 0 && (await insignia(A)) === 0, `${(await avisosMac(A)).length} / ${await insignia(A)}`);
// No estoy en el computador: Charla quedó abierta en ese chat, sin tocarla.
await A.evaluate(() => { const real = Date.now.bind(Date); window.__real = real; Date.now = () => real() + 5 * 60 * 1000; });
await enviarAtras(B, 'no estás, ¿verdad?'); await espera(300);
prueba('mac: sin actividad 5 min → avisa aunque el chat esté abierto', (await avisosMac(A)).length === 1, (await avisosMac(A)).join());
prueba('mac: …y el ícono marca 1', (await insignia(A)) === 1, await insignia(A));
await enviarAtras(B, 'otro más'); await espera(300);
prueba('mac: segundo mensaje sin estar → 2', (await insignia(A)) === 2, await insignia(A));
await A.bringToFront(); await A.mouse.move(400, 300); await A.mouse.move(420, 320); await espera(500);
prueba('mac: al volver y mover el mouse, se da por leído → 0', (await insignia(A)) === 0, await insignia(A));
await A.evaluate(() => { Date.now = window.__real; }); await A.mouse.move(430, 330); await espera(200);
// Ventana sin foco (estoy en otra app).
await limpiar(A); await A.evaluate(() => { document.hasFocus = () => false; });
await enviarAtras(B, 'estás en otra app'); await espera(300);
prueba('mac: Charla sin foco → avisa y cuenta', (await avisosMac(A)).length === 1 && (await insignia(A)) === 1, `${(await avisosMac(A)).length} / ${await insignia(A)}`);
await A.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); }); await espera(400);
prueba('mac: al volver el foco a Charla → 0', (await insignia(A)) === 0, await insignia(A));
prueba('mac: sin errores de página', A.errs.length === 0, A.errs.join(' | '));
await A.close();

// ================= Navegador (sin push) =================
A = await entrar(0, 'web');
await abrir(A, 'general', '#listaCanales'); await A.mouse.click(600, 300); await espera(200); await limpiar(A);
await dice(B, A.nombre, 'ahora por navegador'); await espera(300);
let n = await A.evaluate(() => window.__notif);
prueba('web: notificación del navegador con título y texto', n.length === 1 && n[0].titulo === B.nombre && n[0].body === 'ahora por navegador', JSON.stringify(n));
prueba('web: suena (2 notas)', (await A.evaluate(() => window.__sonidos)) === 2, await A.evaluate(() => window.__sonidos));
prueba('web: título con (1)', (await titulo(A)).startsWith('(1) '), await titulo(A));
await enviar(B, 'seguido 1'); await enviar(B, 'seguido 2'); await espera(200);
prueba('web: varios mensajes juntos no repiten el sonido', (await A.evaluate(() => window.__sonidos)) === 2, await A.evaluate(() => window.__sonidos));
await limpiar(A); await espera(1600);
await dice(C, 'random', 'sin mención', '#listaCanales'); await espera(200);
prueba('web: mensaje de canal sin mención: ni aviso ni sonido', (await A.evaluate(() => window.__notif.length + window.__sonidos)) === 0);
prueba('web: el menú trae sonido y no "activar" (ya hay permiso)', A.menu.some((x) => /Sonido de avisos: activado/.test(x)) && !A.menu.some((x) => /Activar notificaciones/.test(x)), A.menu.join(' / '));
prueba('web: el menú ofrece "Probar notificación"', A.menu.some((x) => /Probar notificación/.test(x)), A.menu.join(' / '));
{
  const antes = await A.evaluate(() => window.__notif.length);
  await A.bringToFront(); await A.evaluate(() => document.querySelector('#btnYo').click());
  await A.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].find((x) => /Probar notificación/.test(x.textContent)).click());
  await espera(400);
  const ns = await A.evaluate(() => window.__notif);
  prueba('web sin push: "Probar notificación" muestra un aviso de prueba', ns.length === antes + 1 && ns[ns.length - 1].titulo === 'Charla' && ns[ns.length - 1].tag === 'prueba', JSON.stringify(ns[ns.length - 1]));
  await A.evaluate(() => { document.querySelector('.menu-flotante')?.remove(); window.__notif = window.__notif.filter((n) => n.tag !== 'prueba'); });
}
// Sonido desactivado desde el menú.
await A.bringToFront(); await A.evaluate(() => document.querySelector('#btnYo').click()); await A.evaluate(() => [...document.querySelectorAll('.menu-flotante [data-m]')].find((x) => /Sonido/.test(x.textContent)).click()); await espera(300);
await limpiar(A); await enviar(B, 'sin sonido'); await espera(300);
prueba('web: con el sonido desactivado, avisa pero no suena', (await A.evaluate(() => window.__notif.length)) === 1 && (await A.evaluate(() => window.__sonidos)) === 0, await A.evaluate(() => `${window.__notif.length}/${window.__sonidos}`));
prueba('web: sin errores de página', A.errs.length === 0, A.errs.join(' | '));
await A.close();

// ================= Navegador sin permiso todavía: franja para activar =================
A = await entrar(0, 'web-sin-permiso');
let franja = await A.evaluate(() => document.querySelector('.franja-avisos')?.innerText || '');
prueba('franja: invita a activar las notificaciones', /Activa las notificaciones/.test(franja) && /Activar/.test(franja), franja);
prueba('franja: el menú ofrece "Activar notificaciones"', A.menu.some((x) => /Activar notificaciones/.test(x)), A.menu.join(' / '));
const antes = await A.evaluate(() => document.querySelector('#mensajes').clientHeight);
await A.bringToFront(); await A.click('.franja-activar'); await espera(500);
prueba('franja: Activar pide el permiso una vez', (await A.evaluate(() => window.__permisoPedido)) === 1);
prueba('franja: desaparece al aceptar', !(await A.$('.franja-avisos')));
prueba('franja: el chat recupera su alto', (await A.evaluate(() => document.querySelector('#mensajes').clientHeight)) > antes);
await limpiar(A); await abrir(A, 'general', '#listaCanales'); await dice(B, A.nombre, 'después de activar'); await espera(300);
prueba('franja: después de activar, llegan las notificaciones', (await A.evaluate(() => window.__notif.length)) === 1);
prueba('franja: sin errores de página', A.errs.length === 0, A.errs.join(' | '));
// "Ahora no" se recuerda.
await A.evaluate(() => { localStorage.removeItem('charla-franja-avisos'); window.Notification.permission = 'default'; });
const A2 = await entrar(0, 'web-sin-permiso');
await A2.bringToFront(); await A2.click('.franja-cerrar'); await espera(200);
await A2.reload({ waitUntil: 'networkidle0' }); await A2.waitForSelector('#composerPrincipal textarea'); await espera(500);
prueba('franja: "Ahora no" se recuerda al recargar', !(await A2.$('.franja-avisos')));

prueba('B y C sin errores', B.errs.length + C.errs.length === 0, [...B.errs, ...C.errs].join(' | '));
console.log(`\nAvisos en la app: ${ok} pruebas bien, ${mal} mal`);
await b.close(); process.exit(mal ? 1 : 0);
