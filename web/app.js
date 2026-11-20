import { CONFIG } from './config.js';
import { ico } from './iconos.js';
import { crearAvisos } from './avisos.js';

// ?demo fuerza el modo demo aunque haya servidor configurado (para probar el diseño).
const conServidor = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey) && !new URLSearchParams(location.search).has('demo');
const B = (conServidor ? await import('./backend-supabase.js') : await import('./backend-demo.js')).crear(CONFIG);

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🔥'];
const MENCIONES_GRUPO = ['canal', 'todos', 'aqui'];
const AGRUPAR_MS = 5 * 60 * 1000;

const S = {
  yo: null,
  usuarios: new Map(),
  slack: new Map(), // personas de Slack importadas (slack_id -> {nombre, avatar_url})
  canales: [],
  actual: null,
  mensajes: new Map(), // canalId -> [mensajes]
  porId: new Map(),
  noLeidos: {},
  ultimo: {}, // canalId -> fecha del último mensaje
  cerrado: {}, // canalId -> fecha hasta la que cerré esa conversación
  hilo: null,
  enLinea: new Set(),
  escribiendo: new Map(), // `${canal}:${hilo}` -> Map(userId -> timeout)
  editando: null,
  borradores: {},
  urlsArchivo: new Map(), // ruta -> dirección ya resuelta
  tamImagen: new Map(), // ruta -> [ancho, alto] reales
};
// Número del ícono, sonido y notificaciones (ver avisos.js).
const AV = crearAvisos({ B, S, aviso: (t) => aviso(t), tituloCanal: (c) => tituloCanal(c), alVolver: () => marcarActualLeido() });

// ---------- utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORES = ['#6e56cf', '#d4673a', '#2f8f83', '#b54a7c', '#3f6fd1', '#8a6d1f', '#4d8a3a', '#9a4fd0'];
const colorDe = (id) => COLORES[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORES.length];
const iniciales = (n) => (n || '?').split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const hora = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
const pesoLegible = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function dia(iso) {
  const d = new Date(iso); const hoy = new Date(); const ayer = new Date(Date.now() - 864e5);
  if (d.toDateString() === hoy.toDateString()) return 'Hoy';
  if (d.toDateString() === ayer.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== hoy.getFullYear() && { year: 'numeric' }) });
}
function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  return dia(iso).toLowerCase();
}
const ms = (iso) => (iso ? Date.parse(iso) || 0 : 0);
const sinTildes = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const slugCanal = (s) => sinTildes(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
function usuario(id) { return S.usuarios.get(id); }
function autor(m) {
  if (m.bot_nombre) return { nombre: m.bot_nombre, bot: true };
  if (!m.user_id && m.slack_autor) {
    const s = S.slack.get(m.slack_autor);
    return { nombre: s?.nombre ?? 'Alguien de Slack', avatar_url: s?.avatar_url, id: m.slack_autor };
  }
  return usuario(m.user_id) || { nombre: 'Ex integrante', id: m.user_id };
}
function avatar(u, chico = false) {
  const cls = `av${chico ? ' chico' : ''}${u.bot ? ' bot' : ''}`;
  if (u.bot) return `<div class="${cls}">${ico('campana')}</div>`;
  if (u.avatar_url) return `<div class="${cls}"><img src="${esc(u.avatar_url)}" alt="" referrerpolicy="no-referrer"></div>`;
  return `<div class="${cls}" style="background:${colorDe(u.id)}">${esc(iniciales(u.nombre))}</div>`;
}
function aviso(texto) {
  document.querySelector('.aviso')?.remove();
  const el = document.createElement('div');
  el.className = 'aviso'; el.textContent = texto;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}
function meMenciona(texto) {
  const re = new RegExp(`(^|[\\s(])@(${[S.yo.usuario, ...MENCIONES_GRUPO].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
  return re.test(texto || '');
}

function formato(t) {
  let s = esc(t);
  const guardados = [];
  const guardar = (html) => `\u0000${guardados.push(html) - 1}\u0000`;
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => guardar(`<pre>${c.replace(/^\n/, '')}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c) => guardar(`<code>${c}</code>`));
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g, (u) => guardar(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`));
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])~([^~\n]+)~/g, '$1<del>$2</del>');
  s = s.replace(/(^|[\s(])@([a-z0-9._-]+)/gi, (m, pre, h) => {
    const k = h.toLowerCase();
    const u = [...S.usuarios.values()].find((x) => x.usuario.toLowerCase() === k);
    if (!u && !MENCIONES_GRUPO.includes(k)) return m;
    const mia = u?.id === S.yo.id || MENCIONES_GRUPO.includes(k);
    return `${pre}<span class="mencion${mia ? ' mia' : ''}">@${esc(h)}</span>`;
  });
  s = s.replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => guardados[i]);
}

// ---------- canales ----------
const otroDelDM = (c) => c.miembros.find((id) => id !== S.yo.id) || S.yo.id;
// DM importado de Slack con alguien que todavía no entró a Charla: solo estoy yo.
const dmSinContraparte = (c) => c.es_dm && c.nombre.startsWith('slack:') && !c.miembros.some((id) => id !== S.yo.id);
function tituloCanal(c) {
  if (!c) return '';
  if (!c.es_dm) return `${c.es_privado ? '🔒 ' : '# '}${c.nombre}`;
  if (dmSinContraparte(c)) return c.descripcion || 'Mensaje directo';
  const u = usuario(otroDelDM(c));
  return u ? (u.id === S.yo.id ? `${u.nombre} (tú)` : u.nombre) : 'Mensaje directo';
}
// Si hay más de una conversación con la misma persona, gana la más reciente.
function dmCon(userId) {
  return S.canales.filter((c) => c.es_dm && !dmSinContraparte(c) && c.miembros.includes(S.yo.id) && otroDelDM(c) === userId)
    .sort((a, b) => ms(S.ultimo[b.id]) - ms(S.ultimo[a.id]))[0];
}
function canal(id) { return S.canales.find((c) => c.id === id); }
// Vuelve a pedir los canales (me agregaron a uno, llegó un DM nuevo…).
async function traerCanales() {
  S.canales = await B.canales();
  if (S.actual) S.actual = canal(S.actual.id) || S.actual;
  pintarLateral();
}
// De cada canal donde estoy: no leídos, último mensaje y hasta cuándo cerré la conversación.
async function traerConversaciones() {
  const conv = await B.conversaciones();
  S.noLeidos = conv.noLeidos; S.ultimo = conv.ultimo; S.cerrado = conv.cerrado;
}
const soyMiembro = (c) => c.miembros.includes(S.yo.id);
const esGeneral = (c) => c.nombre === 'general';
// Un DM se lista si tiene mensajes y no lo cerré después del último (o si lo tengo abierto).
const dmCerrado = (c) => ms(S.cerrado[c.id]) >= ms(S.ultimo[c.id]);
const dmVisible = (c) => c.es_dm && soyMiembro(c) && (S.actual?.id === c.id || (Boolean(S.ultimo[c.id]) && !dmCerrado(c)));
function personaDM(c) {
  if (!dmSinContraparte(c)) return usuario(otroDelDM(c)) || { nombre: 'Mensaje directo', id: c.id };
  const s = [...S.slack.values()].find((x) => x.nombre === c.descripcion);
  return { nombre: c.descripcion || 'Mensaje directo', avatar_url: s?.avatar_url, id: s?.slack_id || c.id };
}
const canalDeInicio = () => S.canales.find((c) => esGeneral(c) && soyMiembro(c)) || S.canales.find((c) => !c.es_dm && soyMiembro(c)) || S.canales.find((c) => !c.es_dm);

// ---------- mensajes en memoria ----------
function guardarMensaje(m) {
  const previo = S.porId.get(m.id);
  if (previo) { Object.assign(previo, { ...m, reacciones: m.reacciones || previo.reacciones }); return previo; }
  const nuevo = { ...m, reacciones: m.reacciones || [] };
  S.porId.set(m.id, nuevo);
  if (ms(m.created_at) > ms(S.ultimo[m.channel_id])) S.ultimo[m.channel_id] = m.created_at;
  const lista = S.mensajes.get(m.channel_id);
  if (lista) {
    lista.push(nuevo);
    if (lista.length > 1 && lista[lista.length - 2].created_at > nuevo.created_at) lista.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  return nuevo;
}
function quitarMensaje(id) {
  const m = S.porId.get(id);
  if (!m) return null;
  const lista = S.mensajes.get(m.channel_id) || [];
  const ids = new Set([id, ...lista.filter((x) => x.parent_id === id).map((x) => x.id)]);
  S.mensajes.set(m.channel_id, lista.filter((x) => !ids.has(x.id)));
  ids.forEach((x) => S.porId.delete(x));
  return m;
}
async function cargarCanal(id) {
  if (S.mensajes.has(id)) return;
  const lista = await B.mensajes(id);
  if (S.mensajes.has(id)) return; // otra carga del mismo canal terminó primero
  // Mensajes de este canal que llegaron en vivo antes de abrirlo: están anotados pero
  // sin lista. Se sueltan y se vuelven a guardar; si no, quedaban fuera del chat.
  const sueltos = [...S.porId.values()].filter((m) => m.channel_id === id);
  sueltos.forEach((m) => S.porId.delete(m.id));
  S.mensajes.set(id, []);
  lista.forEach(guardarMensaje);
  sueltos.filter((m) => !S.porId.has(m.id) && (!lista.length || m.created_at >= lista[lista.length - 1].created_at)).forEach(guardarMensaje);
}

// ---------- ponerse al día ----------
// La conexión en vivo puede cortarse sin avisar (el computador durmió, cambió la red,
// venció la sesión). Cada minuto, y al volver a la ventana, se piden los mensajes
// posteriores al último visto: lo que no llegó en vivo aparece igual.
let ultimoVisto = null; // fecha (del servidor) del mensaje más nuevo que ya pasó por la app
let poniendoAlDia = false;
const TOPE_AL_DIA = 300;
async function ponerseAlDia() {
  if (poniendoAlDia || !S.yo || !ultimoVisto || !B.novedades) return;
  poniendoAlDia = true;
  try {
    await B.revisarConexion?.();
    const nuevos = await B.novedades(ultimoVisto, TOPE_AL_DIA);
    if (nuevos.length >= TOPE_AL_DIA) {
      // Estuvo mucho tiempo sin conexión: se vuelve a cargar todo.
      ultimoVisto = nuevos[nuevos.length - 1].created_at;
      S.mensajes.clear(); S.porId.clear();
      await traerConversaciones();
      await AV.recargar();
      ultimoVisto = (await B.ultimaFecha()) || ultimoVisto;
      await traerCanales(); if (S.actual) abrirCanal(S.actual.id);
    } else for (const m of nuevos) if (!S.porId.has(m.id)) await handlers.onMensaje('INSERT', m);
  } catch { /* sin red: se reintenta en la próxima vuelta */ }
  poniendoAlDia = false;
}

// ---------- pantalla de entrada ----------
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#6e56cf"/><path d="M18 22a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-9l-8 7v-7h-1a6 6 0 0 1-4-1.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="26" cy="28" r="2.2" fill="#fff"/><circle cx="32" cy="28" r="2.2" fill="#fff"/><circle cx="38" cy="28" r="2.2" fill="#fff"/></svg>`;

const G_LOGO = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

function errorDeURL() {
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const e = p.get('error_description');
  if (!e) return '';
  history.replaceState(null, '', location.pathname);
  return /database error/i.test(e) ? `Solo pueden entrar cuentas @${CONFIG.dominios.join(', @')}.` : e;
}

const DESCARGA_MAC = 'https://github.com/francoyanine/charla/releases/latest/download/Charla.dmg';
const enlaceMac = (clase) => (!window.charlaEscritorio && /Macintosh/.test(navigator.userAgent) && conServidor
  ? `<p class="${clase}"><a href="${DESCARGA_MAC}">Descargar Charla para Mac</a></p>` : '');

function pintarEntrada(error = '') {
  const cuerpo = conServidor
    ? `<button class="boton-google" id="btnGoogle">${G_LOGO}<span>Iniciar sesión con Google</span></button>
       <p class="nota">Usa tu cuenta <b>@${esc(CONFIG.dominios.join(', @'))}</b></p>`
    : `<div class="lista-demo">${B.usuariosDemo().map((u) => `<button data-demo="${u.id}">${avatar(u, true)}<span>Entrar como <b>${esc(u.nombre)}</b></span></button>`).join('')}</div>
       <p class="nota">Modo demo: abre otra pestaña y entra como otra persona para ver el tiempo real.</p>`;
  app.innerHTML = `<div class="entrada"><div class="entrada-marca">${LOGO}<span>Charla</span></div>
    <div class="tarjeta-entrada"><h1>Inicia sesión en ${esc(CONFIG.nombreEspacio)}</h1><p>Te recomendamos usar tu correo de trabajo.</p>${cuerpo}${error ? `<p class="error">${esc(error)}</p>` : ''}${enlaceMac('nota')}</div></div>`;
  $('#btnGoogle')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    B.entrar().catch((err) => pintarEntrada(err.message));
    if (window.charlaEscritorio) setTimeout(() => { e.target.disabled = false; }, 4000);
  });
  app.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => B.entrarDemo(b.dataset.demo)));
}

