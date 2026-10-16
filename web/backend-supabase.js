// Backend real: Supabase (Postgres + Realtime + Auth con Google + Storage).
// Toda la seguridad está en las políticas RLS de supabase/esquema.sql; este
// archivo solo traduce las llamadas de la app.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const BUCKET = 'archivos';

export function crear(cfg) {
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  let yo = null;
  let pres = null;
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
      ok(await sb.auth.signInWithOAuth({ provider: 'google', options: opciones }));
    },
    async salir() { await sb.auth.signOut(); location.reload(); },
    async usuarios() { return ok(await sb.from('profiles').select('*').order('nombre')); },
    async canales() {
      return ok(await sb.from('channels').select('*, channel_members(user_id)').order('nombre')).map(conMiembros);
    },
    async crearCanal(nombre, descripcion) {
      const c = ok(await sb.from('channels').insert({ nombre, descripcion, creado_por: yo.id }).select().single());
      return { ...c, miembros: [] };
    },
    async abrirDM(otro) {
      const id = ok(await sb.rpc('abrir_dm', { otro }));
      return conMiembros(ok(await sb.from('channels').select('*, channel_members(user_id)').eq('id', id).single()));
    },
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
      return { ...m, reacciones: [] };
    },
    async editar(id, texto) { ok(await sb.from('messages').update({ texto, editado: true }).eq('id', id)); },
    async borrar(id) { ok(await sb.from('messages').delete().eq('id', id)); },
    async reaccionar(messageId, emoji) {
      const borradas = ok(await sb.from('reactions').delete().match({ message_id: messageId, user_id: yo.id, emoji }).select());
      if (!borradas.length) ok(await sb.from('reactions').insert({ message_id: messageId, user_id: yo.id, emoji }));
    },
    async marcarLeido(canalId) {
      ok(await sb.from('channel_members').upsert({ channel_id: canalId, user_id: yo.id, last_read_at: new Date().toISOString() }));
    },
    async noLeidos() {
      const [canales, lecturas] = await Promise.all([
        sb.from('channels').select('id').then(ok),
        sb.from('channel_members').select('channel_id, last_read_at').eq('user_id', yo.id).then(ok),
      ]);
      const desde = Object.fromEntries(lecturas.map((l) => [l.channel_id, l.last_read_at]));
      const res = {};
      await Promise.all(canales.map(async ({ id }) => {
        const { count } = await sb.from('messages').select('id', { count: 'exact', head: true })
          .eq('channel_id', id).is('parent_id', null).gt('created_at', desde[id] || yo.created_at)
          .or(`user_id.is.null,user_id.neq.${yo.id}`);
        res[id] = count || 0;
      }));
      return res;
    },
    async buscar(q) {
      const t = q.replace(/[%_,()]/g, ' ').trim();
      if (!t) return [];
      return ok(await sb.from('messages').select('*').ilike('texto', `%${t}%`).order('created_at', { ascending: false }).limit(50));
    },
    async urlArchivo(archivo) {
      if (urls.has(archivo.ruta)) return urls.get(archivo.ruta);
      const { signedUrl } = ok(await sb.storage.from(BUCKET).createSignedUrl(archivo.ruta, 60 * 60 * 6));
      urls.set(archivo.ruta, signedUrl);
      return signedUrl;
    },
    escribiendo(canalId, parentId) {
      pres?.send({ type: 'broadcast', event: 'escribiendo', payload: { channel_id: canalId, parent_id: parentId, user_id: yo.id } });
    },
    async resumir(canalId) {
      const { data, error } = await sb.functions.invoke('resumir', { body: { channel_id: canalId } });
      if (error) throw new Error('No se pudo generar el resumen. ¿Está publicada la función "resumir"?');
      if (data.error) throw new Error(data.error);
      return data.resumen;
    },
    suscribir(h) {
      sb.channel('cambios')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, (p) => h.onMensaje(p.eventType, p.new, p.old))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, (p) => h.onReaccion(p.eventType, p.new, p.old))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'channels' }, (p) => h.onCanal({ ...p.new, miembros: [] }))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (p) => p.new?.id && h.onUsuario(p.new))
        .subscribe();
      pres = sb.channel('presencia', { config: { presence: { key: yo.id } } });
      pres.on('presence', { event: 'sync' }, () => h.onPresencia(new Set(Object.keys(pres.presenceState()))))
        .on('broadcast', { event: 'escribiendo' }, ({ payload }) => h.onEscribiendo(payload))
        .subscribe((estado) => { if (estado === 'SUBSCRIBED') pres.track({ desde: new Date().toISOString() }); });
    },
  };
}
