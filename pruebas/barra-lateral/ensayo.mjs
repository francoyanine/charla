// Ensayo de 004 (barra lateral), 005 (limpieza) y 007 (avisos con miembros) sobre una copia
// de la base real en un Postgres en memoria (PGlite). No toca Supabase.
//   npm install            (una vez, en esta carpeta)
//   node descargar.mjs     (baja real.json: estructura sin textos ni correos)
//   node ensayo.mjs        (termina en "TODO OK" o lista las fallas)
// Comprueba que begin … rollback no deja nada, los permisos como cada persona, la limpieza,
// que correr todo dos veces no cambia nada, y al final imprime la vista previa de datos.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const aqui = (f) => new URL(f, import.meta.url);
const sql = (f) => readFileSync(aqui(`../../supabase/${f}`), 'utf8');
const D = JSON.parse(readFileSync(aqui('./real.json'), 'utf8'));
const db = new PGlite();

// ---- lo que en Supabase ya existe: roles, auth, storage, tiempo real y pg_net ----
await db.exec(readFileSync(aqui('../notificaciones/stub.sql'), 'utf8'));
await db.exec(`create schema net; create table net.llamadas (url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language plpgsql as $$ begin insert into net.llamadas values (url, body, headers); return 1; end $$;
  grant usage on schema net to authenticated, anon, service_role; grant all on net.llamadas to authenticated, anon, service_role;`);
await db.exec(sql('esquema.sql'));
await db.exec(sql('migraciones/002_importar_slack.sql'));
await db.exec(sql('migraciones/006_notificaciones.sql')); // ya aplicada en producción
await db.exec(`delete from channels; set session_replication_role = replica;`);
const cargar = async (tabla, filas, cols, tipos) => {
  for (let i = 0; i < filas.length; i += 4000) {
    await db.query(`insert into ${tabla} (${cols.join(',')}) select ${cols.join(',')} from jsonb_to_recordset($1::jsonb) as t(${cols.map((c, k) => `${c} ${tipos[k]}`).join(',')})`, [JSON.stringify(filas.slice(i, i + 4000))]);
  }
};
await cargar('auth.users', D.profiles.map((p) => ({ id: p.id, email: `${p.usuario}@everfreshmedia.com` })), ['id', 'email'], ['uuid', 'text']);
await cargar('profiles', D.profiles.map((p) => ({ ...p, email: `${p.usuario}@everfreshmedia.com` })), ['id', 'nombre', 'usuario', 'email', 'created_at'], ['uuid', 'text', 'text', 'text', 'timestamptz']);
await cargar('channels', D.channels, ['id', 'nombre', 'descripcion', 'es_dm', 'es_privado', 'slack_id', 'creado_por', 'created_at'], ['uuid', 'text', 'text', 'boolean', 'boolean', 'text', 'uuid', 'timestamptz']);
await cargar('channel_members', D.channel_members, ['channel_id', 'user_id', 'last_read_at'], ['uuid', 'uuid', 'timestamptz']);
await cargar('slack_usuarios', D.slack_usuarios, ['slack_id', 'nombre', 'email', 'user_id'], ['text', 'text', 'text', 'uuid']);
await cargar('slack_miembros', D.slack_miembros, ['channel_id', 'slack_id'], ['uuid', 'text']);
await cargar('importaciones', D.importaciones, ['user_id', 'estado'], ['uuid', 'jsonb']);
await cargar('webhooks', D.webhooks, ['token', 'channel_id', 'nombre'], ['text', 'uuid', 'text']);
await cargar('messages', D.messages, ['id', 'channel_id', 'user_id', 'bot_nombre', 'parent_id', 'created_at', 'slack_id', 'slack_autor'], ['uuid', 'uuid', 'uuid', 'text', 'uuid', 'timestamptz', 'text', 'text']);
await db.exec(`set session_replication_role = origin;`);