// ---------- estructura ----------
function pintarEstructura() {
  app.innerHTML = `
  <div class="shell" id="shell">
    <header class="barra-superior">
      <button class="icono btn-menu" id="btnMenu" title="Canales">${ico('menu')}</button>
      <button class="buscar" id="btnBuscar">${ico('buscar')}<span>Buscar en ${esc(CONFIG.nombreEspacio)}</span><kbd>⌘K</kbd></button>
    </header>
    <nav class="riel">
      <div class="riel-espacio" title="${esc(CONFIG.nombreEspacio)}">${esc(iniciales(CONFIG.nombreEspacio))}</div>
      <button class="riel-item activo" data-riel="inicio">${ico('home')}<span>Inicio</span></button>
      <button class="riel-item" data-riel="dms">${ico('dm')}<span>MD</span></button>
      <button class="riel-item" data-riel="actividad">${ico('campana')}<span>Actividad</span></button>
      <div class="riel-espacio-libre"></div>
      <button class="riel-yo" id="btnYo" title="Tu perfil"></button>
    </nav>
    <aside class="lateral">
      <div class="espacio"><button class="espacio-nombre" id="btnEspacio">${esc(CONFIG.nombreEspacio)} ${ico('abajo', 'chico')}</button>${conServidor ? '' : '<span class="pastilla-demo">demo</span>'}<button class="icono icono-claro" id="btnNuevoMensaje" title="Nuevo mensaje">${ico('nuevo')}</button></div>
      <nav class="listas">
        <div class="seccion" data-seccion="canales">${ico('abajo', 'caret')}<span>Canales</span></div>
        <ul id="listaCanales"></ul>
        <button class="item agregar" id="btnAgregarCanal"><span class="hash cuadro">${ico('mas')}</span><span class="nombre">Agregar canales</span></button>
        <div class="seccion" data-seccion="dms" id="seccionDMs">${ico('abajo', 'caret')}<span>Mensajes directos</span></div>
        <ul id="listaDMs"></ul>
        <button class="item agregar" id="btnNuevoDM"><span class="hash cuadro">${ico('mas')}</span><span class="nombre">Nuevo mensaje</span></button>
      </nav>
      ${enlaceMac('descarga-mac')}
    </aside>
    <main class="principal">
      <header class="cabecera" id="cabecera"></header>
      <div class="mensajes" id="mensajes"></div>
      <div class="escribiendo" id="escribiendoPrincipal"></div>
      <div id="composerPrincipal"></div>
    </main>
    <aside class="hilo" id="hilo" hidden></aside>
  </div>`;
  $('#btnBuscar').addEventListener('click', () => abrirBusqueda());
  $('#btnAgregarCanal').addEventListener('click', (e) => menu(e.currentTarget, [
    { ico: 'mas', texto: 'Crear un canal', accion: abrirNuevoCanal },
    { ico: 'buscar', texto: 'Explorar canales', accion: abrirExplorar },
  ]));
  $('#btnNuevoDM').addEventListener('click', abrirNuevoMensaje);
  $('#btnMenu').addEventListener('click', () => $('#shell').classList.toggle('menu-abierto'));
  $('#btnYo').addEventListener('click', menuYo);
  $('#btnEspacio').addEventListener('click', menuYo);
  $('#btnNuevoMensaje').addEventListener('click', abrirNuevoMensaje);
  app.querySelectorAll('.seccion').forEach((sec) => sec.addEventListener('click', () => {
    sec.classList.toggle('plegada');
    sec.nextElementSibling.hidden = sec.classList.contains('plegada');
  }));
  app.querySelectorAll('[data-riel]').forEach((b) => b.addEventListener('click', () => {
    app.querySelectorAll('[data-riel]').forEach((x) => x.classList.toggle('activo', x === b));
    if (b.dataset.riel === 'dms') $('#seccionDMs').scrollIntoView({ block: 'start', behavior: 'smooth' });
    if (b.dataset.riel === 'actividad') abrirBusqueda(`@${S.yo.usuario}`);
    $('#shell').classList.add('menu-abierto');
  }));
  $('#listaCanales').addEventListener('click', (e) => { const b = e.target.closest('[data-canal]'); if (b) abrirCanal(b.dataset.canal); });
  $('#listaDMs').addEventListener('click', (e) => {
    const x = e.target.closest('[data-cerrar-dm]'); if (x) return cerrarDM(canal(x.dataset.cerrarDm));
    const b = e.target.closest('[data-canal]'); if (b) abrirCanal(b.dataset.canal);
  });
  $('#cabecera').addEventListener('click', (e) => {
    const c = S.actual; if (!c) return;
    if (e.target.closest('#btnResumen')) return abrirResumen();
    if (e.target.closest('#btnMiembros')) return abrirDetalles(c);
    const h = e.target.closest('#tituloCanal'); if (!h) return;
    if (c.es_dm) menu(h, [{ ico: 'cerrar', texto: 'Cerrar conversación', accion: () => cerrarDM(c) }]); else abrirDetalles(c);
  });
  $('#composerPrincipal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unirse]'); if (!b || !S.actual) return;
    if (b.dataset.unirse === 'detalles') abrirDetalles(S.actual); else unirse(S.actual);
  });
  $('#mensajes').addEventListener('click', clickMensaje);
  $('#hilo').addEventListener('click', clickMensaje);
  for (const cont of [$('#mensajes'), $('#hilo')]) {
    cont.addEventListener('load', alCargarImagen, true);
    cont.addEventListener('scroll', alDesplazar, { capture: true, passive: true });
  }
}

