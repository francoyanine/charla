// Backend de demostración: guarda todo en localStorage y usa BroadcastChannel
// para que dos pestañas del mismo navegador se vean en tiempo real.
// Cada pestaña puede entrar como una persona distinta.

const CLAVE = 'charla-demo-v1';
const CLAVE_YO = 'charla-demo-yo';
const LIMITE_ARCHIVO = 1.5 * 1024 * 1024;

const EQUIPO = [
  { id: 'u-diego', nombre: 'Diego', usuario: 'diego' },
  { id: 'u-franco', nombre: 'Franco', usuario: 'franco' },
  { id: 'u-valentina', nombre: 'Valentina', usuario: 'valentina' },
  { id: 'u-tomas', nombre: 'Tomás', usuario: 'tomas' },
  { id: 'u-camila', nombre: 'Camila', usuario: 'camila' },
];

const uid = () => crypto.randomUUID();
const hace = (min) => new Date(Date.now() - min * 60000).toISOString();

function semilla() {
  const c = (nombre, descripcion) => ({ id: uid(), nombre, descripcion, es_dm: false, miembros: [], created_at: hace(60 * 24 * 30) });
  const general = c('general', 'Anuncios y conversación de todo el equipo');
  const marketing = c('marketing', 'Campañas, creativos y resultados');
  const alertas = c('alertas-crm', 'Avisos automáticos del CRM');
  const random = c('random', 'Lo que no es trabajo');
  const m = (canal, user_id, texto, min, extra = {}) => ({ id: uid(), channel_id: canal.id, user_id, bot_nombre: null, parent_id: null, texto, archivo: null, editado: false, created_at: hace(min), ...extra });
  const bienvenida = m(general, 'u-diego', '¡Bienvenidos a *Charla*! 🎉 Este es nuestro reemplazo de Slack: mismo flujo, sin pagar por usuario. Cualquier cosa que eche de menos, avísenle a @franco.', 60 * 26);
  const mensajes = [
    bienvenida,
    m(general, 'u-valentina', 'Se ve muy bien. ¿Los hilos funcionan igual que en Slack?', 60 * 25),
    m(general, 'u-franco', 'Sí: pasa el mouse sobre un mensaje y toca 💬. Las respuestas quedan en el panel de la derecha.', 60 * 25 - 3, { parent_id: bienvenida.id }),
    m(general, 'u-tomas', 'Probando las reacciones 👀', 60 * 2),
    m(marketing, 'u-camila', 'Subí los 3 creativos nuevos del retiro. El que mejor rinde es el del testimonio, `CPA` USD 18.', 60 * 5),
    m(marketing, 'u-franco', 'Buenísimo. Lo duplicamos mañana con presupuesto x2 y vemos si aguanta el costo.', 60 * 4),
    m(alertas, null, '⚠️ 3 oportunidades llevan más de 48 h sin moverse en *Ventas Front*.', 90, { bot_nombre: 'CRM' }),
    m(random, 'u-valentina', '¿Alguien sabe de un buen café cerca de la oficina? ☕', 60 * 30),
  ];
  const reacciones = [
    { message_id: bienvenida.id, user_id: 'u-valentina', emoji: '🎉' },
    { message_id: bienvenida.id, user_id: 'u-tomas', emoji: '🎉' },
    { message_id: bienvenida.id, user_id: 'u-camila', emoji: '❤️' },
  ];
  return { usuarios: EQUIPO.map((u) => ({ ...u, email: `${u.usuario}@demo`, avatar_url: null, created_at: hace(60 * 24 * 30) })), canales: [general, marketing, alertas, random], mensajes, reacciones, lecturas: {} };
}

function leer() {
  try { return JSON.parse(localStorage.getItem(CLAVE)); } catch { return null; }
}

