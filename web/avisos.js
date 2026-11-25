// Avisos de Charla: el número del ícono, el sonido y las notificaciones push.
//
// El número cuenta lo que te escribieron y no has visto: mensajes directos sin leer más
// menciones (@tú, @canal) sin leer. Baja cuando abres ese chat.
//   • App de Mac: el número va al ícono del Dock y los avisos son los nativos de macOS.
//   • Navegador y teléfono: avisos push (llegan con Charla cerrada) y número en el ícono
//     de la app instalada.
import { ico } from './iconos.js';

const CLAVE_SONIDO = 'charla-sonido';
const CLAVE_FRANJA = 'charla-franja-avisos';
const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const guardar = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (t) => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(t.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const conTope = (promesa, ms) => Promise.race([promesa, new Promise((_, mal) => setTimeout(() => mal(new Error('tiempo agotado')), ms))]);

export function crearAvisos({ B, S, aviso, tituloCanal, alVolver }) {
  const enMac = Boolean(window.charlaEscritorio);
  const ua = navigator.userAgent;
  const esIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const instalada = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const hayNotif = 'Notification' in window;
  const hayPush = !enMac && 'serviceWorker' in navigator && 'PushManager' in window && typeof B.clavePush === 'function';

  const menciones = {}; // canalId -> menciones sin leer
  let pushActivo = false;
  let registro = null;

  // ---------- ¿la persona está mirando? ----------
  // Charla puede quedar abierta en un chat mientras la persona no está: sin teclado ni
  // mouse durante un rato, lo que llegue cuenta como no visto (y avisa). Al volver, se lee.
  const SIN_ACTIVIDAD_MS = 90 * 1000;
  let ultimaActividad = Date.now();
  const activa = () => Date.now() - ultimaActividad < SIN_ACTIVIDAD_MS;
  function huboActividad() {
    const estaba = activa();
    ultimaActividad = Date.now();
    if (!estaba) { contarQueVeo(); alVolver?.(); }
  }
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(ev, huboActividad, { passive: true, capture: true });
  // Volver a la ventana o a la pestaña también cuenta: la persona acaba de llegar.
  addEventListener('focus', huboActividad);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) huboActividad(); });
  const viendo = (canalId) => S.actual?.id === canalId && !document.hidden && document.hasFocus() && activa();

  // ---------- número del ícono ----------
  function insignia() {
    let n = 0;
    for (const c of S.canales) n += c.es_dm ? S.noLeidos[c.id] || 0 : menciones[c.id] || 0;
    return n;
  }
  function pintar() {
    const n = insignia();
    const otros = Object.values(S.noLeidos).some((x) => x > 0);
    document.title = `${n ? `(${n}) ` : otros ? '• ' : ''}${S.actual ? `${tituloCanal(S.actual)} · ` : ''}Charla`;
    if (enMac) window.webkit.messageHandlers.charla.postMessage({ tipo: 'insignia', n });
    try {
      if (n > 0) navigator.setAppBadge?.(n)?.catch(() => {});
      else navigator.clearAppBadge?.()?.catch(() => {});
    } catch { /* este navegador no pone número en el ícono */ }
  }

  // ---------- sonido ----------
  let audio = null; let ultimoSonido = 0;
  const sonidoActivo = () => leer(CLAVE_SONIDO) !== 'no';
  function despertarAudio() {
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* sin audio */ }
  }
  // Los navegadores solo dejan sonar después de que la persona tocó la página.
  if (!enMac) for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, despertarAudio, { passive: true });
  function sonar(forzar = false) {
    if (enMac || (!forzar && !sonidoActivo())) return; // en la app de Mac suena el aviso nativo
    if (!audio || audio.state !== 'running') return;
    const ahora = Date.now();
    if (!forzar && ahora - ultimoSonido < 1500) return; // varios mensajes juntos: un solo sonido
    ultimoSonido = ahora;
    const t0 = audio.currentTime;
    for (const [frec, desde] of [[880, 0], [1174.66, 0.13]]) {
      const osc = audio.createOscillator(); const vol = audio.createGain();
      osc.type = 'sine'; osc.frequency.value = frec;
      vol.gain.setValueAtTime(0.0001, t0 + desde);
      vol.gain.exponentialRampToValueAtTime(0.16, t0 + desde + 0.015);
      vol.gain.exponentialRampToValueAtTime(0.0001, t0 + desde + 0.32);
      osc.connect(vol).connect(audio.destination);
      osc.start(t0 + desde); osc.stop(t0 + desde + 0.34);
    }
  }

  // ---------- push ----------
  function dispositivo() {
    const donde = esIOS ? 'iPhone o iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Otro';
    const con = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) || esIOS ? 'Safari' : '';
    return [donde, con, instalada ? 'app instalada' : ''].filter(Boolean).join(' · ');
  }
  async function suscribir() {
    if (!hayPush || !hayNotif || Notification.permission !== 'granted') return false;
    registro ||= await conTope(navigator.serviceWorker.ready, 8000);
    const clave = await B.clavePush();
    let sub = await registro.pushManager.getSubscription();
    const usada = sub?.options?.applicationServerKey;
    if (sub && usada && b64u(usada) !== clave) { await sub.unsubscribe(); sub = null; } // cambió la llave del servidor
    sub ||= await registro.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: deB64u(clave) });
    await B.guardarSuscripcion(sub.toJSON(), dispositivo());
    pushActivo = true;
    return true;
  }
  async function activar() {
    if (!hayNotif) return aviso(esIOS ? 'En el iPhone, agrega Charla a la pantalla de inicio y ábrela desde ese ícono.' : 'Este navegador no muestra notificaciones.');
    despertarAudio();
    const permiso = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
    pintarFranja();
    if (permiso !== 'granted') return aviso('Las notificaciones quedaron bloqueadas. Se activan en los ajustes del navegador para este sitio.');
    try {
      const conPush = await suscribir();
      aviso(conPush ? 'Notificaciones activadas en este dispositivo.' : 'Notificaciones activadas mientras Charla esté abierta.');
    } catch (e) {
      aviso(`Avisos activados solo con Charla abierta (${e.message}).`);
    }
  }
  async function probar() {
    try {
      const r = await B.probarAviso();
      aviso(r?.enviados ? 'Aviso de prueba enviado: debería aparecer en unos segundos.'
        : r?.dispositivos ? 'El servicio de avisos todavía no reconoce este dispositivo. Vuelve a probar en un minuto.'
          : 'No hay dispositivos con notificaciones activadas.');
    } catch (e) { aviso(e.message); }
  }

  // ---------- franja para activar ----------
  function pintarFranja() {
    document.querySelector('.franja-avisos')?.remove();
    if (enMac || leer(CLAVE_FRANJA) === 'cerrada') return;
    let texto = ''; let boton = '';
    if (esIOS && !instalada) texto = 'Para recibir notificaciones en el iPhone: toca Compartir, elige «Agregar a pantalla de inicio» y abre Charla desde ese ícono.';
    else if (hayNotif && Notification.permission === 'default') { texto = 'Activa las notificaciones para enterarte cuando te escriban.'; boton = '<button class="franja-activar">Activar</button>'; }
    if (!texto) return;
    const el = document.createElement('div');
    el.className = 'franja-avisos';
    el.innerHTML = `${ico('campana')}<span>${texto}</span>${boton}<button class="icono franja-cerrar" title="Ahora no">${ico('cerrar')}</button>`;
    el.querySelector('.franja-activar')?.addEventListener('click', activar);
    el.querySelector('.franja-cerrar').addEventListener('click', () => { guardar(CLAVE_FRANJA, 'cerrada'); el.remove(); });
    document.querySelector('.principal')?.prepend(el);
  }

  // Le cuenta al proceso de avisos qué chat está a la vista (para no avisar de lo que ya lees).
  function contarQueVeo() {
    const canal = S.actual && viendo(S.actual.id) ? S.actual.id : null;
    navigator.serviceWorker?.controller?.postMessage({ tipo: 'viendo', canal });
  }
  if ('serviceWorker' in navigator) {
    document.addEventListener('visibilitychange', contarQueVeo);
    addEventListener('focus', contarQueVeo); addEventListener('blur', contarQueVeo);
    navigator.serviceWorker.addEventListener('controllerchange', contarQueVeo);
  }

  return {
    insignia, pintar, sonar, viendo,
    pushActivo: () => pushActivo,
    menciones: (id) => menciones[id] || 0,

    async iniciar() {
      await this.recargar();
      pintarFranja();
      contarQueVeo();
      if (hayPush && hayNotif && Notification.permission === 'granted') suscribir().catch(() => {});
    },
    // Menciones sin leer según el servidor (al abrir y al volver de un corte largo).
    async recargar() {
      try {
        const filas = await B.avisos();
        for (const k of Object.keys(menciones)) delete menciones[k];
        for (const f of filas) if (f.menciones) menciones[f.channel_id] = f.menciones;
      } catch { /* el servidor aún no tiene los conteos: se cuenta solo lo que llegue en vivo */ }
      pintar();
    },
    // Llegó un mensaje de otra persona que es para mí (directo o mención).
    alLlegar(m, c) {
      if (viendo(c.id)) return;
      if (!c.es_dm) menciones[c.id] = (menciones[c.id] || 0) + 1;
      sonar();
      pintar();
    },
    // Se abrió o se leyó un chat: sus menciones quedan en cero y se retira su notificación.
    alLeer(canalId) {
      delete menciones[canalId];
      pintar();
      contarQueVeo();
      // (En la app de Mac no hay proceso de avisos: las notificaciones son las nativas.)
      navigator.serviceWorker?.getRegistration?.()
        ?.then((r) => r?.getNotifications?.({ tag: canalId }))
        .then((ns) => ns?.forEach((n) => n.close()))
        .catch(() => {});
    },
    // Opciones para el menú de la persona.
    opcionesMenu() {
      const ops = [];
      if (!enMac) {
        if (hayNotif && Notification.permission === 'granted') {
          if (pushActivo) ops.push({ id: 'avisos-probar', icono: 'campana', texto: 'Probar notificación' });
        } else if (hayNotif && Notification.permission === 'denied') ops.push({ id: 'avisos-bloqueados', icono: 'campana', texto: 'Notificaciones bloqueadas en el navegador' });
        else ops.push({ id: 'avisos-activar', icono: 'campana', texto: 'Activar notificaciones' });
        ops.push({ id: 'avisos-sonido', icono: 'campana', texto: sonidoActivo() ? 'Sonido de avisos: activado' : 'Sonido de avisos: desactivado' });
      }
      return ops;
    },
    alElegir(id) {
      if (id === 'avisos-activar') return activar();
      if (id === 'avisos-probar') return probar();
      if (id === 'avisos-bloqueados') return aviso('Se activan en los ajustes del navegador: permisos de este sitio → Notificaciones → Permitir.');
      if (id === 'avisos-sonido') {
        guardar(CLAVE_SONIDO, sonidoActivo() ? 'no' : 'si');
        despertarAudio();
        if (sonidoActivo()) setTimeout(() => sonar(true), 150);
        return aviso(sonidoActivo() ? 'Sonido activado.' : 'Sonido desactivado.');
      }
    },
    // Al cerrar sesión, este dispositivo deja de recibir los avisos de esta persona.
    async alSalir() {
      try {
        const sub = await (await navigator.serviceWorker?.getRegistration?.())?.pushManager?.getSubscription();
        if (sub) { await B.quitarSuscripcion?.(sub.endpoint).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
        navigator.clearAppBadge?.()?.catch(() => {});
      } catch { /* nada que quitar */ }
    },
  };
}