// Como en Slack: solo los canales donde estoy y las conversaciones con mensajes,
// la más reciente arriba. Un canal público que estoy mirando sin ser miembro
// aparece mientras lo tengo abierto.
function pintarLateral() {
  const canales = S.canales.filter((c) => !c.es_dm && (soyMiembro(c) || S.actual?.id === c.id)).sort(porNombre);
  $('#listaCanales').innerHTML = canales.map((c) => {
    const n = soyMiembro(c) ? S.noLeidos[c.id] || 0 : 0;
    return `<li><button class="item${S.actual?.id === c.id ? ' activo' : ''}${n ? ' sin-leer' : ''}${soyMiembro(c) ? '' : ' de-visita'}" data-canal="${c.id}"><span class="hash">${c.es_privado ? ico('candado', 'chico') : '#'}</span><span class="nombre">${esc(c.nombre)}</span></button></li>`;
  }).join('');
  const dms = S.canales.filter(dmVisible).sort((a, b) => ms(S.ultimo[b.id]) - ms(S.ultimo[a.id]));
  $('#listaDMs').innerHTML = dms.map((c) => {
    const n = S.noLeidos[c.id] || 0; const u = personaDM(c); const sinEntrar = dmSinContraparte(c);
    return `<li class="fila-dm"><button class="item${S.actual?.id === c.id ? ' activo' : ''}${n ? ' sin-leer' : ''}" data-canal="${c.id}"${sinEntrar ? ' title="Todavía no entra a Charla"' : ''}><span class="av-dm">${avatar(u, true)}<span class="punto${!sinEntrar && S.enLinea.has(u.id) ? ' on' : ''}"></span></span><span class="nombre">${esc(u.nombre)}${u.id === S.yo.id ? ' <small>tú</small>' : ''}</span>${n ? `<span class="insignia">${n}</span>` : ''}</button><button class="cerrar-dm" data-cerrar-dm="${c.id}" title="Cerrar conversación" aria-label="Cerrar conversación con ${esc(u.nombre)}">${ico('cerrar', 'chico')}</button></li>`;
  }).join('');
  AV.pintar(); // título de la ventana y número del ícono
}

function pintarYo() {
  $('#btnYo').innerHTML = `${avatar(S.yo)}<span class="punto on"></span>`;
}

// Menú flotante pegado a un botón. items: [{ id, ico, texto, accion }].
function menu(ancla, items, cab = '') {
  document.querySelector('.menu-flotante')?.remove();
  const el = document.createElement('div');
  el.className = 'menu-flotante';
  el.innerHTML = cab + items.map((it, i) => `<button data-i="${i}" data-m="${esc(it.id || '')}">${it.ico ? ico(it.ico) : ''}${esc(it.texto)}</button>`).join('');
  document.body.append(el);
  const r = ancla.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = r.top > innerHeight / 2 ? `${r.top - el.offsetHeight - 6}px` : `${r.bottom + 6}px`;
  el.addEventListener('click', (ev) => { const b = ev.target.closest('[data-i]'); if (!b) return; el.remove(); items[+b.dataset.i].accion(); });
  setTimeout(() => addEventListener('mousedown', function fuera(ev) { if (!el.contains(ev.target)) { el.remove(); removeEventListener('mousedown', fuera); } }), 0);
}

function menuYo(e) {
  e.stopPropagation();
  menu(e.currentTarget, [
    ...AV.opcionesMenu().map((o) => ({ id: o.id, ico: o.icono, texto: o.texto, accion: () => AV.alElegir(o.id) })),
    conServidor && { id: 'importar', ico: 'importar', texto: 'Importar desde Slack', accion: abrirImportar },
    { id: 'salir', ico: 'salir', texto: `Cerrar sesión en ${CONFIG.nombreEspacio}`, accion: async () => { await AV.alSalir(); B.salir(); } },
  ].filter(Boolean), `<div class="menu-cab">${avatar(S.yo)}<div><b>${esc(S.yo.nombre)}</b><span><i class="punto on"></i> Activo · @${esc(S.yo.usuario)}</span></div></div>`);
}

function pintarCabecera() {
  const c = S.actual;
  const desc = c.es_dm ? (S.enLinea.has(otroDelDM(c)) ? 'En línea' : 'Desconectado') : c.descripcion;
  const miembros = c.es_dm ? [] : c.miembros.map(usuario).filter(Boolean);
  const titulo = c.es_dm
    ? `<span class="av-dm">${avatar(personaDM(c), true)}<span class="punto${S.enLinea.has(otroDelDM(c)) ? ' on' : ''}"></span></span>${esc(tituloCanal(c))}`
    : `<span class="hash-titulo">${c.es_privado ? ico('candado') : '#'}</span>${esc(c.nombre)}`;
  $('#cabecera').innerHTML = `
    <div class="cab-fila">
      <h2><button id="tituloCanal" title="${esc(c.es_dm ? desc : 'Ver detalles del canal')}">${titulo} ${ico('abajo', 'chico')}</button></h2>
      ${c.es_dm ? '' : `<button class="miembros" id="btnMiembros" title="Ver miembros">${miembros.slice(0, 3).map((u) => avatar(u, true)).join('')}<span>${miembros.length}</span></button>`}
    </div>
    <div class="pestanas">
      <button class="pestana activa">${ico('dm')}Mensajes</button>
      <button class="pestana" id="btnResumen" title="Resumen de las últimas 24 horas con Claude">${ico('chispa')}Resumen</button>
      ${desc && !c.es_dm ? `<span class="desc">${esc(desc)}</span>` : ''}
    </div>`;
}

// ---------- mensajes ----------
function htmlMensaje(m, previo, { enHilo = false } = {}) {
  const a = autor(m);
  const compacto = previo && !previo.bot_nombre === !m.bot_nombre && previo.user_id === m.user_id && previo.bot_nombre === m.bot_nombre
    && new Date(m.created_at) - new Date(previo.created_at) < AGRUPAR_MS && dia(previo.created_at) === dia(m.created_at);
  const mio = m.user_id === S.yo.id;
  const mencionado = !mio && meMenciona(m.texto);
  const respuestas = enHilo ? [] : (S.mensajes.get(m.channel_id) || []).filter((x) => x.parent_id === m.id);

  const grupos = new Map();
  for (const r of m.reacciones) { if (!grupos.has(r.emoji)) grupos.set(r.emoji, []); grupos.get(r.emoji).push(r.user_id); }
  const reacciones = grupos.size ? `<div class="reacciones">${[...grupos].map(([e, ids]) => `<button class="reaccion${ids.includes(S.yo.id) ? ' mia' : ''}" data-accion="reaccion" data-emoji="${e}" title="${esc(ids.map((id) => usuario(id)?.nombre || '?').join(', '))}">${e}<b>${ids.length}</b></button>`).join('')}</div>` : '';

  let archivo = '';
  if (m.archivo) {
    const f = m.archivo;
    archivo = f.tipo?.startsWith('image/')
      ? `<div class="archivo">${htmlImagen(f)}</div>`
      : `<div class="archivo"><a class="tarjeta-archivo" data-ruta="${esc(f.ruta)}" data-nombre="${esc(f.nombre)}" target="_blank" rel="noopener"><span class="ext">${esc((f.nombre.split('.').pop() || 'arch').slice(0, 4))}</span><span>${esc(f.nombre)}<small>${pesoLegible(f.tamano)}</small></span></a></div>`;
  }

  const cuerpo = S.editando === m.id
    ? `<div class="editor-msg"><textarea rows="2">${esc(m.texto)}</textarea><small>Enter para guardar · Esc para cancelar</small></div>`
    : `${m.texto ? `<div class="msg-texto">${formato(m.texto)}${m.editado ? ' <span class="editado">(editado)</span>' : ''}</div>` : ''}${archivo}`;

  const ultima = respuestas[respuestas.length - 1];
  const hilo = respuestas.length ? `<button class="respuestas" data-accion="hilo">${[...new Set(respuestas.map((r) => r.user_id))].slice(0, 5).map((id) => avatar(usuario(id) || { id, nombre: '?' }, true)).join('')}<b>${respuestas.length} ${respuestas.length === 1 ? 'respuesta' : 'respuestas'}</b><span class="ultima">Última respuesta ${hace(ultima.created_at)}</span><span class="ver-hilo">Ver hilo ${ico('derecha', 'chico')}</span></button>` : '';

  const rapidas = ['✅', '👀', '🙌'].map((e) => `<button class="icono" data-accion="reaccion" data-emoji="${e}" title="Reaccionar con ${e}">${e}</button>`).join('');
  const acciones = `<div class="msg-acciones">
      ${rapidas}
      <button class="icono" data-accion="emoji" title="Agregar reacción">${ico('emoji')}</button>
      ${enHilo ? '' : `<button class="icono" data-accion="hilo" title="Responder en el hilo">${ico('hilo')}</button>`}
      ${mio ? `<button class="icono" data-accion="editar" title="Editar mensaje">${ico('editar')}</button><button class="icono peligro" data-accion="borrar" title="Eliminar mensaje">${ico('borrar')}</button>` : ''}
    </div>`;

  return `<div class="msg${compacto ? ' compacto' : ''}${mencionado ? ' mencionado' : ''}" data-id="${m.id}">
    ${compacto ? `<div class="msg-hora-lado">${hora(m.created_at)}</div>` : avatar(a)}
    <div class="msg-cuerpo">
      ${compacto ? '' : `<div class="msg-meta"><b>${esc(a.nombre)}</b>${a.bot ? '<span class="etiqueta-bot">APLICACIÓN</span>' : ''}<time title="${new Date(m.created_at).toLocaleString('es')}">${hora(m.created_at)}</time></div>`}
      ${cuerpo}${reacciones}${hilo}
    </div>
    ${S.editando === m.id ? '' : acciones}
  </div>`;
}

// Una imagen ya vista se vuelve a pintar con su dirección y su tamaño reservado: así
// repintar la lista (al enviar, al llegar un mensaje) no mueve el chat.
const LADO_IMAGEN = 360;
function htmlImagen(f) {
  const url = S.urlsArchivo.get(f.ruta); const tam = S.tamImagen.get(f.ruta);
  if (!url || !tam) return `<img data-ruta="${esc(f.ruta)}" alt="${esc(f.nombre)}">`;
  const [w, h] = tam; const k = Math.min(1, LADO_IMAGEN / w, LADO_IMAGEN / h);
  return `<img data-ruta="${esc(f.ruta)}" data-listo="1" src="${esc(url)}" alt="${esc(f.nombre)}" style="width:${Math.round(w * k)}px;aspect-ratio:${w}/${h}">`;
}

