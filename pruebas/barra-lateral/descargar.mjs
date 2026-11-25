// Baja a real.json la estructura de la base de Charla para ensayar migraciones: sin
// textos de mensajes, sin correos y sin archivos. Solo lee (GET). real.json no se guarda
// en el repositorio.
//   CHARLA_SERVICE_KEY=… node descargar.mjs
// Si la variable no está, la busca en el archivo que diga CHARLA_ENV
// (por defecto ~/Desktop/Ayudante COO/.env.local). La clave nunca se imprime.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
let KEY = process.env.CHARLA_SERVICE_KEY;
if (!KEY) {
  const env = readFileSync(process.env.CHARLA_ENV || `${homedir()}/Desktop/Ayudante COO/.env.local`, 'utf8');
  const linea = env.split('\n').find((l) => l.startsWith('CHARLA_SERVICE_KEY='));
  KEY = linea?.slice('CHARLA_SERVICE_KEY='.length).trim().split(/\s+#/)[0].replace(/^["']|["']$/g, '');
}
if (!KEY) throw new Error('Falta CHARLA_SERVICE_KEY.');
const BASE = 'https://swcvialsunqnwyuwkydy.supabase.co/rest/v1/';
async function get(ruta) {
  const todo = [];
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(BASE + ruta, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${desde}-${desde + 999}` } });
    if (!r.ok) throw new Error(`${r.status} ${ruta.split('?')[0]}`);
    const d = await r.json(); todo.push(...d);
    if (d.length < 1000) return todo;
  }
}
const d = {};
d.profiles = await get('profiles?select=id,nombre,usuario,created_at&order=id');
d.channels = await get('channels?select=id,nombre,descripcion,es_dm,es_privado,slack_id,creado_por,created_at&order=id');
d.channel_members = await get('channel_members?select=channel_id,user_id,last_read_at&order=channel_id,user_id');
// De cada persona de Slack solo importa si tenía correo (los bots no tienen).
d.slack_usuarios = (await get('slack_usuarios?select=slack_id,nombre,email,user_id&order=slack_id')).map((s) => ({ ...s, email: s.email ? `${s.slack_id.toLowerCase()}@x.test` : null }));
d.slack_miembros = await get('slack_miembros?select=channel_id,slack_id&order=channel_id,slack_id');
d.importaciones = (await get('importaciones?select=user_id,estado')).map((i) => ({ user_id: i.user_id, estado: { cola: (i.estado.cola || []).map((c) => ({ charla: c.charla, tipo: c.tipo })) } }));
d.webhooks = (await get('webhooks?select=channel_id,nombre')).map((w, i) => ({ ...w, token: `prueba${i}` }));
d.messages = (await get('messages?select=id,channel_id,user_id,bot_nombre,parent_id,created_at,slack_id,slack_autor&order=id')).map((m) => ({ ...m, bot_nombre: m.bot_nombre ? 'bot' : null }));
writeFileSync(new URL('./real.json', import.meta.url), JSON.stringify(d));
console.log(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])));
