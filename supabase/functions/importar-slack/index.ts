// Función "importar-slack": trae a Charla lo que una persona ve en Slack.
//
// La app la llama una y otra vez (POST { accion: 'paso' }) hasta que responde
// hecho: true. Cada llamada trabaja unos 45 segundos y guarda por dónde iba en
// la tabla importaciones, así que se puede cortar y seguir otro día.
//
//   1. Prepara: personas de Slack (para nombres, fotos y unir por correo) y las
//      conversaciones donde está la persona: canales públicos y privados,
//      mensajes directos y grupales. Crea o reutiliza el canal de Charla.
//   2. Por cada conversación: el historial completo en páginas de 200, y por
//      cada mensaje con respuestas, su hilo. Con reacciones y archivos.
//
// Cada mensaje se guarda con su id de Slack ('<canal>:<ts>'): importar dos
// veces, o que dos personas importen el mismo canal, no duplica nada.
// Usa el token de usuario de Slack de quien llama (slack_tokens) y escribe con
// la service role. Archivos de hasta 20 MB; los más pesados quedan como aviso.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const PRESUPUESTO_MS = 45_000;
const LIMITE_ARCHIVO = 20 * 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Mensajes de sistema de Slack que no aportan (entró/salió, cambió el tema…).
const SUBTIPOS_OK = new Set(['bot_message', 'thread_broadcast', 'file_share', 'me_message']);

const EMOJI: Record<string, string> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', heart: '❤️', joy: '😂', tada: '🎉', pray: '🙏',
  eyes: '👀', white_check_mark: '✅', heavy_check_mark: '✔️', fire: '🔥', raised_hands: '🙌', clap: '👏',
  smile: '😄', slightly_smiling_face: '🙂', grinning: '😀', smiley: '😃', rocket: '🚀', 100: '💯', ok_hand: '👌',
  muscle: '💪', thinking_face: '🤔', sob: '😭', cry: '😢', star: '⭐', star2: '🌟', x: '❌', warning: '⚠️',
  wave: '👋', sunglasses: '😎', laughing: '😆', blush: '😊', heart_eyes: '😍', sweat_smile: '😅',
  point_up: '☝️', point_right: '👉', point_left: '👈', point_down: '👇', raised_hand: '✋', see_no_evil: '🙈',
  sparkles: '✨', rotating_light: '🚨', moneybag: '💰', money_with_wings: '💸', chart_with_upwards_trend: '📈',
  chart_with_downwards_trend: '📉', calendar: '📅', memo: '📝', phone: '📞', email: '📧', link: '🔗',
  bulb: '💡', pushpin: '📌', rocket_ship: '🚀', partying_face: '🥳', hugging_face: '🤗', relaxed: '☺️',
  wink: '😉', innocent: '😇', upside_down_face: '🙃', rolling_on_the_floor_laughing: '🤣', grin: '😁',
  star_struck: '🤩', face_with_rolling_eyes: '🙄', scream: '😱', exploding_head: '🤯', facepalm: '🤦',
  man_facepalming: '🤦‍♂️', woman_facepalming: '🤦‍♀️', shrug: '🤷', handshake: '🤝', v: '✌️',
  crossed_fingers: '🤞', heart_hands: '🫶', purple_heart: '💜', blue_heart: '💙', green_heart: '💚',
  yellow_heart: '💛', orange_heart: '🧡', black_heart: '🖤', white_heart: '🤍', broken_heart: '💔',
  sparkling_heart: '💖', two_hearts: '💕', gift: '🎁', confetti_ball: '🎊', trophy: '🏆', medal: '🏅',
  dart: '🎯', zap: '⚡', boom: '💥', bell: '🔔', loudspeaker: '📢', mega: '📣', speech_balloon: '💬',
  question: '❓', exclamation: '❗', heavy_plus_sign: '➕', arrow_right: '➡️', arrow_up: '⬆️',
  arrow_down: '⬇️', hourglass: '⌛', alarm_clock: '⏰', coffee: '☕', pizza: '🍕', beers: '🍻',
  champagne: '🍾', sunny: '☀️', rainbow: '🌈', seedling: '🌱', sun_with_face: '🌞', earth_americas: '🌎',
  airplane: '✈️', house: '🏠', computer: '💻', iphone: '📱', camera: '📷', movie_camera: '🎥',
  headphones: '🎧', books: '📚', pencil2: '✏️', paperclip: '📎', lock: '🔒', key: '🔑', mag: '🔍',
  hammer_and_wrench: '🛠️', gear: '⚙️', white_circle: '⚪', red_circle: '🔴', large_green_circle: '🟢',
  large_yellow_circle: '🟡', large_blue_circle: '🔵', no_entry: '⛔', stop_sign: '🛑', ok: '🆗',
  new: '🆕', sos: '🆘', saluting_face: '🫡', melting_face: '🫠', smiling_face_with_tear: '🥲',
  money_mouth_face: '🤑', nerd_face: '🤓', yum: '😋', kissing_heart: '😘', flushed: '😳', pensive: '😔',
  disappointed: '😞', rage: '😡', angry: '😠', skull: '💀', ghost: '👻', robot_face: '🤖', alien: '👽',
};