// El chat queda "pegado" al final mientras la persona no suba a leer. Si una imagen
// termina de cargar y alarga la lista, se vuelve a bajar.
function fijarAlFinal(el, pegado) {
  el.dataset.pegado = pegado ? '1' : '';
  if (pegado) el.scrollTop = el.scrollHeight;
  el.dataset.alto = el.scrollHeight;
}
const vigia = new ResizeObserver((entradas) => {
  for (const e of entradas) { const el = e.target.closest('.mensajes'); if (el?.dataset.pegado) fijarAlFinal(el, true); }
});
// Pone la lista dentro de un envoltorio y lo vigila; deja de vigilar el anterior.
function ponerLista(el, html) {
  if (el._lista) vigia.unobserve(el._lista);
  el.innerHTML = `<div class="lista-msg">${html}</div>`;
  el._lista = el.firstElementChild;
  if (!el._vigilado) { el._vigilado = true; vigia.observe(el); }
  vigia.observe(el._lista);
}
function alDesplazar(e) {
  const el = e.target.closest?.('.mensajes'); if (!el) return;
  if (el.dataset.pegado && String(el.scrollHeight) !== el.dataset.alto) return fijarAlFinal(el, true); // creció el contenido
  el.dataset.pegado = cercaDelFinal(el) ? '1' : ''; el.dataset.alto = el.scrollHeight;
}
function alCargarImagen(e) {
  const img = e.target; if (img.tagName !== 'IMG' || !img.dataset.ruta) return;
  if (img.naturalWidth) S.tamImagen.set(img.dataset.ruta, [img.naturalWidth, img.naturalHeight]);
  const el = img.closest('.mensajes');
  if (el?.dataset.pegado) fijarAlFinal(el, true);
}

function htmlLista(lista, opciones) {
  let html = ''; let previo = null;
  for (const m of lista) {
    if (!previo || dia(previo.created_at) !== dia(m.created_at)) { html += `<div class="dia"><span>${esc(dia(m.created_at))}</span></div>`; previo = null; }
    html += htmlMensaje(m, previo, opciones);
    previo = m;
  }
  return html;
}

const cercaDelFinal = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 120;

function pintarMensajes({ alFinal = false } = {}) {
  const el = $('#mensajes'); if (!el || !S.actual) return;
  const pegado = alFinal || cercaDelFinal(el);
  const arriba = el.scrollTop;
  const lista = (S.mensajes.get(S.actual.id) || []).filter((m) => !m.parent_id);
  ponerLista(el, lista.length ? htmlLista(lista)
    : `<div class="inicio-canal"><h3>${S.actual.es_dm ? '' : '<span class="hash-titulo">#</span>'}${esc(tituloCanal(S.actual).replace(/^# /, ''))}</h3><p>${S.actual.es_dm ? 'Este es el comienzo de tu historial de mensajes directos.' : `Este es el comienzo del canal <b>#${esc(S.actual.nombre)}</b>. ${esc(S.actual.descripcion || '')}`}</p></div>`);
  resolverArchivos(el);
  if (!pegado) el.scrollTop = arriba;
  fijarAlFinal(el, pegado);
  activarEditor(el);
}

function pintarHilo({ alFinal = false } = {}) {
  const el = $('#hilo');
  const padre = S.hilo && S.porId.get(S.hilo);
  if (!padre) { el.hidden = true; S.hilo = null; return; }
  const yaAbierto = !el.hidden && el.dataset.padre === padre.id;
  if (!yaAbierto) {
    el.hidden = false; el.dataset.padre = padre.id;
    el.innerHTML = `<header class="cabecera cabecera-hilo"><div class="titulos"><h2>Hilo</h2><div class="desc">${esc(tituloCanal(canal(padre.channel_id)))}</div></div><button class="icono" data-accion="cerrar-hilo" title="Cerrar">${ico('cerrar')}</button></header>
      <div class="mensajes" id="mensajesHilo"></div><div class="escribiendo" id="escribiendoHilo"></div><div id="composerHilo"></div>`;
    montarComposer($('#composerHilo'), { canalId: padre.channel_id, parentId: padre.id, placeholder: 'Responder…' });
    alFinal = true;
  }
  const cont = $('#mensajesHilo');
  const pegado = alFinal || cercaDelFinal(cont);
  const respuestas = (S.mensajes.get(padre.channel_id) || []).filter((m) => m.parent_id === padre.id);
  ponerLista(cont, htmlMensaje(padre, null, { enHilo: true })
    + `<div class="separador">${respuestas.length} ${respuestas.length === 1 ? 'respuesta' : 'respuestas'}</div>`
    + respuestas.map((m, i) => htmlMensaje(m, respuestas[i - 1] || null, { enHilo: true })).join(''));
  resolverArchivos(cont);
  fijarAlFinal(cont, pegado);
  activarEditor(cont);
}

async function resolverArchivos(el) {
  for (const n of el.querySelectorAll('[data-ruta]:not([data-listo])')) {
    n.dataset.listo = '1';
    const m = S.porId.get(n.closest('.msg')?.dataset.id);
    if (!m?.archivo) continue;
    try {
      const url = await B.urlArchivo(m.archivo);
      S.urlsArchivo.set(m.archivo.ruta, url);
      if (n.tagName === 'IMG') n.src = url; else { n.href = url; n.download = m.archivo.nombre; }
    } catch { /* el archivo ya no existe */ }
  }
}

function activarEditor(el) {
  const ta = el.querySelector('.editor-msg textarea');
  if (!ta) return;
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { S.editando = null; repintar(); }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const id = S.editando; const texto = ta.value.trim();
      S.editando = null;
      const m = S.porId.get(id);
      if (texto && m && texto !== m.texto) { Object.assign(m, { texto, editado: true }); B.editar(id, texto).catch((err) => aviso(err.message)); }
      repintar();
    }
  });
}

function repintar() { pintarMensajes(); if (S.hilo) pintarHilo(); }

async function clickMensaje(e) {
  const img = e.target.closest('.archivo img');
  if (img?.src) { const v = document.createElement('div'); v.className = 'visor'; v.innerHTML = `<img src="${img.src}" alt="">`; v.onclick = () => v.remove(); document.body.append(v); return; }
  const b = e.target.closest('[data-accion]'); if (!b) return;
  const accion = b.dataset.accion;
  if (accion === 'cerrar-hilo') { S.hilo = null; $('#hilo').hidden = true; return; }
  const id = b.closest('.msg')?.dataset.id; const m = S.porId.get(id); if (!m) return;
  if (accion === 'hilo') { S.hilo = m.id; pintarHilo({ alFinal: true }); $('#composerHilo textarea')?.focus(); }
  else if (accion === 'reaccion') alternarReaccion(m, b.dataset.emoji);
  else if (accion === 'emoji') selectorEmoji(b, (emoji) => alternarReaccion(m, emoji));
  else if (accion === 'editar') { S.editando = m.id; repintar(); }
  else if (accion === 'borrar') {
    if (!confirm('¿Borrar este mensaje? No se puede deshacer.')) return;
    quitarMensaje(m.id); repintar();
    B.borrar(m.id).catch((err) => aviso(err.message));
  }
}

function alternarReaccion(m, emoji) {
  const i = m.reacciones.findIndex((r) => r.user_id === S.yo.id && r.emoji === emoji);
  if (i >= 0) m.reacciones.splice(i, 1); else m.reacciones.push({ message_id: m.id, user_id: S.yo.id, emoji });
  repintar();
  B.reaccionar(m.id, emoji).catch((err) => aviso(err.message));
}

function selectorEmoji(ancla, elegir) {
  document.querySelector('.selector-emoji')?.remove();
  const el = document.createElement('div');
  el.className = 'selector-emoji';
  el.innerHTML = EMOJIS.map((e) => `<button>${e}</button>`).join('');
  document.body.append(el);
  const r = ancla.getBoundingClientRect();
  el.style.top = `${Math.max(8, r.top - el.offsetHeight - 6)}px`;
  el.style.left = `${Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.right - el.offsetWidth))}px`;
  el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { elegir(b.textContent); el.remove(); } });
  setTimeout(() => addEventListener('mousedown', function fuera(e) { if (!el.contains(e.target)) { el.remove(); removeEventListener('mousedown', fuera); } }), 0);
}