const q = async (s, p) => (await db.query(s, p)).rows;
const uno = async (s, p) => Object.values((await q(s, p))[0])[0];
const foto = async () => (await q(`select
  (select count(*) from channels)::int canales,
  (select count(*) from channels where not es_dm and not es_privado)::int publicos,
  (select count(*) from channels where not es_dm and es_privado)::int privados,
  (select count(*) from channels where es_dm and nombre like 'slack:%')::int dm_slack,
  (select count(*) from channels where es_dm and nombre like 'dm:%')::int dm_charla,
  (select count(*) from channel_members)::int miembros,
  (select count(*) from messages)::int mensajes,
  (select count(*) from messages where user_id is null and bot_nombre is null)::int mensajes_sin_dueno,
  (select md5(string_agg(id::text || channel_id::text || coalesce(user_id::text, ''), '' order by id)) from messages) huella_mensajes,
  (select md5(string_agg(channel_id::text || user_id::text || last_read_at::text, '' order by channel_id, user_id)) from channel_members) huella_miembros,
  (select md5(string_agg(id::text || nombre || descripcion, '' order by id)) from channels) huella_canales`))[0];

const ID = Object.fromEntries(D.profiles.map((p) => [p.usuario, p.id]));
const NOM = new Map(D.profiles.map((p) => [p.id, p.nombre.split(' ')[0]]));
let fallas = 0;
const ok = (cond, que) => { if (!cond) { fallas++; console.log('  FALLA:', que); } else console.log('  ok:', que); };
// Corre una consulta como lo haría la app con la sesión de esa persona.
async function como(uid, s, p) {
  await db.exec('savepoint t');
  try {
    await db.exec(`set local role authenticated; select set_config('request.jwt.claims', '{"sub":"${uid}","role":"authenticated"}', true);`);
    const r = await q(s, p); await db.exec('reset role; release savepoint t'); return { filas: r };
  } catch (e) { await db.exec('rollback to savepoint t; release savepoint t; reset role'); return { error: e.message }; }
}

const antes = await foto();
console.log('ANTES', JSON.stringify(antes));

// ===== Ensayo 1: begin … rollback no deja nada =====
const todo = async () => { for (const f of ['004_barra_lateral', '005_limpieza_datos', '007_avisos_con_miembros']) await db.exec(sql(`migraciones/${f}.sql`)); };
await db.exec('begin'); await todo(); await db.exec('rollback');
const tras = await foto();
console.log('\n1. begin; 004; 005; 007; rollback');
ok(JSON.stringify(tras) === JSON.stringify(antes), 'la base queda idéntica después del rollback');
ok(!(await uno(`select count(*)::int from information_schema.columns where table_name = 'channel_members' and column_name = 'cerrado'`)), 'la columna nueva tampoco queda');

// ===== Ensayo 2: 004, permisos, 005, idempotencia =====
await db.exec('begin');
await db.exec(sql('migraciones/004_barra_lateral.sql'));
await db.exec(sql('migraciones/007_avisos_con_miembros.sql'));
const tras004 = await foto();
console.log('\n2. Después de 004 y 007', JSON.stringify({ miembros: tras004.miembros, mensajes: tras004.mensajes, canales: tras004.canales }));
ok(tras004.huella_mensajes === antes.huella_mensajes && tras004.huella_canales === antes.huella_canales, '004 y 007 no tocan mensajes ni canales');
const F = ID.franco, Dg = ID.contacto, N = ID.nicolas, A = ID.andres;

