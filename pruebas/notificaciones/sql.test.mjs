import { crearBase } from './base.mjs';
let ok = 0, mal = 0;
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function prueba(nombre, cond, detalle = '') { if (cond) ok++; else { mal++; console.log('  ✗', nombre, detalle); } }
async function falla(nombre, f, patron) { try { await f(); mal++; console.log('  ✗', nombre, '(no falló)'); } catch (e) { prueba(nombre, !patron || patron.test(e.message), e.message); } }

const { db, u, c, como, mensaje, una, sql006 } = await crearBase();
const E = (n) => `https://fcm.googleapis.com/fcm/send/${n}`;
const P = 'B'.repeat(87), A = 'a'.repeat(22);
const nombres = Object.fromEntries(Object.entries(u).map(([k, v]) => [v, k]));

// --- 1. Suscripciones y permisos
await como('beto', `select guardar_suscripcion($1, $2, $3, 'Mac')`, [E('beto-1'), P, A]);
await como('beto', `select guardar_suscripcion($1, $2, $3, 'iPhone')`, [E('beto-2'), P, A]);
await como('caro', `select guardar_suscripcion($1, $2, $3, '')`, [E('caro-1'), P, A]);
await como('ana', `select guardar_suscripcion($1, $2, $3, '')`, [E('ana-1'), P, A]);
await como('dani', `select guardar_suscripcion($1, $2, $3, '')`, [E('dani-1'), P, A]);
prueba('beto ve solo sus 2 dispositivos', (await como('beto', 'select endpoint from push_suscripciones')).length === 2);
prueba('anon no ve dispositivos', (await como('anon', 'select endpoint from push_suscripciones').catch(() => [])).length === 0);
await falla('anon no puede suscribir', () => como('anon', `select guardar_suscripcion($1, $2, $3, '')`, [E('x'), P, A]), /permission denied|Sin permiso/);
await falla('rechaza endpoint que no es https', () => como('beto', `select guardar_suscripcion('http://malo', $1, $2, '')`, [P, A]), /no válida/);
await falla('rechaza llave vacía', () => como('beto', `select guardar_suscripcion($1, '', $2, '')`, [E('y'), A]), /no válida/);
await falla('no se puede insertar directo en la tabla', () => como('beto', `insert into push_suscripciones (endpoint, user_id, p256dh, auth) values ($1, $2, $3, $4)`, [E('z'), u.caro, P, A]), /row-level security|permission/);
await como('beto', `select quitar_suscripcion($1)`, [E('caro-1')]);
prueba('beto no puede quitar el dispositivo de caro', (await una(`select count(*)::int n from push_suscripciones where endpoint = $1`, [E('caro-1')])).n === 1);
await como('caro', `select guardar_suscripcion($1, $2, $3, 'mismo navegador')`, [E('beto-2'), P, A]);
prueba('un dispositivo cambia de dueño si entra otra persona', (await una(`select user_id from push_suscripciones where endpoint = $1`, [E('beto-2')])).user_id === u.caro);
await como('caro', `select quitar_suscripcion($1)`, [E('beto-2')]);
await como('beto', `select guardar_suscripcion($1, $2, $3, 'iPhone')`, [E('beto-2'), P, A]);
for (const t of ['push_ajustes', 'push_enviados']) for (const q of ['beto', 'anon'])
  prueba(`${q} no lee ${t}`, (await como(q, `select * from ${t}`).catch(() => [])).length === 0);
for (const f of [`_avisos_de('${u.beto}')`, `_push_destinos('${u.beto}')`, `_push_reclamar('${u.beto}')`, `_push_prueba('${u.beto}')`, `_push_borrar(array['x'])`, `_push_ajuste('secreto')`, `_push_fijar_ajuste('a', 'b')`])
  for (const q of ['beto', 'anon']) await falla(`${q} no puede llamar ${f.split('(')[0]}`, () => como(q, `select public.${f}`), /permission denied/);
await falla('anon no puede llamar mis_avisos', () => como('anon', 'select * from mis_avisos()'), /permission denied/);