// ---------- composer ----------
function montarComposer(cont, { canalId, parentId = null, placeholder }) {
  const clave = `${canalId}:${parentId || ''}`;
  cont.innerHTML = `<div class="composer">
    <div class="formato">
      <button class="icono" data-fmt="*" title="Negrita">${ico('negrita')}</button>
      <button class="icono" data-fmt="_" title="Cursiva">${ico('cursiva')}</button>
      <button class="icono" data-fmt="~" title="Tachado">${ico('tachado')}</button>
      <span class="sep"></span>
      <button class="icono" data-fmt="enlace" title="Enlace">${ico('enlace')}</button>
      <span class="sep"></span>
      <button class="icono" data-fmt="lista" title="Lista">${ico('lista')}</button>
      <span class="sep"></span>
      <button class="icono" data-fmt="\`" title="Código">${ico('codigo')}</button>
    </div>
    <div class="adjunto-prev" hidden><span></span><button class="icono" title="Quitar">${ico('cerrar')}</button></div>
    <textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
    <div class="composer-barra">
      <label class="icono redondo" title="Adjuntar archivo"><input type="file" hidden>${ico('mas')}</label>
      <button class="icono" data-ins="emoji" title="Emoji">${ico('emoji')}</button>
      <button class="icono" data-ins="@" title="Mencionar a alguien">${ico('arroba')}</button>
      <span class="ayuda"></span>
      <button class="enviar" disabled title="Enviar ahora">${ico('enviar')}</button>
    </div>
    <div class="sugerencias" hidden></div>
  </div>`;
  const ta = $('textarea', cont); const btn = $('.enviar', cont); const input = $('input[type=file]', cont);
  const prev = $('.adjunto-prev', cont); const sug = $('.sugerencias', cont);
  let archivo = null; let ultimoAviso = 0; let opciones = []; let sel = 0;

  const ajustar = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`; btn.disabled = !ta.value.trim() && !archivo; };
  ta.value = S.borradores[clave] || ''; ajustar();

  function ponerArchivo(f) {
    archivo = f;
    prev.hidden = !f;
    if (f) $('span', prev).textContent = `📎 ${f.name} · ${pesoLegible(f.size)}`;
    ajustar();
  }
  input.addEventListener('change', () => { ponerArchivo(input.files[0] || null); input.value = ''; ta.focus(); });
  $('button', prev).addEventListener('click', () => ponerArchivo(null));
  ta.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); ponerArchivo(f); } });
  cont.addEventListener('dragover', (e) => e.preventDefault());
  cont.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) ponerArchivo(f); });

  function sugerir() {
    const antes = ta.value.slice(0, ta.selectionStart);
    const m = antes.match(/(^|\s)@([\p{L}0-9._-]*)$/u);
    if (!m) { sug.hidden = true; opciones = []; return; }
    const q = m[2].toLowerCase();
    opciones = [...S.usuarios.values()].filter((u) => u.usuario.toLowerCase().startsWith(q) || u.nombre.toLowerCase().includes(q)).slice(0, 6)
      .map((u) => ({ handle: u.usuario, html: `${avatar(u, true)}<span>${esc(u.nombre)} <small>@${esc(u.usuario)}</small></span>` }));
    if ('canal'.startsWith(q)) opciones.push({ handle: 'canal', html: '<span>@canal <small>avisa a todo el canal</small></span>' });
    if (!opciones.length) { sug.hidden = true; return; }
    sel = Math.min(sel, opciones.length - 1);
    sug.innerHTML = opciones.map((o, i) => `<button data-i="${i}" class="${i === sel ? 'sel' : ''}">${o.html}</button>`).join('');
    sug.hidden = false;
  }
  function elegir(i) {
    const antes = ta.value.slice(0, ta.selectionStart).replace(/@([\p{L}0-9._-]*)$/u, `@${opciones[i].handle} `);
    ta.value = antes + ta.value.slice(ta.selectionStart);
    ta.setSelectionRange(antes.length, antes.length);
    sug.hidden = true; opciones = []; ajustar(); ta.focus();
  }
  sug.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); elegir(+b.dataset.i); } });

  ta.addEventListener('input', () => {
    S.borradores[clave] = ta.value; ajustar(); sel = 0; sugerir();
    if (Date.now() - ultimoAviso > 3000 && ta.value.trim()) { ultimoAviso = Date.now(); B.escribiendo(canalId, parentId); }
  });
  ta.addEventListener('keydown', (e) => {
    if (!sug.hidden && opciones.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : opciones.length - 1)) % opciones.length; sugerir(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); elegir(sel); return; }
      if (e.key === 'Escape') { sug.hidden = true; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); enviar(); }
    if (e.key === 'ArrowUp' && !ta.value) {
      const mio = [...(S.mensajes.get(canalId) || [])].reverse().find((m) => m.user_id === S.yo.id && (m.parent_id || null) === parentId);
      if (mio) { e.preventDefault(); S.editando = mio.id; repintar(); }
    }
  });
  btn.addEventListener('click', enviar);

  // Barra de formato: envuelve la selección con la marca (o la inserta vacía).
  function envolver(antes, despues = antes) {
    const [i, f] = [ta.selectionStart, ta.selectionEnd];
    const sel = ta.value.slice(i, f);
    ta.value = ta.value.slice(0, i) + antes + sel + despues + ta.value.slice(f);
    ta.setSelectionRange(i + antes.length, i + antes.length + sel.length);
    ta.focus(); ta.dispatchEvent(new Event('input'));
  }
  cont.querySelector('.formato').addEventListener('mousedown', (e) => e.preventDefault());
  cont.querySelector('.formato').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fmt]'); if (!b) return;
    const f = b.dataset.fmt;
    if (f === 'enlace') { const url = prompt('Dirección del enlace', 'https://'); if (url) envolver('', ` ${url}`); }
    else if (f === 'lista') envolver(ta.value && !ta.value.endsWith('\n') && ta.selectionStart > 0 ? '\n• ' : '• ', '');
    else envolver(f);
  });
  cont.querySelector('[data-ins="@"]').addEventListener('click', () => {
    const i = ta.selectionStart; const pre = i > 0 && !/\s$/.test(ta.value.slice(0, i)) ? ' @' : '@';
    ta.value = ta.value.slice(0, i) + pre + ta.value.slice(i);
    ta.setSelectionRange(i + pre.length, i + pre.length); ta.focus(); ta.dispatchEvent(new Event('input'));
  });
  cont.querySelector('[data-ins="emoji"]').addEventListener('click', (e) => selectorEmoji(e.currentTarget, (emoji) => {
    const i = ta.selectionStart;
    ta.value = ta.value.slice(0, i) + emoji + ta.value.slice(i);
    ta.setSelectionRange(i + emoji.length, i + emoji.length); ta.focus(); ta.dispatchEvent(new Event('input'));
  }));

  async function enviar() {
    const texto = ta.value.trim();
    if ((!texto && !archivo) || btn.dataset.enviando) return;
    btn.dataset.enviando = '1'; btn.disabled = true;
    const f = archivo;
    try {
      const m = await B.enviar(canalId, texto, { parentId, archivo: f });
      ta.value = ''; S.borradores[clave] = ''; ponerArchivo(null);
      guardarMensaje(m);
      if (parentId) { pintarHilo({ alFinal: true }); pintarMensajes(); } else pintarMensajes({ alFinal: true });
    } catch (err) { aviso(err.message); }
    delete btn.dataset.enviando; ajustar(); ta.focus();
  }
  return ta;
}

// ---------- navegación ----------
async function abrirCanal(id) {
  const c = canal(id); if (!c) return;
  if (S.actual?.id !== id) { S.editando = null; if (S.hilo && S.porId.get(S.hilo)?.channel_id !== id) { S.hilo = null; $('#hilo').hidden = true; } }
  S.actual = c;
  try { localStorage.setItem('charla-ultimo-canal', id); } catch { /* sin almacenamiento */ }
  $('#shell').classList.remove('menu-abierto');
  pintarCabecera();
  $('#mensajes').innerHTML = '<div class="vacio"><div class="giro" style="margin:auto"></div></div>';
  await cargarCanal(id);
  if (S.actual?.id !== id) return;
  S.noLeidos[id] = 0;
  AV.alLeer(id);
  pintarLateral();
  const caja = pintarPie();
  pintarMensajes({ alFinal: true });
  pintarEscribiendo();
  caja?.focus();
}

// Abajo va el cuadro para escribir; en un canal público donde no estoy, la invitación a unirme.
// Devuelve el cuadro de texto (o nada si no se puede escribir).
function pintarPie() {
  const c = S.actual; if (!c) return null;
  if (c.es_dm || soyMiembro(c)) {
    B.marcarLeido(c.id).catch(() => {});
    return montarComposer($('#composerPrincipal'), { canalId: c.id, placeholder: `Mensaje a ${tituloCanal(c)}` });
  }
  $('#composerPrincipal').innerHTML = `<div class="barra-unirse"><p>Estás mirando <b># ${esc(c.nombre)}</b></p><div><button class="secundario" data-unirse="detalles">Detalles</button><button class="primario" data-unirse="si">Unirme al canal</button></div></div>`;
  return null;
}

// ---------- canales: unirse, salir, cerrar conversaciones ----------
async function unirse(c) {
  try { await B.unirse(c.id); } catch (e) { return aviso(e.message); }
  if (!soyMiembro(c)) c.miembros.push(S.yo.id);
  S.noLeidos[c.id] = 0;
  pintarLateral();
  if (S.actual?.id === c.id) { pintarCabecera(); pintarPie()?.focus(); }
}
function quitarCanal(id) {
  S.canales = S.canales.filter((x) => x.id !== id);
  delete S.noLeidos[id];
  if (S.actual?.id === id) { S.actual = null; const d = canalDeInicio(); if (d) abrirCanal(d.id); }
}
async function salirDeCanal(c) {
  if (c.es_privado && !confirm(`Si sales de ${c.nombre}, que es privado, alguien tendrá que volver a agregarte. ¿Salir?`)) return false;
  try { await B.sacarDelCanal(c.id, S.yo.id); } catch (e) { aviso(e.message); return false; }
  c.miembros = c.miembros.filter((id) => id !== S.yo.id);
  delete S.noLeidos[c.id];
  if (c.es_privado) quitarCanal(c.id);
  else if (S.actual?.id === c.id) { const d = canalDeInicio(); if (d && d.id !== c.id) abrirCanal(d.id); else { pintarCabecera(); pintarPie()?.focus(); } }
  pintarLateral();
  return true;
}
// Cerrar un DM lo saca de la lista hasta que llegue un mensaje nuevo.
function cerrarDM(c) {
  if (!c) return;
  S.cerrado[c.id] = S.ultimo[c.id] || new Date().toISOString();
  S.noLeidos[c.id] = 0;
  B.cerrarDM(c.id, S.cerrado[c.id]).catch((e) => aviso(e.message));
  if (S.actual?.id === c.id) { S.actual = null; const d = canalDeInicio(); if (d) abrirCanal(d.id); }
  pintarLateral();
}

async function irAMensaje(m) {
  await abrirCanal(m.channel_id);
  if (m.parent_id) { S.hilo = m.parent_id; pintarHilo({ alFinal: true }); }
  const el = document.querySelector(`.msg[data-id="${m.id}"]`);
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('destello'); }
}