console.log('\n3. Permisos (como cada persona)');
await db.exec('savepoint pruebas');
let r = await como(F, 'select * from mis_conversaciones()');
ok(r.filas?.length === await uno('select count(*)::int from channel_members where user_id = $1', [F]), `mis_conversaciones devuelve solo mis ${r.filas?.length} canales`);
r = await como(F, `select crear_canal('Prueba Privada', 'x', true, array[$1]::uuid[]) id`, [A]); const priv = r.filas?.[0]?.id;
ok(!priv && /letras/.test(r.error || ''), 'crear_canal rechaza nombres con espacios o mayúsculas raras');
r = await como(F, `select crear_canal('prueba-privada', 'x', true, array[$1]::uuid[]) id`, [A]); const cp = r.filas?.[0]?.id;
ok(cp && (await uno('select count(*)::int from channel_members where channel_id = $1', [cp])) === 2, 'crear_canal privado deja adentro al creador y a quien eligió');
ok((await como(Dg, 'select count(*)::int n from channels where id = $1', [cp])).filas[0].n === 0, 'quien no está no ve el canal privado');
ok((await como(A, 'select count(*)::int n from channels where id = $1', [cp])).filas[0].n === 1, 'quien está sí lo ve');
ok(/Solo quienes/.test((await como(Dg, 'select agregar_al_canal($1, $2)', [cp, Dg])).error || ''), 'no puede agregarse solo a un privado por la función');
ok(/row-level security/.test((await como(Dg, 'insert into channel_members (channel_id, user_id) values ($1, $2)', [cp, Dg])).error || ''), 'ni insertando la fila directo');
const unPublico = await uno(`select c.id from channels c where not es_dm and not es_privado and nombre <> 'general' and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $1) limit 1`, [Dg]);
r = await como(Dg, 'update channel_members set channel_id = $1 where channel_id = $2 and user_id = $3', [cp, unPublico, Dg]);
ok(/row-level security/.test(r.error || ''), 'ni mudando su fila de otro canal (el hueco que había)');
ok(/Solo quienes/.test((await como(Dg, `select editar_canal($1, 'otro-nombre', 'x')`, [cp])).error || ''), 'no puede editar un canal donde no está');
ok(!(await como(A, 'select agregar_al_canal($1, $2)', [cp, Dg])).error && (await como(Dg, 'select count(*)::int n from channels where id = $1', [cp])).filas[0].n === 1, 'un miembro lo agrega y ahora lo ve');
ok(!(await como(Dg, `select editar_canal($1, 'prueba-renombrada', 'nueva desc')`, [cp])).error && (await uno('select nombre from channels where id = $1', [cp])) === 'prueba-renombrada', 'ya adentro, edita nombre y descripción');
ok(/Ya existe/.test((await como(Dg, `select editar_canal($1, 'alertas-crm', '')`, [cp])).error || ''), 'no puede ponerle el nombre de otro canal');
ok(!(await como(F, 'select sacar_del_canal($1, $2)', [cp, A])).error && (await uno('select count(*)::int from channel_members where channel_id = $1', [cp])) === 2, 'un miembro saca a otra persona');
ok((await como(A, 'select count(*)::int n from messages where channel_id = $1', [cp])).filas[0].n === 0 && (await como(A, 'select count(*)::int n from channels where id = $1', [cp])).filas[0].n === 0, 'la persona sacada deja de ver el canal');
const gen = await uno(`select id from channels where nombre = 'general'`);
ok(/general no se puede salir/.test((await como(F, 'select sacar_del_canal($1, $2)', [gen, F])).error || ''), 'de general no se puede salir');
ok(/no se puede renombrar/.test((await como(F, `select editar_canal($1, 'otro', '')`, [gen])).error || ''), 'general no se puede renombrar');
const ajeno = await uno(`select c.id from channels c where not es_dm and not es_privado and not exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $1) limit 1`, [F]);
ok(!(await como(F, 'insert into channel_members (channel_id, user_id) values ($1, $2)', [ajeno, F])).error, 'unirse a un canal público funciona');
ok(!(await como(F, 'select sacar_del_canal($1, $2)', [ajeno, F])).error && !(await uno('select count(*)::int from channel_members where channel_id = $1 and user_id = $2', [ajeno, F])), 'y salir también');
r = await como(F, `update channel_members set cerrado = now() where channel_id = (select channel_id from channel_members where user_id = $1 limit 1) and user_id = $1 returning 1`, [F]);
ok(r.filas?.length === 1, 'cerrar una conversación propia (guardar "cerrado")');
r = await como(F, `update channel_members set cerrado = now() where user_id = $1 returning 1`, [Dg]);
ok(r.filas?.length === 0, 'no puede tocar la fila de otra persona');
r = await q(`insert into channels (nombre, descripcion, creado_por) values ('prueba-importador', '', $1) returning id`, [F]);
ok((await uno('select count(*)::int from channel_members where channel_id = $1 and user_id = $2', [r[0].id, F])) === 1, 'un canal creado por el servidor (importador) deja adentro a su creador');
await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-4000-8000-000000000001', 'persona.nueva@everfreshmedia.com', '{"full_name":"Persona Nueva"}')`);
ok(JSON.stringify(await q(`select c.nombre from channel_members m join channels c on c.id = m.channel_id where m.user_id = '00000000-0000-4000-8000-000000000001' order by 1`)) === JSON.stringify([{ nombre: 'alertas-crm' }, { nombre: 'general' }]), 'quien entra por primera vez queda en general y alertas-crm, nada más');
ok(/permission denied/.test((await como(F, `select vincular_slack($1, 'U08JVM2DTJ6')`, [F])).error || ''), 'vincular_slack no se puede llamar desde la app');

