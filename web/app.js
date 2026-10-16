import { CONFIG } from './config.js';

const conServidor = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
const B = (conServidor ? await import('./backend-supabase.js') : await import('./backend-demo.js')).crear(CONFIG);

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const EMOJIS = ['👍', '❤️', '😂', '🎉', '🙏', '👀', '✅', '🔥'];
const MENCIONES_GRUPO = ['canal', 'todos', 'aqui'];
const AGRUPAR_MS = 5 * 60 * 1000;

const S = {
  yo: null,
  usuarios: new Map(),
  canales: [],
  actual: null,
  mensajes: new Map(), // canalId -> [mensajes]
  porId: new Map(),
  noLeidos: {},
  hilo: null,
  enLinea: new Set(),
  escribiendo: new Map(), // `${canal}:${hilo}` -> Map(userId -> timeout)
  editando: null,
  borradores: {},
};

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
function usuario(id) { return S.usuarios.get(id); }
function autor(m) {
  if (m.bot_nombre) return { nombre: m.bot_nombre, bot: true };
  return usuario(m.user_id) || { nombre: 'Ex integrante', id: m.user_id };
}
function avatar(u, chico = false) {
  const cls = `av${chico ? ' chico' : ''}${u.bot ? ' bot' : ''}`;
  if (u.bot) return `<div class="${cls}">⚡</div>`;
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
function tituloCanal(c) {
  if (!c) return '';
  if (!c.es_dm) return `# ${c.nombre}`;
  const u = usuario(otroDelDM(c));
  return u ? (u.id === S.yo.id ? `${u.nombre} (tú)` : u.nombre) : 'Mensaje directo';
}
function dmCon(userId) {
  return S.canales.find((c) => c.es_dm && c.miembros.includes(S.yo.id) && otroDelDM(c) === userId);
}
function canal(id) { return S.canales.find((c) => c.id === id); }

// ---------- mensajes en memoria ----------
function guardarMensaje(m) {
  const previo = S.porId.get(m.id);
  if (previo) { Object.assign(previo, { ...m, reacciones: m.reacciones || previo.reacciones }); return previo; }
  const nuevo = { ...m, reacciones: m.reacciones || [] };
  S.porId.set(m.id, nuevo);
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
  S.mensajes.set(id, []);
  lista.forEach(guardarMensaje);
}

// ---------- pantalla de entrada ----------
const LOGO = `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#6e56cf"/><path d="M18 22a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-9l-8 7v-7h-1a6 6 0 0 1-4-1.5" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="26" cy="28" r="2.2" fill="#fff"/><circle cx="32" cy="28" r="2.2" fill="#fff"/><circle cx="38" cy="28" r="2.2" fill="#fff"/></svg>`;

function errorDeURL() {
  const p = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const e = p.get('error_description');
  if (!e) return '';
  history.replaceState(null, '', location.pathname);
  return /database error/i.test(e) ? `Solo pueden entrar cuentas @${CONFIG.dominios.join(', @')}.` : e;
}

function pintarEntrada(error = '') {
  const cuerpo = conServidor
    ? `<button class="primario" id="btnGoogle">Entrar con Google</button>
       <p class="nota">Solo cuentas @${esc(CONFIG.dominios.join(', @'))}</p>`
    : `<div class="lista-demo">${B.usuariosDemo().map((u) => `<button data-demo="${u.id}">${avatar(u, true)}<span>Entrar como <b>${esc(u.nombre)}</b></span></button>`).join('')}</div>
       <p class="nota">Modo demo: abre otra pestaña y entra como otra persona para ver el tiempo real.</p>`;
  app.innerHTML = `<div class="entrada"><div class="tarjeta-entrada">${LOGO}<h1>Charla</h1><p>La conversación del equipo de ${esc(CONFIG.nombreEspacio)}.</p>${cuerpo}${error ? `<p class="error">${esc(error)}</p>` : ''}</div></div>`;
  $('#btnGoogle')?.addEventListener('click', (e) => { e.target.disabled = true; B.entrar().catch((err) => pintarEntrada(err.message)); });
  app.querySelectorAll('[data-demo]').forEach((b) => b.addEventListener('click', () => B.entrarDemo(b.dataset.demo)));
}

// ---------- estructura ----------
function pintarEstructura() {
  app.innerHTML = `
  <div class="shell" id="shell">
    <aside class="lateral">
      <div class="espacio"><div class="espacio-nombre">${esc(CONFIG.nombreEspacio)}</div>${conServidor ? '' : '<span class="pastilla-demo">demo</span>'}</div>
      <button class="buscar" id="btnBuscar"><span>Buscar mensajes</span><kbd>⌘K</kbd></button>
      <nav class="listas">
        <div class="seccion"><span>Canales</span><button class="mas" id="btnNuevoCanal" title="Crear canal">+</button></div>
        <ul id="listaCanales"></ul>
        <div class="seccion"><span>Mensajes directos</span></div>
        <ul id="listaDMs"></ul>
      </nav>
      <div class="yo" id="yo"></div>
    </aside>
    <main class="principal">
      <header class="cabecera" id="cabecera"></header>
      <div class="mensajes" id="mensajes"></div>
      <div class="escribiendo" id="escribiendoPrincipal"></div>
      <div id="composerPrincipal"></div>
    </main>
    <aside class="hilo" id="hilo" hidden></aside>
  </div>`;
  $('#btnBuscar').addEventListener('click', abrirBusqueda);
  $('#btnNuevoCanal').addEventListener('click', abrirNuevoCanal);
  $('#listaCanales').addEventListener('click', (e) => { const b = e.target.closest('[data-canal]'); if (b) abrirCanal(b.dataset.canal); });
  $('#listaDMs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-usuario]'); if (!b) return;
    let c = dmCon(b.dataset.usuario);
    if (!c) { c = await B.abrirDM(b.dataset.usuario); if (!canal(c.id)) S.canales.push(c); }
    abrirCanal(c.id);
  });
  $('#mensajes').addEventListener('click', clickMensaje);
  $('#hilo').addEventListener('click', clickMensaje);
}

