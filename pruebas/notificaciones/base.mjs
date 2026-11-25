// Arma un Postgres en memoria (PGlite) con el esquema de Charla + 006 y datos de prueba.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const R = process.env.CHARLA_REPO || new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export async function crearBase({ conNet = true } = {}) {
  const db = new PGlite();
  await db.exec(readFileSync(new URL('./stub.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(`${R}/supabase/esquema.sql`, 'utf8'));
  await db.exec(readFileSync(`${R}/supabase/migraciones/002_importar_slack.sql`, 'utf8'));
  if (conNet) await db.exec(`create schema net; create table net.llamadas (url text, body jsonb, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language plpgsql as $$ begin insert into net.llamadas values (url, body, headers); return 1; end $$;
    grant usage on schema net to authenticated, anon, service_role; grant all on net.llamadas to authenticated, anon, service_role;`);
  const sql006 = readFileSync(`${R}/supabase/migraciones/006_notificaciones.sql`, 'utf8');
  await db.exec(sql006);
  const u = {};
  for (const [k, nombre, correo] of [['ana', 'Ana Ríos', 'ana'], ['beto', 'Beto Paz', 'beto'], ['caro', 'Caro Luna', 'caro.x'], ['dani', 'Dani Sol', 'dani']]) {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [`${correo}@everfreshmedia.com`, { full_name: nombre }]);
    u[k] = r.rows[0].id;
  }
  const una = async (q, p = []) => (await db.query(q, p)).rows[0];
  const c = {};
  c.general = (await una(`select id from channels where nombre = 'general'`)).id;
  c.alertas = (await una(`select id from channels where nombre = 'alertas-crm'`)).id;
  c.equipo = (await una(`insert into channels (nombre, es_privado, creado_por) values ('equipo', true, $1) returning id`, [u.ana])).id;
  await db.query(`insert into channel_members (channel_id, user_id) values ($1, $2), ($1, $3)`, [c.equipo, u.ana, u.beto]);
  for (const [k, a, b] of [['dmAB', 'ana', 'beto'], ['dmAC', 'ana', 'caro']]) {
    const [x, y] = [u[a], u[b]].sort();
    c[k] = (await una(`insert into channels (nombre, es_dm, creado_por) values ($1, true, $2) returning id`, [`dm:${x}:${y}`, u[a]])).id;
    await db.query(`insert into channel_members (channel_id, user_id) values ($1, $2), ($1, $3)`, [c[k], u[a], u[b]]);
  }
  // Ejecuta como una persona (rol authenticated + su sesión), como anónimo o como el servidor.
  async function como(quien, q, p = []) {
    const rol = quien === 'servidor' ? 'service_role' : quien === 'anon' ? 'anon' : 'authenticated';
    await db.exec(`reset role; select set_config('request.jwt.claims', '${quien in u ? JSON.stringify({ sub: u[quien] }) : '{}'}', false); set role ${rol};`);
    try { return (await db.query(q, p)).rows; } finally { await db.exec(`reset role; select set_config('request.jwt.claims', '{}', false);`); }
  }
  async function mensaje(autor, canal, texto, extra = {}) {
    const cols = { channel_id: c[canal] ?? canal, user_id: autor ? u[autor] : null, texto, ...extra };
    const ks = Object.keys(cols);
    return (await una(`insert into messages (${ks.join(',')}) values (${ks.map((_, i) => `$${i + 1}`).join(',')}) returning id`, Object.values(cols))).id;
  }
  return { db, u, c, como, mensaje, una, sql006 };
}