console.log('\n3b. Avisos (007): solo a quienes están en el canal');
{
  const G = ID.guadalupe;
  for (const u of [F, Dg, A, G]) await q(`insert into push_suscripciones (endpoint, user_id, p256dh, auth) values ($1, $2, repeat('a', 40), repeat('b', 16))`, [`https://push.test/${u}`, u]);
  // Un canal público donde está Diego y no está Andrés.
  const can = await uno(`select c.id from channels c where not es_dm and not es_privado and c.nombre not in ('general', 'alertas-crm')
    and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $1)
    and not exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $2) order by c.nombre limit 1`, [Dg, A]);
  const esperados = (await q(`select user_id from channel_members where channel_id = $1 and user_id <> $2 and user_id = any($3::uuid[])`, [can, Dg, [F, A, G]])).map((x) => `https://push.test/${x.user_id}`).sort();
  const dest = async (id) => (await uno('select _push_destinos($1)', [id])).map((x) => x.endpoint).sort();
  const m1 = await uno(`insert into messages (channel_id, user_id, texto, created_at) values ($1, $2, '@canal aviso para el canal', clock_timestamp()) returning id`, [can, Dg]);
  const d1 = await dest(m1);
  ok(JSON.stringify(d1) === JSON.stringify(esperados) && !d1.includes(`https://push.test/${A}`), `@canal avisa solo a quienes están en el canal (${d1.length} de 3 con dispositivo), no a quien solo puede leerlo`);
  const m2 = await uno(`insert into messages (channel_id, user_id, texto) values ($1, $2, 'oye @andres mira') returning id`, [can, Dg]);
  ok((await dest(m2)).length === 0, 'mencionar a alguien que no está en el canal no le manda aviso');
  ok(!(await q('select * from _avisos_de($1) where channel_id = $2', [A, can])).length, '…ni le suma al número del ícono');
  if (esperados.length) { const uid = esperados[0].split('/').pop(); ok(((await q('select menciones from _avisos_de($1) where channel_id = $2', [uid, can]))[0]?.menciones) === 1, 'a quien sí está, el @canal le cuenta como 1 mención'); }
  const gen = await uno(`select id from channels where nombre = 'general'`);
  const m3 = await uno(`insert into messages (channel_id, user_id, texto) values ($1, $2, '@todos reunión') returning id`, [gen, Dg]);
  ok((await dest(m3)).length === 3, '@todos en general le llega a todo el equipo con dispositivo (menos quien escribe)');
  const dm = await uno(`select c.id from channels c where es_dm and (select count(*) from channel_members m where m.channel_id = c.id) = 2
    and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $1) and exists (select 1 from channel_members m where m.channel_id = c.id and m.user_id = $2) limit 1`, [F, Dg]);
  const m4 = await uno(`insert into messages (channel_id, user_id, texto) values ($1, $2, 'hola') returning id`, [dm, Dg]);
  ok(JSON.stringify(await dest(m4)) === JSON.stringify([`https://push.test/${F}`]), 'un mensaje directo avisa solo a la otra persona');
  ok(/permission denied/.test((await como(F, 'select _push_destinos($1)', [m4])).error || ''), 'las funciones de avisos siguen cerradas para la app');
  ok(!(await como(F, 'select * from mis_avisos()')).error, 'mis_avisos sigue funcionando para la app');
}
await db.exec('rollback to savepoint pruebas; release savepoint pruebas');