class Espera extends Error {
  constructor(public segundos: number) { super('Slack pidió esperar'); }
}

async function slack(token: string, metodo: string, params: Record<string, string> = {}) {
  const r = await fetch(`https://slack.com/api/${metodo}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 429) throw new Espera(Number(r.headers.get('retry-after') ?? 10));
  const j = await r.json();
  if (!j.ok) throw new Error(`Slack ${metodo}: ${j.error}`);
  return j;
}

async function todasLasPaginas(token: string, metodo: string, params: Record<string, string>, clave: string) {
  const res: any[] = [];
  let cursor = '';
  do {
    const j = await slack(token, metodo, { ...params, limit: '200', ...(cursor ? { cursor } : {}) });
    res.push(...(j[clave] ?? []));
    cursor = j.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return res;
}

const deTs = (ts: string) => new Date(Math.round(parseFloat(ts) * 1000)).toISOString();
const deTsMas = (ts: string, ms: number) => new Date(Math.round(parseFloat(ts) * 1000) + ms).toISOString();
const unico = (base: string, usados: Set<string>) => {
  let n = base; let k = 2;
  while (usados.has(n)) n = `${base}-${k++}`;
  usados.add(n);
  return n;
};
const slug = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'canal';

// Texto de Slack (mrkdwn) → texto de Charla.
function convertir(texto: string, E: any) {
  let t = texto ?? '';
  t = t.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => (E.handles[id] ? `@${E.handles[id]}` : `@${E.nombres[id] ?? 'alguien'}`));
  t = t.replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1');
  t = t.replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@canal');
  t = t.replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, n) => n ?? '@grupo');
  t = t.replace(/<!date\^\d+\^[^|>]*\|([^>]*)>/g, '$1');
  t = t.replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, '$1');
  t = t.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, txt) => (txt === url ? url : `${txt} (${url})`));
  t = t.replace(/<(https?:\/\/[^>]+)>/g, '$1');
  t = t.replace(/:([a-z0-9_+\-]+)(?:::skin-tone-\d)?:/g, (m, n) => EMOJI[n] ?? m);
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------- Preparar ----------
async function preparar(token: string, slackYo: string, userId: string, solo?: string[]) {
  // Personas de Slack.
  const miembros = await todasLasPaginas(token, 'users.list', {}, 'members');
  const filas = miembros.map((m: any) => ({
    slack_id: m.id,
    nombre: m.profile?.real_name || m.profile?.display_name || m.real_name || m.name || 'Alguien',
    email: m.profile?.email ?? null,
    avatar_url: m.profile?.image_72 ?? null,
  }));
  for (let i = 0; i < filas.length; i += 500) await admin.from('slack_usuarios').upsert(filas.slice(i, i + 500));

  // Unir con Charla: quien importa por su token; el resto por correo o nombre exacto.
  await admin.rpc('vincular_slack', { p_user: userId, p_slack: slackYo });
  const { data: perfiles } = await admin.from('profiles').select('id, email, nombre, usuario');
  const { data: personas } = await admin.from('slack_usuarios').select('slack_id, nombre, email, user_id');
  for (const s of personas ?? []) {
    if (s.user_id) continue;
    const p = (perfiles ?? []).find((x) => (s.email && x.email.toLowerCase() === s.email.toLowerCase()))
      ?? (perfiles ?? []).find((x) => x.nombre.toLowerCase() === s.nombre.toLowerCase());
    if (p) { await admin.rpc('vincular_slack', { p_user: p.id, p_slack: s.slack_id }); s.user_id = p.id; }
  }
  const usuarios: Record<string, string | null> = {};
  const nombres: Record<string, string> = {};
  const handles: Record<string, string> = {};
  for (const s of personas ?? []) {
    usuarios[s.slack_id] = s.user_id ?? null;
    nombres[s.slack_id] = s.nombre;
    const p = (perfiles ?? []).find((x) => x.id === s.user_id);
    if (p) handles[s.slack_id] = p.usuario;
  }
  usuarios[slackYo] = userId;

  // Conversaciones donde está la persona.
  let convs = await todasLasPaginas(token, 'users.conversations',
    { types: 'public_channel,private_channel,mpim,im', exclude_archived: 'false' }, 'channels');
  if (solo?.length) convs = convs.filter((c: any) => solo.includes(c.name) || solo.includes(c.id));

  const { data: existentes } = await admin.from('channels').select('id, nombre, slack_id, es_dm, es_privado');
  const usados = new Set((existentes ?? []).map((c) => c.nombre));
  const cola = [];
  for (const c of convs) {
    const nombreSlack = c.is_im ? nombres[c.user] ?? 'Mensaje directo' : c.name;
    let canal = (existentes ?? []).find((x) => x.slack_id === c.id);
    const miembrosSlack: string[] = c.is_im ? [slackYo, c.user]
      : (c.is_private || c.is_mpim) ? await todasLasPaginas(token, 'conversations.members', { channel: c.id }, 'members') : [];

    if (!canal && c.is_im) {
      const otro = usuarios[c.user];
      if (otro) {
        const nom = `dm:${[userId, otro].sort().join(':')}`;
        canal = (existentes ?? []).find((x) => x.nombre === nom);
        if (!canal) {
          const { data } = await admin.from('channels').insert({ nombre: nom, es_dm: true, creado_por: userId, slack_id: c.id }).select().single();
          canal = data;
        } else if (!canal.slack_id) await admin.from('channels').update({ slack_id: c.id }).eq('id', canal.id);
      } else {
        const { data } = await admin.from('channels')
          .insert({ nombre: `slack:${c.id}`, es_dm: true, descripcion: nombreSlack, creado_por: userId, slack_id: c.id }).select().single();
        canal = data;
      }
    } else if (!canal && !c.is_private && !c.is_mpim) {
      canal = (existentes ?? []).find((x) => x.nombre === slug(c.name) && !x.es_dm && !x.es_privado && !x.slack_id);
      if (canal) await admin.from('channels').update({ slack_id: c.id }).eq('id', canal.id);
      else {
        const { data } = await admin.from('channels').insert({
          nombre: unico(slug(c.name), usados), descripcion: c.purpose?.value || c.topic?.value || '',
          creado_por: userId, slack_id: c.id,
        }).select().single();
        canal = data;
      }
    } else if (!canal) {
      const base = c.is_mpim ? `grupo-${miembrosSlack.filter((m) => m !== slackYo).map((m) => slug((nombres[m] ?? 'x').split(' ')[0])).join('-')}` : slug(c.name);
      const { data } = await admin.from('channels').insert({
        nombre: unico(base.slice(0, 70), usados), descripcion: c.purpose?.value || '', es_privado: true, creado_por: userId, slack_id: c.id,
      }).select().single();
      canal = data;
    }
    if (!canal) continue;

    if (miembrosSlack.length) {
      await admin.from('slack_miembros').upsert(miembrosSlack.map((s) => ({ channel_id: canal.id, slack_id: s })), { ignoreDuplicates: true });
      const charla = [...new Set(miembrosSlack.map((s) => usuarios[s]).filter(Boolean))] as string[];
      if (charla.length) await admin.from('channel_members').upsert(charla.map((u) => ({ channel_id: canal.id, user_id: u })), { ignoreDuplicates: true });
    }
    cola.push({ slack: c.id, charla: canal.id, nombre: c.is_im ? nombreSlack : c.is_mpim ? 'grupo' : c.name, tipo: c.is_im ? 'dm' : c.is_mpim ? 'grupo' : c.is_private ? 'privado' : 'canal', listo: false });
  }
  return { cola, i: 0, cursor: null, hilos: [], mensajes: 0, archivos: 0, pesados: 0, hecho: cola.length === 0, usuarios, nombres, handles, inicio: new Date().toISOString() };
}

// ---------- Guardar una tanda de mensajes ----------
async function subirArchivo(token: string, f: any, canalId: string) {
  const r = await fetch(f.url_private_download ?? f.url_private, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  const limpio = String(f.name ?? 'archivo').normalize('NFD').replace(/[^\w.-]+/g, '_');
  const ruta = `${canalId}/slack-${f.id}-${limpio}`;
  const tipo = f.mimetype || 'application/octet-stream';
  const { error } = await admin.storage.from('archivos').upload(ruta, bytes, { contentType: tipo, upsert: true });
  if (error) return null;
  return { nombre: f.name ?? limpio, tipo, tamano: bytes.length, ruta };
}

async function guardar(E: any, c: any, mensajes: any[], padreId: string | null, token: string) {
  const utiles = mensajes.filter((m) => m.type === 'message' && (!m.subtype || SUBTIPOS_OK.has(m.subtype)));
  if (!utiles.length) return;
  const ids = utiles.map((m) => `${c.slack}:${m.ts}`);
  const { data: ya } = await admin.from('messages').select('slack_id').in('slack_id', ids);
  const yaEstan = new Set((ya ?? []).map((x) => x.slack_id));

  const filas: any[] = [];
  for (const m of utiles) {
    const sid = `${c.slack}:${m.ts}`;
    if (yaEstan.has(sid)) continue;
    const esBot = m.subtype === 'bot_message' || (m.bot_id && !m.user);
    let texto = convertir(m.text, E);
    for (const a of m.attachments ?? []) {
      const extra = [a.pretext, a.title, a.text ?? a.fallback].filter(Boolean).join('\n');
      if (extra) texto += `${texto ? '\n' : ''}${convertir(extra, E)}`;
    }
    const base = {
      channel_id: c.charla, parent_id: padreId, created_at: deTs(m.ts), editado: !!m.edited,
      user_id: esBot ? null : E.usuarios[m.user] ?? null, slack_autor: esBot ? null : m.user ?? null,
      bot_nombre: esBot ? (m.username || m.bot_profile?.name || 'App') : null,
    };
    const adjuntos: any[] = [];
    const avisos: string[] = [];
    for (const f of m.files ?? []) {
      if (f.mode === 'tombstone' || f.mode === 'hidden_by_limit') continue;
      if (f.is_external || f.mode === 'external') { avisos.push(`📎 ${f.title ?? f.name}: ${f.url_private ?? ''}`); continue; }
      if ((f.size ?? 0) > LIMITE_ARCHIVO) { avisos.push(`📎 ${f.name} (no se importó: pesa ${((f.size ?? 0) / 1048576).toFixed(0)} MB)`); E.pesados++; continue; }
      const a = await subirArchivo(token, f, c.charla);
      if (a) { adjuntos.push(a); E.archivos++; } else avisos.push(`📎 ${f.name} (no se pudo copiar)`);
    }
    if (avisos.length) texto += `${texto ? '\n' : ''}${avisos.join('\n')}`;
    filas.push({ ...base, slack_id: sid, texto: texto.slice(0, 40000), archivo: adjuntos[0] ?? null });
    adjuntos.slice(1).forEach((a, k) => filas.push({ ...base, slack_id: `${sid}:f${k + 2}`, texto: '', archivo: a, created_at: deTsMas(m.ts, k + 1) }));
  }
  if (filas.length) {
    const { error } = await admin.from('messages').upsert(filas, { onConflict: 'slack_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    E.mensajes += filas.length;
  }

  // Reacciones de quienes ya están en Charla.
  const conReac = utiles.filter((m) => m.reactions?.length);
  if (conReac.length) {
    const { data: filasIds } = await admin.from('messages').select('id, slack_id').in('slack_id', conReac.map((m) => `${c.slack}:${m.ts}`));
    const idDe = new Map((filasIds ?? []).map((x) => [x.slack_id, x.id]));
    const reac: any[] = [];
    for (const m of conReac) {
      const mid = idDe.get(`${c.slack}:${m.ts}`);
      if (!mid) continue;
      for (const r of m.reactions) {
        const nombre = r.name.split('::')[0];
        const emoji = EMOJI[nombre] ?? `:${nombre}:`.slice(0, 16);
        for (const u of r.users ?? []) if (E.usuarios[u]) reac.push({ message_id: mid, user_id: E.usuarios[u], emoji });
      }
    }
    if (reac.length) await admin.from('reactions').upsert(reac, { ignoreDuplicates: true });
  }
}

// ---------- Un paso ----------
async function avanzar(E: any, token: string) {
  const c = E.cola[E.i];
  if (!c) { E.hecho = true; return; }
  try {
    if (E.hilos.length) {
      const ts = E.hilos[0];
      const respuestas = (await todasLasPaginas(token, 'conversations.replies', { channel: c.slack, ts }, 'messages'))
        .filter((m: any) => m.ts !== ts);
      const { data: padre } = await admin.from('messages').select('id').eq('slack_id', `${c.slack}:${ts}`).maybeSingle();
      if (padre) await guardar(E, c, respuestas, padre.id, token);
      E.hilos.shift();
      return;
    }
    if (c.listo) {
      E.i++; E.cursor = null;
      if (E.i >= E.cola.length) E.hecho = true;
      return;
    }
    const j = await slack(token, 'conversations.history', { channel: c.slack, limit: '200', ...(E.cursor ? { cursor: E.cursor } : {}) });
    await guardar(E, c, j.messages ?? [], null, token);
    for (const m of j.messages ?? []) if (m.reply_count && m.thread_ts === m.ts) E.hilos.push(m.ts);
    E.cursor = j.has_more ? j.response_metadata?.next_cursor || null : null;
    if (!E.cursor) c.listo = true;
  } catch (e) {
    if (e instanceof Espera) throw e;
    // Una conversación que falla no frena el resto.
    c.error = String((e as Error).message ?? e);
    c.listo = true; E.hilos = [];
  }
}

const resumen = (E: any) => ({
  hecho: !!E.hecho,
  total: E.cola?.length ?? 0,
  i: Math.min(E.i ?? 0, E.cola?.length ?? 0),
  actual: E.cola?.[E.i]?.nombre ?? null,
  tipo: E.cola?.[E.i]?.tipo ?? null,
  mensajes: E.mensajes ?? 0,
  archivos: E.archivos ?? 0,
  pesados: E.pesados ?? 0,
  errores: (E.cola ?? []).filter((c: any) => c.error).map((c: any) => `${c.nombre}: ${c.error}`),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json({ error: 'Sin sesión' }, 401);
    const { accion = 'paso', solo } = await req.json().catch(() => ({}));

    const { data: tok } = await admin.from('slack_tokens').select('token, slack_user_id').eq('user_id', user.id).maybeSingle();
    if (!tok) return json({ conectado: false });
    const { data: imp } = await admin.from('importaciones').select('estado').eq('user_id', user.id).maybeSingle();
    let E: any = imp?.estado ?? {};
    if (accion === 'estado') return json({ conectado: true, empezada: !!E.cola, ...resumen(E) });

    const inicio = Date.now();
    let espera = 0;
    try {
      if (accion === 'reiniciar' || !E.cola) E = await preparar(tok.token, tok.slack_user_id, user.id, solo);
      while (!E.hecho && Date.now() - inicio < PRESUPUESTO_MS) await avanzar(E, tok.token);
    } catch (e) {
      if (e instanceof Espera) espera = e.segundos;
      else throw e;
    } finally {
      if (E.cola) await admin.from('importaciones').upsert({ user_id: user.id, estado: E, actualizado: new Date().toISOString() });
    }
    return json({ conectado: true, empezada: true, ...resumen(E), espera });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