// ---------- modales ----------
function modal(html) {
  cerrarModal();
  const fondo = document.createElement('div');
  fondo.className = 'fondo-modal';
  fondo.innerHTML = `<div class="modal">${html}</div>`;
  fondo.addEventListener('mousedown', (e) => { if (e.target === fondo) cerrarModal(); });
  document.body.append(fondo);
  return fondo;
}
function cerrarModal() { document.querySelector('.fondo-modal')?.remove(); }

function abrirBusqueda(inicial = '') {
  const el = modal(`<div class="busqueda-cab">${ico('buscar')}<input class="busqueda-input" placeholder="Buscar en ${esc(CONFIG.nombreEspacio)}" autofocus></div><div class="resultados"><div class="vacio">Escribe al menos 2 letras.</div></div>`);
  const input = $('input', el); const res = $('.resultados', el);
  let t; let encontrados = [];
  input.focus();
  if (inicial) setTimeout(() => { input.value = inicial; input.dispatchEvent(new Event('input')); });
  input.addEventListener('input', () => {
    clearTimeout(t);
    const q = input.value.trim();
    if (q.length < 2) { res.innerHTML = '<div class="vacio">Escribe al menos 2 letras.</div>'; return; }
    t = setTimeout(async () => {
      encontrados = await B.buscar(q).catch(() => []);
      if (input.value.trim() !== q) return;
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      res.innerHTML = encontrados.length ? encontrados.map((m, i) => `<button class="resultado" data-i="${i}"><div class="donde">${esc(tituloCanal(canal(m.channel_id)))}${m.parent_id ? ' · en un hilo' : ''} · ${esc(autor(m).nombre)} · ${esc(hace(m.created_at))}</div><div>${esc(m.texto.slice(0, 220)).replace(re, '<mark>$1</mark>')}</div></button>`).join('')
        : '<div class="vacio">Sin resultados.</div>';
    }, 220);
  });
  res.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-i]'); if (!b) return;
    const m = encontrados[+b.dataset.i]; cerrarModal();
    await cargarCanal(m.channel_id); irAMensaje(m);
  });
}

function abrirNuevoCanal() {
  const el = modal(`<div class="modal-cab"><h3>Crear un canal</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
    <form class="modal-cuerpo"><label>Nombre</label><input class="campo" name="nombre" placeholder="ej. lanzamiento-colombia" maxlength="40" required>
    <label>Descripción <span class="opcional">(opcional)</span></label><input class="campo" name="desc" maxlength="140" placeholder="¿De qué se habla aquí?">
    <label>Visibilidad</label>
    <label class="opcion"><input type="radio" name="tipo" value="publico" checked><span><b># Público</b><small>Cualquiera del equipo puede encontrarlo y unirse.</small></span></label>
    <label class="opcion"><input type="radio" name="tipo" value="privado"><span><b>${ico('candado', 'chico')} Privado</b><small>Solo lo ven las personas que agregues.</small></span></label>
    <p class="error" hidden></p><div class="modal-pie"><button type="button" class="secundario" data-cerrar>Cancelar</button><button class="primario">Crear</button></div></form>`);
  const form = $('form', el); const err = $('.error', el);
  el.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', cerrarModal));
  form.nombre.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = slugCanal(form.nombre.value);
    if (!nombre) return;
    try {
      const c = await B.crearCanal(nombre, form.desc.value.trim(), { privado: form.tipo.value === 'privado' });
      if (!canal(c.id)) S.canales.push(c);
      pintarLateral(); await abrirCanal(c.id);
      abrirDetalles(canal(c.id)); // para agregar gente de una vez
    } catch (ex) { err.hidden = false; err.textContent = /duplicate|unique|ya existe/i.test(ex.message) ? `Ya existe un canal llamado ${nombre}.` : ex.message; }
  });
}

// Lista de canales públicos para unirse o salir (como "Explorar canales" de Slack).
function abrirExplorar() {
  const el = modal(`<div class="modal-cab"><h3>Explorar canales</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
    <div class="busqueda-cab">${ico('buscar')}<input class="busqueda-input" placeholder="Buscar un canal"></div><div class="resultados explorar"></div>`);
  const input = $('input', el); const res = $('.resultados', el);
  const pintar = () => {
    const q = sinTildes(input.value.trim());
    const lista = S.canales.filter((c) => !c.es_dm && !c.es_privado && sinTildes(`${c.nombre} ${c.descripcion}`).includes(q)).sort(porNombre);
    res.innerHTML = lista.length ? lista.map((c) => {
      const soy = soyMiembro(c); const n = c.miembros.length;
      return `<div class="fila-canal"><button class="ir" data-ir="${c.id}"><b># ${esc(c.nombre)}</b><small>${soy ? '<span class="unido">✓ Estás</span> · ' : ''}${n} ${n === 1 ? 'miembro' : 'miembros'}${c.descripcion ? ` · ${esc(c.descripcion)}` : ''}</small></button>${soy ? (esGeneral(c) ? '' : `<button class="secundario" data-salir="${c.id}">Salir</button>`) : `<button class="primario" data-unirse="${c.id}">Unirse</button>`}</div>`;
    }).join('') : '<div class="vacio">No hay canales con ese nombre.</div>';
  };
  pintar(); input.focus();
  input.addEventListener('input', pintar);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cerrar]')) return cerrarModal();
    const ir = e.target.closest('[data-ir]'); if (ir) { cerrarModal(); return abrirCanal(ir.dataset.ir); }
    const u = e.target.closest('[data-unirse]'); const x = e.target.closest('[data-salir]');
    if (!u && !x) return;
    (u || x).disabled = true;
    if (u) await unirse(canal(u.dataset.unirse)); else await salirDeCanal(canal(x.dataset.salir));
    pintar();
  });
}

// Detalles de un canal: nombre, descripción, miembros y salir.
function abrirDetalles(c) {
  if (!c || c.es_dm) return;
  const el = modal('');
  const caja = $('.modal', el);
  const pintar = () => {
    c = canal(c.id) || c;
    const soy = soyMiembro(c);
    const miembros = c.miembros.map(usuario).filter(Boolean).sort(porNombre);
    const fuera = [...S.usuarios.values()].filter((u) => !c.miembros.includes(u.id)).sort(porNombre);
    caja.innerHTML = `<div class="modal-cab"><h3>${c.es_privado ? ico('candado') : '<span class="hash-titulo">#</span>'}${esc(c.nombre)}</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
      <div class="modal-cuerpo detalles">
        ${soy ? `<form><label>Nombre</label><input class="campo" name="nombre" maxlength="40" required value="${esc(c.nombre)}"${esGeneral(c) ? ' disabled' : ''}>
          <label>Descripción</label><input class="campo" name="desc" maxlength="140" placeholder="¿De qué se habla aquí?" value="${esc(c.descripcion || '')}">
          <p class="error" hidden></p><div class="fila-fin"><button class="secundario">Guardar cambios</button></div></form>`
        : `<p class="desc-canal">${esc(c.descripcion || 'Este canal no tiene descripción.')}</p>`}
        <h4>${miembros.length} ${miembros.length === 1 ? 'miembro' : 'miembros'}</h4>
        ${soy && fuera.length ? `<select class="campo" name="agregar"><option value="">Agregar a una persona…</option>${fuera.map((u) => `<option value="${u.id}">${esc(u.nombre)}</option>`).join('')}</select>` : ''}
        <ul class="lista-personas">${miembros.map((u) => `<li>${avatar(u, true)}<span>${esc(u.nombre)}${u.id === S.yo.id ? ' <small>tú</small>' : ''}</span>${soy && u.id !== S.yo.id && !esGeneral(c) ? `<button class="enlace" data-sacar="${u.id}">Sacar</button>` : ''}</li>`).join('')}</ul>
        <div class="modal-pie">${soy ? (esGeneral(c) ? '<span class="nota-import">De general no se puede salir: es el canal de todo el equipo.</span>' : '<button class="secundario peligro" data-salir>Salir del canal</button>') : '<button class="primario" data-unirse>Unirme al canal</button>'}</div>
      </div>`;
  };
  const refrescar = () => { pintar(); pintarLateral(); if (S.actual?.id === c.id) pintarCabecera(); };
  pintar();
  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target; const err = $('.error', form);
    const nombre = esGeneral(c) ? c.nombre : slugCanal(form.nombre.value); const descripcion = form.desc.value.trim();
    if (!nombre) return;
    try {
      await B.editarCanal(c.id, nombre, descripcion);
      Object.assign(c, { nombre, descripcion });
      refrescar(); aviso('Canal actualizado.');
    } catch (ex) { err.hidden = false; err.textContent = /duplicate|unique|ya existe/i.test(ex.message) ? `Ya existe un canal llamado ${nombre}.` : ex.message; }
  });
  el.addEventListener('change', async (e) => {
    if (e.target.name !== 'agregar' || !e.target.value) return;
    const id = e.target.value;
    try { await B.agregarAlCanal(c.id, id); if (!c.miembros.includes(id)) c.miembros.push(id); } catch (ex) { aviso(ex.message); }
    refrescar();
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-cerrar]')) return cerrarModal();
    if (e.target.closest('[data-unirse]')) { await unirse(c); return pintar(); }
    if (e.target.closest('[data-salir]')) { if (await salirDeCanal(c)) cerrarModal(); return; }
    const b = e.target.closest('[data-sacar]'); if (!b) return;
    const u = usuario(b.dataset.sacar);
    if (!confirm(`¿Sacar a ${u?.nombre || 'esta persona'} de ${c.nombre}?`)) return;
    try { await B.sacarDelCanal(c.id, b.dataset.sacar); c.miembros = c.miembros.filter((id) => id !== b.dataset.sacar); } catch (ex) { aviso(ex.message); }
    refrescar();
  });
}