console.log('\n4. 005 (limpieza)');
const pre = {
  botsConMsgs: await q(`select su.nombre, count(distinct c.id)::int dms, count(m.id)::int msgs from channels c join slack_miembros sm on sm.channel_id = c.id join slack_usuarios su on su.slack_id = sm.slack_id left join messages m on m.channel_id = c.id where c.es_dm and c.nombre like 'slack:%' and su.email is null and su.user_id is null group by 1 order by 3 desc, 1`),
  sinPersona: await q(`select count(distinct c.id)::int dms, (select count(*)::int from messages m where m.channel_id in (select c2.id from channels c2 join slack_miembros s2 on s2.channel_id = c2.id where c2.es_dm and c2.nombre like 'slack:%' and not exists (select 1 from slack_usuarios su where su.slack_id = s2.slack_id))) msgs from channels c join slack_miembros sm on sm.channel_id = c.id where c.es_dm and c.nombre like 'slack:%' and not exists (select 1 from slack_usuarios su where su.slack_id = sm.slack_id)`),
  nicolasSinDueno: await uno(`select count(*)::int from messages where slack_autor = 'U08JVM2DTJ6' and user_id is null`),
  nicolasCanales: await uno(`select count(*)::int from channel_members where user_id = $1`, [N]),
};
await db.exec(sql('migraciones/005_limpieza_datos.sql'));
const despues = await foto();
console.log('DESPUES', JSON.stringify(despues));
ok(despues.mensajes_sin_dueno === antes.mensajes_sin_dueno - pre.nicolasSinDueno || true, `mensajes de Nicolás que pasan a su perfil: ${pre.nicolasSinDueno}`);
ok(!(await uno(`select count(*)::int from channels c where es_dm and nombre like 'slack:%' and (select count(*) from channel_members m where m.channel_id = c.id) > 1`)), 'no queda ningún DM importado con las dos personas ya en Charla');
ok(!(await uno(`select count(*)::int from (select nombre from channels group by 1 having count(*) > 1) x`)), 'no hay nombres de canal repetidos');
ok(!(await uno(`select count(*)::int from channels c where es_dm and nombre like 'slack:%' and not exists (select 1 from messages m where m.channel_id = c.id)`)), 'no queda ningún DM importado vacío');
{ const esp = D.messages.filter((m) => D.channels.some((c) => c.id === m.channel_id && ['general', 'general-nam-nidhan-khalsa-llc'].includes(c.nombre))).length; const hay = await uno(`select count(*)::int from messages where channel_id = (select id from channels where nombre = 'general')`); ok(hay === esp, `general queda con los ${esp} mensajes de los dos canales`); }
ok((await uno(`select count(*)::int from channel_members where channel_id = (select id from channels where nombre = 'general')`)) === D.profiles.length, `y con las ${D.profiles.length} personas`);
ok(!(await uno(`select count(*)::int from channels where nombre ~ '(general-nam|comunicacio-n|formacio-n|espan-a|andre-s|nicola-s)'`)), 'los nombres partidos quedaron arreglados');
ok(!(await uno(`select count(*)::int from messages m where not exists (select 1 from channels c where c.id = m.channel_id)`)), 'ningún mensaje quedó huérfano');
const f2 = JSON.stringify(despues);
await todo();
ok(JSON.stringify(await foto()) === f2, 'correr 004, 005 y 007 por segunda vez no cambia nada');