function pintarLateral() {
  const canales = S.canales.filter((c) => !c.es_dm).sort((a, b) => a.nombre.localeCompare(b.nombre));
  $('#listaCanales').innerHTML = canales.map((c) => {
    const n = S.noLeidos[c.id] || 0;
    return `<li><button class="item${S.actual?.id === c.id ? ' activo' : ''}${n ? ' sin-leer' : ''}" data-canal="${c.id}"><span class="hash">#</span><span class="nombre">${esc(c.nombre)}</span>${n ? `<span class="insignia">${n}</span>` : ''}</button></li>`;
  }).join('');
  const gente = [...S.usuarios.values()].sort((a, b) => (a.id === S.yo.id) - (b.id === S.yo.id) || a.nombre.localeCompare(b.nombre));
  $('#listaDMs').innerHTML = gente.map((u) => {
    const c = dmCon(u.id); const n = c ? S.noLeidos[c.id] || 0 : 0;
    return `<li><button class="item${c && S.actual?.id === c.id ? ' activo' : ''}${n ? ' sin-leer' : ''}" data-usuario="${u.id}"><span class="punto${S.enLinea.has(u.id) ? ' on' : ''}"></span><span class="nombre">${esc(u.nombre)}${u.id === S.yo.id ? ' <small>(tú)</small>' : ''}</span>${n ? `<span class="insignia">${n}</span>` : ''}</button></li>`;
  }).join('');
  const total = Object.values(S.noLeidos).reduce((a, b) => a + b, 0);
  document.title = `${total ? `(${total}) ` : ''}${S.actual ? tituloCanal(S.actual) + ' · ' : ''}Charla`;
}

function pintarYo() {
  const pedirAvisos = 'Notification' in window && Notification.permission === 'default';
  $('#yo').innerHTML = `${avatar(S.yo, true)}<div class="datos"><b>${esc(S.yo.nombre)}</b><span>@${esc(S.yo.usuario)}</span></div>
    ${pedirAvisos ? '<button class="icono" id="btnAvisos" title="Activar avisos de escritorio">🔔</button>' : ''}
    <button class="icono" id="btnSalir" title="Salir">⎋</button>`;
  $('#btnSalir').addEventListener('click', () => B.salir());
  $('#btnAvisos')?.addEventListener('click', async () => { await Notification.requestPermission(); pintarYo(); });
}