// Buscador de personas para abrir un mensaje directo.
function abrirNuevoMensaje() {
  const el = modal(`<div class="modal-cab"><h3>Nuevo mensaje</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
    <div class="busqueda-cab">${ico('buscar')}<input class="busqueda-input" placeholder="Busca a una persona"></div><div class="resultados personas"></div>`);
  const input = $('input', el); const res = $('.resultados', el);
  let lista = [];
  const pintar = () => {
    const q = sinTildes(input.value.trim());
    const gente = [...S.usuarios.values()].sort((a, b) => (a.id === S.yo.id) - (b.id === S.yo.id) || porNombre(a, b))
      .map((u) => ({ u, usuario: u.id, nota: u.id === S.yo.id ? 'tú' : `@${u.usuario}`, enLinea: S.enLinea.has(u.id) }));
    // Conversaciones importadas de Slack con quien todavía no entra a Charla.
    const deSlack = S.canales.filter((c) => dmSinContraparte(c) && S.ultimo[c.id]).sort((a, b) => porNombre(personaDM(a), personaDM(b)))
      .map((c) => ({ u: personaDM(c), canal: c.id, nota: 'todavía no entra a Charla' }));
    lista = [...gente, ...deSlack].filter((x) => sinTildes(`${x.u.nombre} ${x.u.usuario || ''}`).includes(q));
    res.innerHTML = lista.length ? lista.map((x, i) => `<button class="resultado persona" data-i="${i}"><span class="av-dm">${avatar(x.u, true)}<span class="punto${x.enLinea ? ' on' : ''}"></span></span><b>${esc(x.u.nombre)}</b><small>${esc(x.nota)}</small></button>`).join('')
      : '<div class="vacio">Nadie con ese nombre.</div>';
  };
  async function elegir(x) {
    if (!x) return;
    cerrarModal();
    let c = x.canal ? canal(x.canal) : dmCon(x.usuario);
    try { if (!c) { c = await B.abrirDM(x.usuario); if (!canal(c.id)) S.canales.push(c); else c = canal(c.id); } } catch (e) { return aviso(e.message); }
    abrirCanal(c.id);
  }
  pintar(); input.focus();
  input.addEventListener('input', pintar);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); elegir(lista[0]); } });
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-cerrar]')) return cerrarModal();
    const b = e.target.closest('[data-i]'); if (b) elegir(lista[+b.dataset.i]);
  });
}

async function abrirResumen() {
  const c = S.actual;
  const el = modal(`<div class="modal-cab"><h3>${ico('chispa')} Resumen de ${esc(tituloCanal(c))}</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
    <div class="modal-cuerpo resumen"><div class="cargando"><div class="giro"></div>Claude está leyendo las últimas 24 horas…</div></div>`);
  $('[data-cerrar]', el).addEventListener('click', cerrarModal);
  try { const texto = await B.resumir(c.id); $('.resumen', el).innerHTML = formato(texto); }
  catch (err) { $('.resumen', el).innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

// ---------- tiempo real ----------
function avisarEscritorio(m) {
  const c = canal(m.channel_id);
  if (!c || (!c.es_dm && !meMenciona(m.texto))) return; // solo mensajes directos y menciones
  const viendo = AV.viendo(m.channel_id);
  AV.alLlegar(m, c); // cuenta la mención y suena, si no lo estoy mirando
  if (viendo) return;
  if (window.charlaEscritorio) {
    window.webkit.messageHandlers.charla.postMessage({ tipo: 'aviso', id: m.id, canal: m.channel_id,
      titulo: c.es_dm ? autor(m).nombre : `${autor(m).nombre} en ${tituloCanal(c)}`, cuerpo: m.texto || '📎 Archivo' });
    return;
  }
  if (AV.pushActivo()) return; // en este dispositivo el aviso llega por push (también con Charla cerrada)
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(c.es_dm ? autor(m).nombre : `${autor(m).nombre} en ${tituloCanal(c)}`, { body: m.texto || '📎 Archivo', tag: m.channel_id, silent: false });
  n.onclick = () => { focus(); irAMensaje(m); n.close(); };
}

let marcarPendiente;
let repintarPendiente;
let recargarCanales;
// Un mensaje con fecha vieja que llega por tiempo real es historial importado
// de Slack: no cuenta como no leído, no avisa y se pinta de a tandas.
const esHistorial = (m) => m.slack_id && Date.now() - new Date(m.created_at) > 10 * 60 * 1000;
const handlers = {
  async onMensaje(tipo, nuevo, viejo) {
    if (tipo === 'DELETE') { const m = quitarMensaje(viejo.id); if (m && m.channel_id === S.actual?.id) repintar(); return; }
    if (tipo === 'INSERT' && esHistorial(nuevo)) {
      if (!canal(nuevo.channel_id)) {
        clearTimeout(recargarCanales);
        recargarCanales = setTimeout(traerCanales, 1500);
        return;
      }
      if (!S.mensajes.has(nuevo.channel_id)) return;
      guardarMensaje(nuevo);
      if (nuevo.channel_id === S.actual?.id && !repintarPendiente) repintarPendiente = setTimeout(() => { repintarPendiente = null; repintar(); }, 800);
      return;
    }
    if (!canal(nuevo.channel_id)) await traerCanales();
    if (tipo === 'INSERT' && ultimoVisto && nuevo.created_at > ultimoVisto) ultimoVisto = nuevo.created_at;
    const yaEstaba = S.porId.has(nuevo.id);
    const m = guardarMensaje(nuevo);
    // Un canal público donde no estoy no suma no leídos ni avisa (solo se ve si lo estoy mirando).
    const mio = canal(m.channel_id); const dentro = mio && soyMiembro(mio);
    if (tipo === 'INSERT' && !yaEstaba && m.user_id !== S.yo.id) {
      const viendo = AV.viendo(m.channel_id);
      if (dentro && !m.parent_id && !viendo) S.noLeidos[m.channel_id] = (S.noLeidos[m.channel_id] || 0) + 1;
      if (dentro && viendo) { clearTimeout(marcarPendiente); marcarPendiente = setTimeout(() => B.marcarLeido(m.channel_id).catch(() => {}), 1000); }
      if (dentro) avisarEscritorio(m);
      quitarEscribiendo(m.channel_id, m.parent_id, m.user_id);
      pintarLateral();
    } else if (tipo === 'INSERT' && !yaEstaba && mio?.es_dm) pintarLateral(); // mi mensaje sube la conversación
    if (m.channel_id === S.actual?.id) repintar();
  },
  onReaccion(tipo, nuevo, viejo) {
    const r = tipo === 'DELETE' ? viejo : nuevo;
    const m = S.porId.get(r?.message_id); if (!m) return;
    const i = m.reacciones.findIndex((x) => x.user_id === r.user_id && x.emoji === r.emoji);
    if (tipo === 'INSERT' && i < 0) m.reacciones.push(r);
    else if (tipo === 'DELETE' && i >= 0) m.reacciones.splice(i, 1);
    else return;
    if (m.channel_id === S.actual?.id) repintar();
  },
  async onCanal(c) {
    if (canal(c.id)) return;
    if (c.es_dm || c.es_privado) return traerCanales();
    S.canales.push(c); pintarLateral();
  },
  onCanalCambio(c) {
    const mio = canal(c.id); if (!mio) return;
    Object.assign(mio, { nombre: c.nombre, descripcion: c.descripcion, es_privado: c.es_privado });
    pintarLateral(); if (S.actual?.id === c.id) pintarCabecera();
  },
  onCanalBorrado(id) { if (canal(id)) { quitarCanal(id); pintarLateral(); } },
  // Alguien entró o salió de un canal (yo incluido, desde otra pestaña o porque me agregaron).
  async onMiembro(tipo, { channel_id, user_id }) {
    const c = canal(channel_id);
    if (tipo === 'INSERT') {
      if (!c) { if (user_id === S.yo.id) await traerCanales(); return; }
      if (c.miembros.includes(user_id)) return;
      c.miembros.push(user_id);
      if (user_id === S.yo.id) S.noLeidos[c.id] = S.noLeidos[c.id] || 0;
    } else {
      if (!c || !c.miembros.includes(user_id)) return;
      c.miembros = c.miembros.filter((id) => id !== user_id);
      if (user_id === S.yo.id) {
        delete S.noLeidos[c.id];
        if (c.es_privado || c.es_dm) { quitarCanal(c.id); pintarLateral(); return; }
      }
    }
    pintarLateral();
    if (S.actual?.id === channel_id) { pintarCabecera(); if (user_id === S.yo.id) pintarPie(); }
  },
  onUsuario(u) { S.usuarios.set(u.id, { ...S.usuarios.get(u.id), ...u }); pintarLateral(); },
  // Mientras estuvo caída la conexión pudieron agregarme a un canal o sacarme de uno.
  async onReconexion() { await traerCanales().catch(() => {}); ponerseAlDia(); },
  onSlackUsuario(s) { S.slack.set(s.slack_id, s); },
  onPresencia(set) { S.enLinea = set; pintarLateral(); if (S.actual?.es_dm) pintarCabecera(); },
  onEscribiendo({ channel_id, parent_id, user_id }) {
    if (user_id === S.yo.id) return;
    const clave = `${channel_id}:${parent_id || ''}`;
    if (!S.escribiendo.has(clave)) S.escribiendo.set(clave, new Map());
    const mapa = S.escribiendo.get(clave);
    clearTimeout(mapa.get(user_id));
    mapa.set(user_id, setTimeout(() => quitarEscribiendo(channel_id, parent_id, user_id), 5000));
    pintarEscribiendo();
  },
};

function quitarEscribiendo(canalId, parentId, userId) {
  const mapa = S.escribiendo.get(`${canalId}:${parentId || ''}`);
  if (mapa?.has(userId)) { clearTimeout(mapa.get(userId)); mapa.delete(userId); pintarEscribiendo(); }
}
function textoEscribiendo(clave) {
  const nombres = [...(S.escribiendo.get(clave)?.keys() || [])].map((id) => usuario(id)?.nombre).filter(Boolean);
  if (!nombres.length) return '';
  return nombres.length === 1 ? `${nombres[0]} está escribiendo…` : `${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)} están escribiendo…`;
}
function pintarEscribiendo() {
  const p = $('#escribiendoPrincipal'); if (p && S.actual) p.textContent = textoEscribiendo(`${S.actual.id}:`);
  const h = $('#escribiendoHilo'); const padre = S.hilo && S.porId.get(S.hilo);
  if (h && padre) h.textContent = textoEscribiendo(`${padre.channel_id}:${padre.id}`);
}

// ---------- app de Mac ----------
// La app nativa llama a estas funciones (ver mac/Sources/Charla/main.swift).
window.charlaSesion = async (fragmento) => {
  try { await B.recibirSesion(fragmento); location.reload(); }
  catch (e) { if (!/cancelado/.test(e.message)) pintarEntrada(e.message); }
};
window.charlaIrA = (canalId) => { if (canal(canalId)) abrirCanal(canalId); };

// ---------- arranque ----------
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.yo) { e.preventDefault(); abrirBusqueda(); }
  if (e.key === 'Escape') {
    if (document.querySelector('.visor')) document.querySelector('.visor').remove();
    else if (document.querySelector('.fondo-modal')) cerrarModal();
    else if (S.hilo && !S.editando) { S.hilo = null; $('#hilo').hidden = true; }
  }
});
// Al volver a Charla (ventana, pestaña o después de un rato sin tocarla) se da por leído el chat a la vista.
function marcarActualLeido() {
  if (!S.yo || !S.actual || !AV.viendo(S.actual.id)) return;
  if (!S.noLeidos[S.actual.id] && !AV.menciones(S.actual.id)) return;
  S.noLeidos[S.actual.id] = 0; AV.alLeer(S.actual.id); pintarLateral(); B.marcarLeido(S.actual.id).catch(() => {});
}
document.addEventListener('visibilitychange', marcarActualLeido);
addEventListener('focus', marcarActualLeido);
setInterval(() => { if (S.actual) pintarMensajes(); }, 60000); // refresca "hace X min"
document.addEventListener('visibilitychange', () => { if (!document.hidden) ponerseAlDia(); });
addEventListener('focus', ponerseAlDia);
addEventListener('online', ponerseAlDia);
setInterval(ponerseAlDia, 60000);