export function crear() {
  let db = leer() || semilla();
  let yo = null;
  let h = null;
  const vistos = new Map();
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('charla-demo') : null;

  function guardar() {
    try { localStorage.setItem(CLAVE, JSON.stringify(db)); }
    catch { throw new Error('El navegador se quedó sin espacio para la demo. Borra algunos archivos.'); }
  }
  guardar();

  function despachar(ev) {
    if (!h) return;
    if (ev.t === 'msg') h.onMensaje(ev.tipo, ev.nuevo, ev.viejo);
    else if (ev.t === 'reac') h.onReaccion(ev.tipo, ev.nuevo, ev.viejo);
    else if (ev.t === 'canal') h.onCanal(ev.c);
    else if (ev.t === 'esc') h.onEscribiendo(ev.p);
    else if (ev.t === 'hola') { if (ev.id) vistos.set(ev.id, Date.now()); presencia(); }
    else if (ev.t === 'adios') { vistos.delete(ev.id); presencia(); }
  }
  function emitir(ev) { guardar(); bc?.postMessage(ev); despachar(ev); }
  function presencia() {
    const ahora = Date.now();
    const set = new Set([...vistos].filter(([, t]) => ahora - t < 25000).map(([id]) => id));
    if (yo) set.add(yo.id);
    h?.onPresencia(set);
  }
  if (bc) bc.onmessage = (e) => {
    const ev = e.data;
    if (['msg', 'reac', 'canal'].includes(ev.t)) db = leer() || db;
    if (ev.t === 'hola' && ev.responder && yo) bc.postMessage({ t: 'hola', id: yo.id });
    despachar(ev);
  };

  const conReacciones = (m) => ({ ...m, reacciones: db.reacciones.filter((r) => r.message_id === m.id).map((r) => ({ ...r })) });
  const puedeVer = (c) => !c.es_dm || c.miembros.includes(yo.id);
  const leerArchivo = (f) => new Promise((ok, mal) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = mal; r.readAsDataURL(f); });

  return {
    modo: 'demo',
    async iniciar() {
      const id = sessionStorage.getItem(CLAVE_YO);
      yo = db.usuarios.find((u) => u.id === id) || null;
      return yo;
    },
    usuariosDemo: () => db.usuarios,
    async entrarDemo(id) { sessionStorage.setItem(CLAVE_YO, id); location.reload(); },
    async entrar() {},
    async salir() { bc?.postMessage({ t: 'adios', id: yo?.id }); sessionStorage.removeItem(CLAVE_YO); location.reload(); },
    async usuarios() { return db.usuarios; },
    async canales() { return db.canales.filter(puedeVer); },
    async crearCanal(nombre, descripcion) {
      if (db.canales.some((c) => c.nombre === nombre)) throw new Error(`Ya existe #${nombre}`);
      const c = { id: uid(), nombre, descripcion, es_dm: false, miembros: [], creado_por: yo.id, created_at: new Date().toISOString() };
      db.canales.push(c);
      emitir({ t: 'canal', c });
      return c;
    },
    async abrirDM(otro) {
      const [a, b] = [yo.id, otro].sort();
      const nombre = `dm:${a}:${b}`;
      let c = db.canales.find((x) => x.nombre === nombre);
      if (!c) {
        c = { id: uid(), nombre, descripcion: '', es_dm: true, miembros: [...new Set([a, b])], creado_por: yo.id, created_at: new Date().toISOString() };
        db.canales.push(c);
        emitir({ t: 'canal', c });
      }
      return c;
    },
    async mensajes(canalId) {
      return db.mensajes.filter((m) => m.channel_id === canalId).map(conReacciones);
    },
    async enviar(canalId, texto, { parentId = null, archivo = null } = {}) {
      let adj = null;
      if (archivo) {
        if (archivo.size > LIMITE_ARCHIVO) throw new Error('En la demo los archivos pueden pesar hasta 1,5 MB (con el servidor real, 25 MB).');
        adj = { nombre: archivo.name, tipo: archivo.type, tamano: archivo.size, ruta: await leerArchivo(archivo) };
      }
      const m = { id: uid(), channel_id: canalId, user_id: yo.id, bot_nombre: null, parent_id: parentId, texto, archivo: adj, editado: false, created_at: new Date().toISOString() };
      db.mensajes.push(m);
      emitir({ t: 'msg', tipo: 'INSERT', nuevo: m });
      return { ...m, reacciones: [] };
    },
    async editar(id, texto) {
      const m = db.mensajes.find((x) => x.id === id);
      if (!m || m.user_id !== yo.id) return;
      Object.assign(m, { texto, editado: true });
      emitir({ t: 'msg', tipo: 'UPDATE', nuevo: m });
    },
    async borrar(id) {
      const m = db.mensajes.find((x) => x.id === id);
      if (!m || m.user_id !== yo.id) return;
      const ids = new Set([id, ...db.mensajes.filter((x) => x.parent_id === id).map((x) => x.id)]);
      db.mensajes = db.mensajes.filter((x) => !ids.has(x.id));
      db.reacciones = db.reacciones.filter((r) => !ids.has(r.message_id));
      emitir({ t: 'msg', tipo: 'DELETE', viejo: { id } });
    },
    async reaccionar(messageId, emoji) {
      const i = db.reacciones.findIndex((r) => r.message_id === messageId && r.user_id === yo.id && r.emoji === emoji);
      if (i >= 0) {
        const [r] = db.reacciones.splice(i, 1);
        emitir({ t: 'reac', tipo: 'DELETE', viejo: r });
      } else {
        const r = { message_id: messageId, user_id: yo.id, emoji };
        db.reacciones.push(r);
        emitir({ t: 'reac', tipo: 'INSERT', nuevo: r });
      }
    },
    async marcarLeido(canalId) {
      db.lecturas[`${canalId}:${yo.id}`] = new Date().toISOString();
      guardar();
    },
    async noLeidos() {
      const res = {};
      for (const c of db.canales.filter(puedeVer)) {
        const desde = db.lecturas[`${c.id}:${yo.id}`] || '';
        res[c.id] = db.mensajes.filter((m) => m.channel_id === c.id && !m.parent_id && m.user_id !== yo.id && m.created_at > desde).length;
      }
      return res;
    },
    async usuariosSlack() { return []; },
    async buscar(q) {
      const visibles = new Set(db.canales.filter(puedeVer).map((c) => c.id));
      const t = q.toLowerCase();
      return db.mensajes.filter((m) => visibles.has(m.channel_id) && m.texto.toLowerCase().includes(t))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
    },
    async urlArchivo(archivo) { return archivo.ruta; },
    escribiendo(canalId, parentId) { bc?.postMessage({ t: 'esc', p: { channel_id: canalId, parent_id: parentId, user_id: yo.id } }); },
    async resumir(canalId) {
      await new Promise((r) => setTimeout(r, 700));
      const ult = db.mensajes.filter((m) => m.channel_id === canalId).slice(-6);
      const nom = (m) => db.usuarios.find((u) => u.id === m.user_id)?.nombre || m.bot_nombre || 'Alguien';
      return 'Esto es la demo. Con el servidor conectado, Claude (Haiku) lee los mensajes de las últimas 24 horas y escribe aquí un resumen con decisiones, pendientes y quién quedó a cargo de qué.\n\nLo último del canal:\n'
        + (ult.length ? ult.map((m) => `- ${nom(m)}: ${m.texto.slice(0, 120)}`).join('\n') : '- Todavía no hay mensajes.');
    },
    suscribir(handlers) {
      h = handlers;
      bc?.postMessage({ t: 'hola', id: yo.id, responder: true });
      setInterval(() => { bc?.postMessage({ t: 'hola', id: yo.id }); presencia(); }, 10000);
      addEventListener('pagehide', () => bc?.postMessage({ t: 'adios', id: yo.id }));
      presencia();
    },
  };
}