// --- 2. A quién se avisa
const dest = async (id, autor = null) => (await como('servidor', 'select public._push_destinos($1, $2) d', [id, autor]))[0].d;
const quienes = (d) => [...new Set(d.map((x) => x.endpoint.split('/').pop().split('-')[0]))].sort();
let m = await mensaje('ana', 'dmAB', 'hola Beto, ¿puedes hablar?');
let d = await dest(m);
prueba('DM: llega a los 2 dispositivos de beto', d.length === 2 && igual(quienes(d), ['beto']), JSON.stringify(d));
prueba('DM: título = quien escribe, sin nombre de canal', d[0]?.titulo === 'Ana Ríos' && d[0]?.cuerpo === 'hola Beto, ¿puedes hablar?' && d[0]?.canal === c.dmAB && d[0]?.id === m, JSON.stringify(d[0]));
prueba('DM: insignia de beto = 1', d[0]?.insignia === 1, d[0]?.insignia);
prueba('con autor correcto, igual', (await dest(m, u.ana)).length === 2);
prueba('con autor falso, nada', (await dest(m, u.beto)).length === 0);
const casos = [
  ['general', 'hola @beto ¿viste esto?', ['beto']],
  ['general', '@canal reunión a las 5', ['beto', 'caro', 'dani']],
  ['general', 'atención @todos', ['beto', 'caro', 'dani']],
  ['general', 'escríbanle a ana@beto.com', []],
  ['general', '@betoven no es beto', []],
  ['general', 'gracias (@beto)', ['beto']],
  ['general', '@BETO en mayúsculas', ['beto']],
  ['general', '@caro.x mira esto', ['caro']],
  ['general', '@carox no existe', []],
  ['general', 'sin menciones', []],
  ['general', '@ana me menciono sola', []],
  ['equipo', '@canal solo el equipo', ['beto']],
  ['equipo', '@caro.x no estás en este canal privado', []],
  ['dmAC', 'hola caro', ['caro']],
];
for (const [canal, texto, esperado] of casos) { const r = quienes(await dest(await mensaje('ana', canal, texto))); prueba(`"${texto}" en ${canal} → [${esperado}]`, igual(r, esperado), `salió [${r}]`); }
d = await dest(await mensaje('ana', 'general', 'aviso @beto'));
prueba('canal: título con el nombre del canal', d[0]?.titulo === 'Ana Ríos en #general', d[0]?.titulo);
d = await dest(await mensaje(null, 'alertas', 'Recordatorio @caro.x: mover oportunidad', { bot_nombre: 'CRM' }));
prueba('bot que menciona: avisa y firma el bot', igual(quienes(d), ['caro']) && d[0]?.titulo === 'CRM en #alertas-crm', JSON.stringify(d[0]));
d = await dest(await mensaje('ana', 'dmAB', '', { archivo: { nombre: 'foto.png', tipo: 'image/png', tamano: 10, ruta: 'x' } }));
prueba('archivo sin texto: cuerpo con el nombre', d[0]?.cuerpo === '📎 foto.png', d[0]?.cuerpo);
d = await dest(await mensaje('ana', 'dmAB', 'x'.repeat(500)));
prueba('texto largo: se corta en 180', d[0]?.cuerpo.length === 180);
prueba('importado de Slack: no avisa', (await dest(await mensaje('ana', 'dmAB', 'viejo de slack', { slack_id: 'D1:1.0' }))).length === 0);
prueba('mensaje de hace 1 hora: no avisa', (await dest(await mensaje('ana', 'dmAB', 'antiguo', { created_at: new Date(Date.now() - 3600e3).toISOString() }))).length === 0);
prueba('mensaje que no existe: lista vacía', (await dest('00000000-0000-0000-0000-000000000000')).length === 0);
const padre = await mensaje('beto', 'dmAB', 'pregunta');
d = await dest(await mensaje('ana', 'dmAB', 'respuesta en hilo', { parent_id: padre }));
prueba('respuesta en hilo de un DM: avisa y trae el hilo', d.length === 2 && d[0]?.hilo === padre);