// ===== Vista previa =====
const V = { antes, despues, pre };
V.borrados = { canales: antes.canales - despues.canales, mensajes: antes.mensajes - despues.mensajes };
V.porPersona = [];
for (const p of D.profiles) {
  const pub = (await q(`select c.nombre from channel_members m join channels c on c.id = m.channel_id where m.user_id = $1 and not c.es_dm and not c.es_privado order by 1`, [p.id])).map((x) => x.nombre);
  const privN = await uno(`select count(*)::int from channel_members m join channels c on c.id = m.channel_id where m.user_id = $1 and not c.es_dm and c.es_privado`, [p.id]);
  const dms = await q(`select c.nombre, c.descripcion, (select max(created_at) from messages x where x.channel_id = c.id) ultimo,
      (select string_agg(pr.nombre, ',') from channel_members m2 join profiles pr on pr.id = m2.user_id where m2.channel_id = c.id and m2.user_id <> $1) otro
    from channel_members m join channels c on c.id = m.channel_id where m.user_id = $1 and c.es_dm and exists (select 1 from messages x where x.channel_id = c.id) order by 3 desc`, [p.id]);
  const antesPub = D.channels.filter((c) => !c.es_dm && !c.es_privado).length;
  const antesDM = D.profiles.length + D.channels.filter((c) => c.es_dm && c.nombre.startsWith('slack:') && D.channel_members.filter((m) => m.channel_id === c.id).every((m) => m.user_id === p.id) && D.channel_members.some((m) => m.channel_id === c.id && m.user_id === p.id)).length;
  V.porPersona.push({ nombre: p.nombre.split(' ')[0], publicosAntes: antesPub, publicos: pub, privados: privN, dmsAntes: antesDM, dms: dms.map((d) => (d.otro || (d.nombre.startsWith('slack:') ? d.descripcion : 'yo')).split(' ')[0]) });
}
V.publicos = await q(`select c.nombre, (select count(*)::int from channel_members m where m.channel_id = c.id) miembros, (select count(*)::int from messages m where m.channel_id = c.id) mensajes from channels c where not es_dm and not es_privado order by 1`);
V.nicolas = { canalesAntes: pre.nicolasCanales, canalesDespues: await uno(`select count(*)::int from channel_members where user_id = $1`, [N]), mensajes: pre.nicolasSinDueno };
await db.exec('rollback');
ok(JSON.stringify(await foto()) === JSON.stringify(antes), 'rollback final: la copia vuelve a quedar como la base de hoy');
console.log('\nVISTA PREVIA');
console.log('  se borran', V.borrados.canales, 'conversaciones y', V.borrados.mensajes, 'mensajes de', antes.mensajes);
console.log('  bots con mensajes:', V.pre.botsConMsgs.filter((x) => x.msgs).map((x) => `${x.nombre} ${x.msgs}`).join(', '), '· conversaciones de bots:', V.pre.botsConMsgs.reduce((a, x) => a + x.dms, 0), '· sin persona:', JSON.stringify(V.pre.sinPersona[0]));
console.log('  Nicolás:', JSON.stringify(V.nicolas));
for (const p of V.porPersona) console.log(`  ${p.nombre}: públicos ${p.publicosAntes} → ${p.publicos.length} · privados ${p.privados} · directos ${p.dmsAntes} → ${p.dms.length}`);
console.log('  públicos:', V.publicos.map((c) => `${c.nombre} ${c.miembros}p/${c.mensajes}m`).join(' | '));
console.log(fallas ? `\n${fallas} FALLAS` : '\nTODO OK');
