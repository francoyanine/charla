// Backend real: Supabase (Postgres + Realtime + Auth con Google + Storage).
// Toda la seguridad está en las políticas RLS de supabase/esquema.sql; este
// archivo solo traduce las llamadas de la app.
// supabase-js empaquetado en un solo archivo propio: el CDN encadenaba ~10 módulos en serie y
// cada uno era un viaje de ida y vuelta (lento en redes con latencia alta, como en Colombia).
import { createClient } from './vendor/supabase-2.45.4.js';

const BUCKET = 'archivos';

export function crear(cfg) {
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  let yo = null;
  let pres = null;
  let revisar = null;
  const urls = new Map();

  const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  const conMiembros = (c) => ({ ...c, miembros: (c.channel_members || []).map((m) => m.user_id), channel_members: undefined });

  return {
    modo: 'supabase',
    async iniciar() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      yo = ok(await sb.from('profiles').select('*').eq('id', session.user.id).single());
      return yo;
    },
    async entrar() {
      const opciones = { redirectTo: location.origin + location.pathname };
      if (cfg.dominios.length === 1) opciones.queryParams = { hd: cfg.dominios[0], prompt: 'select_account' };
      if (window.charlaEscritorio) {
        // En la app de Mac, Google se abre en la ventana segura del sistema y
        // vuelve a charla://auth con la sesión (ver mac/Sources/Charla/main.swift).
        const { url } = ok(await sb.auth.signInWithOAuth({ provider: 'google', options: { ...opciones, redirectTo: 'charla://auth', skipBrowserRedirect: true } }));
        window.webkit.messageHandlers.charla.postMessage({ tipo: 'login', url });
        return;
      }
      ok(await sb.auth.signInWithOAuth({ provider: 'google', options: opciones }));
    },
    async recibirSesion(fragmento) {
      const p = new URLSearchParams(fragmento);
      if (p.get('error_description')) throw new Error(p.get('error_description'));
      ok(await sb.auth.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token') }));
    },
    async salir() { await sb.auth.signOut(); location.reload(); },
    async usuarios() { return ok(await sb.from('profiles').select('*').order('nombre')); },
    async canales() {
      return ok(await sb.from('channels').select('*, channel_members(user_id)').order('nombre')).map(conMiembros);
    },
    async canal(id) {
      return conMiembros(ok(await sb.from('channels').select('*, channel_members(user_id)').eq('id', id).single()));
    },
    // Las reglas (quién puede crear, editar, agregar o sacar) viven en las funciones de
    // supabase/migraciones/004_barra_lateral.sql.
    async crearCanal(nombre, descripcion, { privado = false, miembros = [] } = {}) {
      const id = ok(await sb.rpc('crear_canal', { p_nombre: nombre, p_descripcion: descripcion, p_privado: privado, p_miembros: miembros }));
      return this.canal(id);
    },
    async editarCanal(id, nombre, descripcion) { ok(await sb.rpc('editar_canal', { p_canal: id, p_nombre: nombre, p_descripcion: descripcion })); },
    async unirse(canalId) {
      ok(await sb.from('channel_members').upsert({ channel_id: canalId, user_id: yo.id }, { ignoreDuplicates: true }));
    },
    async agregarAlCanal(canalId, userId) { ok(await sb.rpc('agregar_al_canal', { p_canal: canalId, p_user: userId })); },
    async sacarDelCanal(canalId, userId) { ok(await sb.rpc('sacar_del_canal', { p_canal: canalId, p_user: userId })); },
    async cerrarDM(canalId, hasta) {
      ok(await sb.from('channel_members').update({ cerrado: hasta, last_read_at: new Date().toISOString() }).match({ channel_id: canalId, user_id: yo.id }));
    },
    async abrirDM(otro) { return this.canal(ok(await sb.rpc('abrir_dm', { otro }))); },
    async mensajes(canalId) {
      const filas = ok(await sb.from('messages').select('*, reacciones:reactions(message_id, user_id, emoji)')
        .eq('channel_id', canalId).order('created_at', { ascending: false }).limit(600));
      return filas.reverse();
    },
    async enviar(canalId, texto, { parentId = null, archivo = null } = {}) {
      let adj = null;
      if (archivo) {
        if (archivo.size > 25 * 1024 * 1024) throw new Error('El archivo pesa más de 25 MB.');
        const limpio = archivo.name.normalize('NFD').replace(/[^\w.-]+/g, '_');
        const ruta = `${canalId}/${crypto.randomUUID()}-${limpio}`;
        ok(await sb.storage.from(BUCKET).upload(ruta, archivo, { contentType: archivo.type || 'application/octet-stream' }));
        adj = { nombre: archivo.name, tipo: archivo.type, tamano: archivo.size, ruta };
      }
      const m = ok(await sb.from('messages').insert({ channel_id: canalId, user_id: yo.id, parent_id: parentId, texto, archivo: adj }).select().single());
      // Pide los avisos push de este mensaje, sin esperar (la base de datos también los pide;
      // el servidor manda uno solo).
      sb.functions.invoke('notificar', { body: { message_id: m.id } }).catch(() => {});
      return { ...m, reacciones: [] };
    },
    async editar(id, texto) { ok(await sb.from('messages').update({ texto, editado: true }).eq('id', id)); },
    async borrar(id) { ok(await sb.from('messages').delete().eq('id', id)); },
    async reaccionar(messageId, emoji) {
      const borradas = ok(await sb.from('reactions').delete().match({ message_id: messageId, user_id: yo.id, emoji }).select());
      if (!borradas.length) ok(await sb.from('reactions').insert({ message_id: messageId, user_id: yo.id, emoji }));
    },
    // Solo actualiza: quien mira un canal público sin ser miembro no queda adentro por leerlo.
    async marcarLeido(canalId) {
      ok(await sb.from('channel_members').update({ last_read_at: new Date().toISOString() }).match({ channel_id: canalId, user_id: yo.id }));
    },
    // Una sola consulta: de cada canal donde estoy, último mensaje, no leídos y hasta cuándo lo cerré.
    async conversaciones() {
      const res = { noLeidos: {}, ultimo: {}, cerrado: {} };
      for (const f of ok(await sb.rpc('mis_conversaciones'))) {
        res.noLeidos[f.channel_id] = f.no_leidos || 0;
        if (f.ultimo) res.ultimo[f.channel_id] = f.ultimo;
        if (f.cerrado) res.cerrado[f.channel_id] = f.cerrado;
      }
      return res;
    },
    // Fecha del mensaje más nuevo que la persona puede ver (reloj del servidor).
    async ultimaFecha() {
      const filas = ok(await sb.from('messages').select('created_at').order('created_at', { ascending: false }).limit(1));
      return filas[0]?.created_at ?? null;
    },
    // Mensajes creados después de `desde`: lo que no llegó por la conexión en vivo.
    async novedades(desde, tope = 300) {
      return ok(await sb.from('messages').select('*, reacciones:reactions(message_id, user_id, emoji)')
        .gt('created_at', desde).order('created_at').limit(tope));
    },
    revisarConexion() { return revisar?.(); },
    // ---------- avisos ----------
    // Menciones y directos sin leer por conversación (para el número del ícono).
    async avisos() { return ok(await sb.rpc('mis_avisos')); },
    // Llave pública del servidor de avisos, para suscribir este dispositivo.
    async clavePush() {
      const r = await fetch(`${cfg.supabaseUrl}/functions/v1/notificar`, { headers: { apikey: cfg.supabaseAnonKey } });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (!j?.clave) throw new Error('el servidor de avisos no responde');
      return j.clave;
    },
    async guardarSuscripcion(s, dispositivo) {
      ok(await sb.rpc('guardar_suscripcion', { p_endpoint: s.endpoint, p_p256dh: s.keys.p256dh, p_auth: s.keys.auth, p_dispositivo: dispositivo }));
    },
    async quitarSuscripcion(endpoint) { ok(await sb.rpc('quitar_suscripcion', { p_endpoint: endpoint })); },
    async probarAviso() {
      const { data, error } = await sb.functions.invoke('notificar', { body: { prueba: true } });
      if (error) throw new Error('No se pudo pedir el aviso de prueba.');
      return data;
    },
    async usuariosSlack() { return ok(await sb.from('slack_usuarios').select('slack_id, nombre, avatar_url, user_id')); },
    async slackConectado() { return ok(await sb.rpc('slack_conectado')); },
    async urlConectarSlack() {
      const estado = ok(await sb.rpc('slack_iniciar'));
      const p = new URLSearchParams({
        client_id: cfg.slackClientId,
        user_scope: 'channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read,users:read.email,files:read',
        redirect_uri: `${cfg.supabaseUrl}/functions/v1/slack-oauth`,
        state: estado,
      });
      return `https://slack.com/oauth/v2/authorize?${p}`;
    },
    async importarSlack(accion = 'paso') {
      const { data, error } = await sb.functions.invoke('importar-slack', { body: { accion } });
      if (error) {
        const detalle = await error.context?.json?.().catch(() => null);
        throw new Error(detalle?.error || 'No se pudo hablar con el importador. ¿Está publicada la función "importar-slack"?');
      }
      return data;
    },
    async buscar(q) {
      const t = q.replace(/[%_,()]/g, ' ').trim();
      if (!t) return [];
      return ok(await sb.from('messages').select('*').ilike('texto', `%${t}%`).order('created_at', { ascending: false }).limit(50));
    },
    async urlArchivo(archivo) {
      // La dirección firmada dura 6 horas: se reutiliza hasta 5 y después se pide otra.
      const previa = urls.get(archivo.ruta);
      if (previa && Date.now() - previa.t < 5 * 3600_000) return previa.url;
      const { signedUrl } = ok(await sb.storage.from(BUCKET).createSignedUrl(archivo.ruta, 60 * 60 * 6));
      urls.set(archivo.ruta, { url: signedUrl, t: Date.now() });
      return signedUrl;
    },
    escribiendo(canalId, parentId) {
      pres?.send({ type: 'broadcast', event: 'escribiendo', payload: { channel_id: canalId, parent_id: parentId, user_id: yo.id } });
    },
    async resumir(canalId) {
      const { data, error } = await sb.functions.invoke('resumir', { body: { channel_id: canalId } });
      if (error) {
        const detalle = await error.context?.json?.().catch(() => null);
        throw new Error(detalle?.error || 'No se pudo generar el resumen. ¿Está publicada la función "resumir"?');
      }
      if (data.error) throw new Error(data.error);
      return data.resumen;
    },
    suscribir(h) {
      // El canal de cambios se vuelve a armar solo si se cae: al reconectar, la app pide
      // lo que no llegó mientras tanto (h.onReconexion).
      let cambios = null; let reintento = null; let caido = false; let n = 0; let intentos = 0;
      const conectar = () => {
        clearTimeout(reintento);
        if (cambios) sb.removeChannel(cambios);
        const ch = sb.channel(`cambios-${++n}`)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => h.onMensaje(p.eventType, p.new, p.old))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, (p) => h.onReaccion(p.eventType, p.new, p.old))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channels' }, (p) => h.onCanal({ ...p.new, miembros: [] }))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'channels' }, (p) => h.onCanalCambio(p.new))
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'channels' }, (p) => p.old?.id && h.onCanalBorrado(p.old.id))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channel_members' }, (p) => h.onMiembro('INSERT', p.new))
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'channel_members' }, (p) => p.old?.channel_id && h.onMiembro('DELETE', p.old))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (p) => p.new?.id && h.onUsuario(p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'slack_usuarios' }, (p) => p.new?.slack_id && h.onSlackUsuario(p.new));
        cambios = ch;
        ch.subscribe((estado) => {
          if (ch !== cambios) return; // un canal anterior que se está cerrando
          if (estado === 'SUBSCRIBED') { intentos = 0; if (caido) { caido = false; h.onReconexion?.(); } return; }
          caido = true; // CHANNEL_ERROR, TIMED_OUT o CLOSED
          clearTimeout(reintento); reintento = setTimeout(conectar, Math.min(30000, 4000 * ++intentos));
        });
      };
      conectar();
      revisar = async () => {
        const { data: { session } } = await sb.auth.getSession(); // renueva la sesión si venció
        if (session) sb.realtime.setAuth(session.access_token);
        if (!['joined', 'joining'].includes(cambios?.state)) { caido = true; intentos = 0; conectar(); }
      };
      pres = sb.channel('presencia', { config: { presence: { key: yo.id } } });
      pres.on('presence', { event: 'sync' }, () => h.onPresencia(new Set(Object.keys(pres.presenceState()))))
        .on('broadcast', { event: 'escribiendo' }, ({ payload }) => h.onEscribiendo(payload))
        .subscribe((estado) => { if (estado === 'SUBSCRIBED') pres.track({ desde: new Date().toISOString() }); });
    },
  };
}