function pintarCabecera() {
  const c = S.actual;
  const desc = c.es_dm ? (S.enLinea.has(otroDelDM(c)) ? 'En línea' : 'Desconectado') : c.descripcion;
  $('#cabecera').innerHTML = `
    <button class="icono btn-menu" id="btnMenu" title="Canales">☰</button>
    <div class="titulos"><h2>${esc(tituloCanal(c))}</h2>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}</div>
    <button class="btn-resumen" id="btnResumen" title="Resumen de las últimas 24 horas">✦ <span class="texto">Resumir</span></button>`;
  $('#btnMenu').addEventListener('click', () => $('#shell').classList.toggle('menu-abierto'));
  $('#btnResumen').addEventListener('click', abrirResumen);
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
      ? `<div class="archivo"><img data-ruta="${esc(f.ruta)}" alt="${esc(f.nombre)}"></div>`
      : `<div class="archivo"><a class="tarjeta-archivo" data-ruta="${esc(f.ruta)}" data-nombre="${esc(f.nombre)}" target="_blank" rel="noopener"><span class="ext">${esc((f.nombre.split('.').pop() || 'arch').slice(0, 4))}</span><span>${esc(f.nombre)}<small>${pesoLegible(f.tamano)}</small></span></a></div>`;
  }

  const cuerpo = S.editando === m.id
    ? `<div class="editor-msg"><textarea rows="2">${esc(m.texto)}</textarea><small>Enter para guardar · Esc para cancelar</small></div>`
    : `${m.texto ? `<div class="msg-texto">${formato(m.texto)}${m.editado ? ' <span class="editado">(editado)</span>' : ''}</div>` : ''}${archivo}`;

  const ultima = respuestas[respuestas.length - 1];
  const hilo = respuestas.length ? `<button class="respuestas" data-accion="hilo">${[...new Set(respuestas.map((r) => r.user_id))].slice(0, 3).map((id) => avatar(usuario(id) || { id, nombre: '?' }, true)).join('')}${respuestas.length} ${respuestas.length === 1 ? 'respuesta' : 'respuestas'} <span>· ${hace(ultima.created_at)}</span></button>` : '';

  const acciones = `<div class="msg-acciones">
      <button class="icono" data-accion="emoji" title="Reaccionar">☺︎</button>
      ${enHilo ? '' : '<button class="icono" data-accion="hilo" title="Responder en hilo">💬</button>'}
      ${mio ? '<button class="icono" data-accion="editar" title="Editar">✎</button><button class="icono" data-accion="borrar" title="Borrar">🗑</button>' : ''}
    </div>`;

  return `<div class="msg${compacto ? ' compacto' : ''}${mencionado ? ' mencionado' : ''}" data-id="${m.id}">
    ${compacto ? `<div class="msg-hora-lado">${hora(m.created_at)}</div>` : avatar(a)}
    <div class="msg-cuerpo">
      ${compacto ? '' : `<div class="msg-meta"><b>${esc(a.nombre)}</b>${a.bot ? '<span class="etiqueta-bot">APP</span>' : ''}<time title="${new Date(m.created_at).toLocaleString('es')}">${hora(m.created_at)}</time></div>`}
      ${cuerpo}${reacciones}${hilo}
    </div>
    ${S.editando === m.id ? '' : acciones}
  </div>`;
}