// ---------- importar desde Slack ----------
function abrirImportar() {
  const el = modal(`<div class="modal-cab"><h3>${ico('importar')} Importar desde Slack</h3><button class="icono" data-cerrar>${ico('cerrar')}</button></div>
    <div class="modal-cuerpo importar"><div class="cargando"><div class="giro"></div>Revisando…</div></div>`);
  const cuerpo = $('.importar', el);
  let activo = true;
  const cerrar = () => { activo = false; cerrarModal(); };
  $('[data-cerrar]', el).addEventListener('click', cerrar);

  const progreso = (r) => {
    const pct = r.total ? Math.round((r.i / r.total) * 100) : 0;
    const que = r.tipo === 'dm' ? `tus mensajes con ${esc(r.actual)}` : r.tipo === 'grupo' ? 'un mensaje grupal' : `#${esc(r.actual ?? '')}`;
    return `<p>${r.hecho ? 'Importación terminada.' : `Importando ${que}…`}</p>
      <div class="barra"><span style="width:${r.hecho ? 100 : pct}%"></span></div>
      <p class="nota-import">${r.i} de ${r.total} conversaciones · ${r.mensajes.toLocaleString('es')} mensajes · ${r.archivos} archivos${r.pesados ? ` · ${r.pesados} archivos de más de 20 MB quedaron como aviso` : ''}</p>
      ${r.errores?.length ? `<details class="nota-import"><summary>${r.errores.length} conversaciones con problemas</summary>${r.errores.map((x) => `<div>${esc(x)}</div>`).join('')}</details>` : ''}`;
  };

  async function importar(accion = 'paso') {
    let r;
    try {
      while (activo) {
        r = await B.importarSlack(accion);
        accion = 'paso';
        cuerpo.innerHTML = progreso(r) + (r.hecho ? '' : '<p class="nota-import">Puedes cerrar esta ventana: la próxima vez sigue donde quedó.</p>');
        if (r.hecho) break;
        if (r.espera) await new Promise((ok) => setTimeout(ok, r.espera * 1000));
      }
    } catch (e) { cuerpo.innerHTML = `<p class="error">${esc(e.message)}</p><div class="modal-pie"><button class="primario" id="reintentar">Reintentar</button></div>`; $('#reintentar', cuerpo).addEventListener('click', () => importar()); return; }
    if (r?.hecho) {
      S.canales = await B.canales(); S.mensajes.clear(); S.porId.clear();
      await traerConversaciones();
      (await B.usuariosSlack().catch(() => [])).forEach((s) => S.slack.set(s.slack_id, s));
      pintarLateral(); if (S.actual) abrirCanal(S.actual.id);
      cuerpo.insertAdjacentHTML('beforeend', `<div class="modal-pie"><button class="secundario" id="otraVez">Importar lo nuevo otra vez</button><button class="primario" data-cerrar>Listo</button></div>`);
      $('#otraVez', cuerpo).addEventListener('click', () => importar('reiniciar'));
      $('[data-cerrar]', cuerpo).addEventListener('click', cerrar);
    }
  }

  async function conectar() {
    const url = await B.urlConectarSlack();
    window.open(url, '_blank');
    cuerpo.innerHTML = `<div class="cargando"><div class="giro"></div>Autoriza Charla en la ventana de Slack que se abrió. Esto sigue solo cuando termines.</div>`;
    const hasta = Date.now() + 10 * 60 * 1000;
    while (activo && Date.now() < hasta) {
      await new Promise((ok) => setTimeout(ok, 2500));
      if (await B.slackConectado().catch(() => false)) return importar('reiniciar');
    }
    if (activo) pantallaInicial(false);
  }

  function pantallaInicial(conectado, r) {
    cuerpo.innerHTML = `<p>Copia a Charla tu historial de Slack: los canales donde estás (públicos y privados), tus mensajes directos y grupales, con hilos, reacciones y archivos de hasta 20 MB.</p>
      <p class="nota-import">Cada persona importa lo suyo. Si alguien ya importó un canal, no se duplica nada. Los mensajes de quienes todavía no entran a Charla aparecen con su nombre de Slack y se les asignan cuando entren.</p>
      ${r?.empezada && !r.hecho ? progreso(r) : ''}
      <div class="modal-pie">${conectado
        ? `<button class="secundario" id="reconectar">Conectar otra cuenta</button><button class="primario" id="empezar">${r?.empezada && !r.hecho ? 'Seguir importando' : r?.hecho ? 'Importar lo nuevo' : 'Empezar'}</button>`
        : '<button class="primario" id="conectar">Conectar con Slack</button>'}</div>`;
    $('#conectar', cuerpo)?.addEventListener('click', conectar);
    $('#reconectar', cuerpo)?.addEventListener('click', conectar);
    $('#empezar', cuerpo)?.addEventListener('click', () => importar(r?.empezada && !r.hecho ? 'paso' : 'reiniciar'));
  }

  B.importarSlack('estado').then((r) => pantallaInicial(r.conectado, r)).catch((e) => { cuerpo.innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

// Vuelta del "Conectar con Slack" (la abre Slack en una pestaña nueva).
function avisoSlackDeURL() {
  const m = location.hash.match(/^#slack=([\w-]+)/);
  if (!m) return '';
  history.replaceState(null, '', location.pathname + location.search);
  if (m[1] === 'ok') {
    if (window.opener) setTimeout(() => window.close(), 1500);
    return 'Slack quedó conectado. Vuelve a la ventana de Charla donde empezaste: la importación sigue sola.';
  }
  return m[1] === 'cancelado' ? 'Cancelaste la conexión con Slack.' : `No se pudo conectar Slack (${m[1]}).`;
}

async function arrancar() {
  const avisoSlack = avisoSlackDeURL();
  if (avisoSlack) setTimeout(() => aviso(avisoSlack), 600);
  const error = errorDeURL() || avisoSlack;
  try { S.yo = await B.iniciar(); } catch (e) { return pintarEntrada(e.message); }
  if (!S.yo) return pintarEntrada(error);
  const [usuarios, canales, , slack] = await Promise.all([B.usuarios(), B.canales(), traerConversaciones(), B.usuariosSlack().catch(() => [])]);
  usuarios.forEach((u) => S.usuarios.set(u.id, u));
  slack.forEach((s) => S.slack.set(s.slack_id, s));
  S.canales = canales;
  pintarEstructura(); pintarYo(); pintarLateral();
  B.suscribir(handlers);
  ultimoVisto = (await B.ultimaFecha?.().catch(() => null)) || new Date().toISOString();
  // Tocar una notificación abre su chat: con Charla abierta llega un mensaje del proceso de
  // avisos; si estaba cerrada, el chat viene en la dirección (?canal=…).
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.tipo === 'ir' && canal(e.data.canal)) abrirCanal(e.data.canal); });
  const pedido = new URLSearchParams(location.search).get('canal');
  if (pedido) { const p = new URLSearchParams(location.search); p.delete('canal'); history.replaceState(null, '', location.pathname + (p.size ? `?${p}`.replace(/=(&|$)/g, '$1') : '')); }
  let ultimo = null; try { ultimo = localStorage.getItem('charla-ultimo-canal'); } catch { /* */ }
  const inicial = canal(pedido) || canal(ultimo) || canalDeInicio();
  if (inicial) abrirCanal(inicial.id);
  AV.iniciar();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
arrancar();
