// Mide los conteos y los destinatarios con el volumen real (estructura real, textos inventados).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const R = process.env.CHARLA_REPO || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const d = JSON.parse(readFileSync('real.json', 'utf8'));
const db = new PGlite();
await db.exec(readFileSync('stub.sql', 'utf8'));
await db.exec(readFileSync(`${R}/supabase/esquema.sql`, 'utf8'));
await db.exec(readFileSync(`${R}/supabase/migraciones/002_importar_slack.sql`, 'utf8'));
await db.exec('truncate public.channels cascade');
for (const [i, p] of d.profiles.entries()) await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')`, [p.id, `persona${i}@everfreshmedia.com`]);
for (const p of d.profiles) await db.query('update profiles set usuario = $2, created_at = $3 where id = $1', [p.id, p.usuario, p.created_at]);
for (const c of d.channels) await db.query('insert into channels (id, nombre, es_dm, es_privado, created_at) values ($1, $2, $3, $4, $5)', [c.id, 'c-' + c.id, c.es_dm, c.es_privado, c.created_at]);
for (const m of d.members) await db.query('insert into channel_members (channel_id, user_id, last_read_at) values ($1, $2, $3)', [m.channel_id, m.user_id, m.last_read_at]);
const handles = d.profiles.map((p) => p.usuario);
console.log('cargando', d.messages.length, 'mensajes…');
for (let i = 0; i < d.messages.length; i += 400) {
  const lote = d.messages.slice(i, i + 400);
  const vals = [];
  const ps = [];
  lote.forEach((m, k) => {
    // Texto inventado: 1 de cada 15 menciona a alguien del equipo, 1 de cada 40 dice @canal.
    const n = i + k;
    const texto = n % 15 === 0 ? `oye @${handles[n % handles.length]} mira esto` : n % 40 === 0 ? '@canal aviso general' : n % 7 === 0 ? 'escribe a alguien@correo.com' : 'mensaje común de prueba';
    const b = k * 8;
    ps.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
    vals.push(m.id, m.channel_id, m.user_id, m.bot_nombre, null, m.slack_id, m.created_at, texto);
  });
  await db.query(`insert into messages (id, channel_id, user_id, bot_nombre, parent_id, slack_id, created_at, texto) values ${ps.join(',')}`, vals);
}
await db.exec(readFileSync(`${R}/supabase/migraciones/006_notificaciones.sql`, 'utf8'));
await db.exec('analyze');
console.log('006 aplicada sobre la base con datos (sin pg_net: avisa y sigue)');

const medir = async (q, p) => { const t = performance.now(); const r = await db.query(q, p); return [performance.now() - t, r.rows]; };
let peor = 0;
for (const p of d.profiles) {
  const [ms, filas] = await medir('select * from public._avisos_de($1)', [p.id]);
  peor = Math.max(peor, ms);
  console.log(`  conteos de ${p.usuario.slice(0, 2)}…: ${ms.toFixed(0)} ms · ${filas.length} conversaciones con algo sin leer · total ${filas.reduce((a, f) => a + f.directos + f.menciones, 0)}`);
}
// Peor caso: una persona que nunca leyó nada.
await db.query(`update channel_members set last_read_at = '2020-01-01'`);
await db.query(`update profiles set created_at = '2020-01-01'`);
for (const p of d.profiles.slice(0, 2)) {
  const [ms, filas] = await medir('select * from public._avisos_de($1)', [p.id]);
  peor = Math.max(peor, ms);
  console.log(`  peor caso (nada leído nunca) ${p.usuario.slice(0, 2)}…: ${ms.toFixed(0)} ms · total ${filas.reduce((a, f) => a + f.directos + f.menciones, 0)}`);
}
// Destinatarios de un mensaje nuevo, con todos suscritos (2 dispositivos cada uno).
for (const p of d.profiles) for (const k of [1, 2]) await db.query('insert into push_suscripciones (endpoint, user_id, p256dh, auth) values ($1, $2, $3, $4)', [`https://fcm.googleapis.com/fcm/send/${p.id}-${k}`, p.id, 'B'.repeat(87), 'a'.repeat(22)]);
const publico = d.channels.find((c) => !c.es_dm && !c.es_privado).id;
const nuevo = (await db.query(`insert into messages (channel_id, user_id, texto) values ($1, $2, '@canal reunión') returning id`, [publico, d.profiles[0].id])).rows[0].id;
const [ms2, r2] = await medir('select public._push_destinos($1) d', [nuevo]);
console.log(`  destinatarios de un @canal (peor caso de conteos): ${ms2.toFixed(0)} ms · ${r2[0].d.length} dispositivos`);
const t = performance.now();
for (let i = 0; i < 200; i++) await db.query(`insert into messages (channel_id, user_id, texto) values ($1, $2, 'mensaje')`, [publico, d.profiles[0].id]);
console.log(`  200 mensajes nuevos con el disparador puesto: ${((performance.now() - t) / 200).toFixed(2)} ms cada uno`);
console.log(peor < 1500 && ms2 < 5000 ? '\nEscala: bien' : '\nEscala: LENTO');