function htmlLista(lista, opciones) {
  let html = ''; let previo = null;
  for (const m of lista) {
    if (!previo || dia(previo.created_at) !== dia(m.created_at)) { html += `<div class="dia">${esc(dia(m.created_at))}</div>`; previo = null; }
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
  el.innerHTML = lista.length ? htmlLista(lista)
    : `<div class="vacio"><h3>${esc(tituloCanal(S.actual))}</h3>${S.actual.es_dm ? 'Este es el comienzo de su conversación.' : 'Todavía no hay mensajes. Escribe el primero.'}</div>`;
  resolverArchivos(el);
  el.scrollTop = pegado ? el.scrollHeight : arriba;
  activarEditor(el);
}

function pintarHilo({ alFinal = false } = {}) {
  const el = $('#hilo');
  const padre = S.hilo && S.porId.get(S.hilo);
  if (!padre) { el.hidden = true; S.hilo = null; return; }
  const yaAbierto = !el.hidden && el.dataset.padre === padre.id;
  if (!yaAbierto) {
    el.hidden = false; el.dataset.padre = padre.id;
    el.innerHTML = `<header class="cabecera"><div class="titulos"><h2>Hilo</h2><div class="desc">${esc(tituloCanal(canal(padre.channel_id)))}</div></div><button class="icono" data-accion="cerrar-hilo" title="Cerrar">✕</button></header>
      <div class="mensajes" id="mensajesHilo"></div><div class="escribiendo" id="escribiendoHilo"></div><div id="composerHilo"></div>`;
    montarComposer($('#composerHilo'), { canalId: padre.channel_id, parentId: padre.id, placeholder: 'Responder…' });
    alFinal = true;
  }
  const cont = $('#mensajesHilo');
  const pegado = alFinal || cercaDelFinal(cont);
  const respuestas = (S.mensajes.get(padre.channel_id) || []).filter((m) => m.parent_id === padre.id);
  cont.innerHTML = htmlMensaje(padre, null, { enHilo: true })
    + `<div class="separador">${respuestas.length} ${respuestas.length === 1 ? 'respuesta' : 'respuestas'}</div>`
    + respuestas.map((m, i) => htmlMensaje(m, respuestas[i - 1] || null, { enHilo: true })).join('');
  resolverArchivos(cont);
  if (pegado) cont.scrollTop = cont.scrollHeight;
  activarEditor(cont);
}

async function resolverArchivos(el) {
  for (const n of el.querySelectorAll('[data-ruta]:not([data-listo])')) {
    n.dataset.listo = '1';
    const m = S.porId.get(n.closest('.msg')?.dataset.id);
    if (!m?.archivo) continue;
    try {
      const url = await B.urlArchivo(m.archivo);
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
    <div class="adjunto-prev" hidden><span></span><button class="icono" title="Quitar">✕</button></div>
    <textarea rows="1" placeholder="${esc(placeholder)}"></textarea>
    <div class="composer-barra">
      <label class="icono" title="Adjuntar archivo"><input type="file" hidden>📎</label>
      <span class="ayuda">*negrita* &nbsp;_cursiva_ &nbsp;\`código\` &nbsp;@mención · Shift+Enter para otra línea</span>
      <button class="enviar" disabled>Enviar</button>
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
  pintarLateral();
  pintarMensajes({ alFinal: true });
  pintarEscribiendo();
  montarComposer($('#composerPrincipal'), { canalId: id, placeholder: `Mensaje a ${tituloCanal(c)}` }).focus();
  B.marcarLeido(id).catch(() => {});
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

function abrirBusqueda() {
  const el = modal('<input class="busqueda-input" placeholder="Buscar en todos los canales…" autofocus><div class="resultados"><div class="vacio">Escribe al menos 2 letras.</div></div>');
  const input = $('input', el); const res = $('.resultados', el);
  let t; let encontrados = [];
  input.focus();
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
  const el = modal(`<div class="modal-cab"><h3>Crear canal</h3><button class="icono" data-cerrar>✕</button></div>
    <form class="modal-cuerpo"><label>Nombre</label><input class="campo" name="nombre" placeholder="ej. lanzamiento-colombia" maxlength="40" required>
    <label>Descripción <span style="font-weight:400;color:var(--tenue)">(opcional)</span></label><input class="campo" name="desc" maxlength="140" placeholder="¿De qué se habla aquí?">
    <p class="error" hidden></p><div class="modal-pie"><button type="button" class="secundario" data-cerrar>Cancelar</button><button class="primario">Crear</button></div></form>`);
  const form = $('form', el); const err = $('.error', el);
  el.querySelectorAll('[data-cerrar]').forEach((b) => b.addEventListener('click', cerrarModal));
  form.nombre.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = form.nombre.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!nombre) return;
    try {
      const c = await B.crearCanal(nombre, form.desc.value.trim());
      if (!canal(c.id)) S.canales.push(c);
      cerrarModal(); pintarLateral(); abrirCanal(c.id);
    } catch (ex) { err.hidden = false; err.textContent = /duplicate|unique/i.test(ex.message) ? `Ya existe #${nombre}.` : ex.message; }
  });
}

async function abrirResumen() {
  const c = S.actual;
  const el = modal(`<div class="modal-cab"><h3>Resumen de ${esc(tituloCanal(c))}</h3><button class="icono" data-cerrar>✕</button></div>
    <div class="modal-cuerpo resumen"><div class="cargando"><div class="giro"></div>Claude está leyendo las últimas 24 horas…</div></div>`);
  $('[data-cerrar]', el).addEventListener('click', cerrarModal);
  try { const texto = await B.resumir(c.id); $('.resumen', el).innerHTML = formato(texto); }
  catch (err) { $('.resumen', el).innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

// ---------- tiempo real ----------
function avisarEscritorio(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden && S.actual?.id === m.channel_id) return;
  const c = canal(m.channel_id);
  if (!c?.es_dm && !meMenciona(m.texto)) return;
  const n = new Notification(c.es_dm ? autor(m).nombre : `${autor(m).nombre} en ${tituloCanal(c)}`, { body: m.texto || '📎 Archivo', tag: m.id, silent: false });
  n.onclick = () => { focus(); irAMensaje(m); n.close(); };
}

let marcarPendiente;
const handlers = {
  async onMensaje(tipo, nuevo, viejo) {
    if (tipo === 'DELETE') { const m = quitarMensaje(viejo.id); if (m && m.channel_id === S.actual?.id) repintar(); return; }
    if (!canal(nuevo.channel_id)) { S.canales = await B.canales(); pintarLateral(); }
    const yaEstaba = S.porId.has(nuevo.id);
    const m = guardarMensaje(nuevo);
    if (tipo === 'INSERT' && !yaEstaba && m.user_id !== S.yo.id) {
      const viendo = S.actual?.id === m.channel_id && !document.hidden;
      if (!m.parent_id && !viendo) S.noLeidos[m.channel_id] = (S.noLeidos[m.channel_id] || 0) + 1;
      if (viendo) { clearTimeout(marcarPendiente); marcarPendiente = setTimeout(() => B.marcarLeido(m.channel_id).catch(() => {}), 1000); }
      avisarEscritorio(m);
      quitarEscribiendo(m.channel_id, m.parent_id, m.user_id);
      pintarLateral();
    }
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
    if (c.es_dm) S.canales = await B.canales(); else S.canales.push(c);
    pintarLateral();
  },
  onUsuario(u) { S.usuarios.set(u.id, { ...S.usuarios.get(u.id), ...u }); pintarLateral(); },
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

// ---------- arranque ----------
addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && S.yo) { e.preventDefault(); abrirBusqueda(); }
  if (e.key === 'Escape') {
    if (document.querySelector('.visor')) document.querySelector('.visor').remove();
    else if (document.querySelector('.fondo-modal')) cerrarModal();
    else if (S.hilo && !S.editando) { S.hilo = null; $('#hilo').hidden = true; }
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.actual && S.noLeidos[S.actual.id]) { S.noLeidos[S.actual.id] = 0; pintarLateral(); B.marcarLeido(S.actual.id).catch(() => {}); }
});
setInterval(() => { if (S.actual) pintarMensajes(); }, 60000); // refresca "hace X min"

async function arrancar() {
  const error = errorDeURL();
  try { S.yo = await B.iniciar(); } catch (e) { return pintarEntrada(e.message); }
  if (!S.yo) return pintarEntrada(error);
  const [usuarios, canales, noLeidos] = await Promise.all([B.usuarios(), B.canales(), B.noLeidos()]);
  usuarios.forEach((u) => S.usuarios.set(u.id, u));
  S.canales = canales; S.noLeidos = noLeidos;
  pintarEstructura(); pintarYo(); pintarLateral();
  B.suscribir(handlers);
  let ultimo = null; try { ultimo = localStorage.getItem('charla-ultimo-canal'); } catch { /* */ }
  const inicial = canal(ultimo) || S.canales.find((c) => c.nombre === 'general') || S.canales.find((c) => !c.es_dm);
  if (inicial) abrirCanal(inicial.id);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
arrancar();