// --- 3. Conteos del ícono
const avisos = async (k) => Object.fromEntries((await como(k, 'select * from mis_avisos()')).map((r) => [Object.keys(c).find((n) => c[n] === r.channel_id), [r.directos, r.menciones]]));
let a = await avisos('beto');
prueba('beto: 4 directos de primer nivel en su DM con ana (la respuesta en hilo no cuenta)', a.dmAB?.[0] === 4 && a.dmAB?.[1] === 0, JSON.stringify(a));
prueba('beto: menciones en #general = 6', a.general?.[1] === 6 && a.general?.[0] === 0, JSON.stringify(a));
prueba('beto: 1 mención en el canal privado', a.equipo?.[1] === 1, JSON.stringify(a));
prueba('ana no se cuenta sus propios mensajes', igual(await avisos('ana'), { dmAB: [1, 0] }), JSON.stringify(await avisos('ana')));
a = await avisos('dani');
prueba('dani: solo @canal y @todos de #general', igual(a, { general: [0, 2] }), JSON.stringify(a));
const tot = (await como('servidor', `select coalesce(sum(directos + menciones), 0)::int n from public._avisos_de($1)`, [u.beto]))[0].n;
prueba('insignia que viaja en el push = suma de mis_avisos', d[0]?.insignia === tot, `${d[0]?.insignia} vs ${tot}`);
await como('beto', `insert into channel_members (channel_id, user_id, last_read_at) values ($1, $2, now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [c.dmAB, u.beto]);
await como('beto', `insert into channel_members (channel_id, user_id, last_read_at) values ($1, $2, now()) on conflict (channel_id, user_id) do update set last_read_at = now()`, [c.general, u.beto]);
a = await avisos('beto');
prueba('al leer el DM y #general, quedan en cero', !a.dmAB && !a.general && a.equipo?.[1] === 1, JSON.stringify(a));

// --- 4. Reclamo, ajustes y borrado
prueba('reclamar: la primera vez sí', (await como('servidor', 'select public._push_reclamar($1) r', [m]))[0].r === true);
prueba('reclamar: la segunda no', (await como('servidor', 'select public._push_reclamar($1) r', [m]))[0].r === false);
const s1 = (await como('servidor', `select public._push_ajuste('secreto') v`))[0].v;
prueba('hay un secreto de 64 letras', /^[0-9a-f]{64}$/.test(s1 || ''), s1?.length);
prueba('la dirección de la función quedó guardada', /functions\/v1\/notificar$/.test((await como('servidor', `select public._push_ajuste('url') v`))[0].v));
prueba('fijar ajuste: guarda la primera vez', (await como('servidor', `select public._push_fijar_ajuste('vapid', 'uno') v`))[0].v === 'uno');
prueba('fijar ajuste: después no lo cambia', (await como('servidor', `select public._push_fijar_ajuste('vapid', 'dos') v`))[0].v === 'uno');
const pr = (await como('servidor', 'select public._push_prueba($1) d', [u.beto]))[0].d;
prueba('prueba: los 2 dispositivos de beto', pr.length === 2 && pr[0].canal === null && /funcionan/.test(pr[0].cuerpo));
let nb = (await como('servidor', 'select public._push_borrar($1) n', [[E('beto-1'), E('no-existe')]]))[0].n;
prueba('un dispositivo recién registrado no se borra aunque el servicio lo rechace', nb === 0 && (await una(`select count(*)::int n from push_suscripciones where user_id = $1`, [u.beto])).n === 2, nb);
await db.query(`update push_suscripciones set creado = now() - interval '2 hours' where endpoint = $1`, [E('beto-1')]);
nb = (await como('servidor', 'select public._push_borrar($1) n', [[E('beto-1'), E('no-existe')]]))[0].n;
prueba('uno antiguo rechazado sí se borra', nb === 1 && (await una(`select count(*)::int n from push_suscripciones where user_id = $1`, [u.beto])).n === 1, nb);

// --- 5. La base pide el aviso por cada mensaje
await db.exec('delete from net.llamadas');
const m2 = await mensaje('ana', 'dmAB', 'esto dispara el aviso');
let ll = (await db.query('select * from net.llamadas')).rows;
prueba('mensaje nuevo: una llamada a la función con el secreto', ll.length === 1 && ll[0].body.message_id === m2 && ll[0].headers['x-charla-secreto'] === s1 && /notificar$/.test(ll[0].url), JSON.stringify(ll));
await mensaje('ana', 'dmAB', 'importado', { slack_id: 'D1:2.0' });
prueba('importado: no llama', (await db.query('select * from net.llamadas')).rows.length === 1);
const comoBeto = await como('beto', `insert into messages (channel_id, user_id, texto) values ($1, $2, 'escrito por beto con su sesión') returning id`, [c.dmAB, u.beto]);
prueba('una persona con su sesión puede enviar y también dispara', comoBeto.length === 1 && (await db.query('select * from net.llamadas')).rows.length === 2);
await db.exec(`create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000) returns bigint language plpgsql as $$ begin raise exception 'pg_net caído'; end $$;`);
const m3 = await mensaje('ana', 'dmAB', 'aunque falle el aviso, el mensaje se guarda');
prueba('si el aviso falla, el mensaje se guarda igual', !!(await una('select id from messages where id = $1', [m3])));

// --- 6. Se puede correr dos veces y sin pg_net
await db.exec(sql006);
prueba('correr 006 de nuevo no cambia el secreto ni borra dispositivos', (await como('servidor', `select public._push_ajuste('secreto') v`))[0].v === s1 && (await una('select count(*)::int n from push_suscripciones')).n === 4);
const sin = await crearBase({ conNet: false });
const m4 = await sin.mensaje('ana', 'dmAB', 'sin pg_net');
prueba('sin pg_net: la migración corre y los mensajes se guardan', !!(await sin.una('select id from messages where id = $1', [m4])));

console.log(`\nSQL: ${ok} pruebas bien, ${mal} mal`);
process.exit(mal ? 1 : 0);
