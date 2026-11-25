-- Charla: barra lateral como la de Slack.
-- Pegar entero en Supabase → SQL Editor → Run, después de esquema.sql y 002.
-- Para ensayarlo sin dejar nada escrito: pegarlo entre "begin;" y "rollback;".
--
-- Qué cambia:
--   · Los canales públicos pasan a tener miembros de verdad: cada persona ve en
--     su barra solo los canales donde está. Los públicos siguen siendo legibles
--     por todo el equipo (para "Explorar canales" y la vista previa).
--   · Cada persona puede cerrar una conversación directa (columna "cerrado").
--   · Crear canales privados, editar nombre y descripción, agregar y sacar
--     personas: todo por funciones, con las reglas en un solo lugar.
--   · Una sola consulta (mis_conversaciones) trae último mensaje y no leídos.
--
-- Va junto con 005 (limpieza de datos) y con 007: como los avisos de 006 le llegaban a
-- "todos los que ven el canal", 007 los limita a quienes están adentro.
--
-- Se puede volver a correr. La migración de miembros (paso 1) corre una sola
-- vez: la segunda vez se saltea, así no le quita a nadie un canal al que se unió.

-- ---------- 1. Miembros de los canales públicos (una sola vez) ----------
-- Hasta hoy, una fila de channel_members en un canal público solo decía "lo
-- abrió alguna vez". Desde ahora dice "está en el canal".
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_members' and column_name = 'cerrado') then
    raise notice 'Los miembros ya se migraron: se saltea el paso 1.';
    return;
  end if;

  -- Fuera de general y alertas-crm, nadie queda en un canal público solo por haberlo abierto.
  delete from public.channel_members cm using public.channels c
   where c.id = cm.channel_id and not c.es_dm and not c.es_privado
     and c.nombre not in ('general', 'alertas-crm');

  -- Cada persona queda en los canales públicos que traía su importación de Slack.
  insert into public.channel_members (channel_id, user_id)
    select distinct c.id, i.user_id
      from public.importaciones i
      cross join lateral jsonb_array_elements(coalesce(i.estado -> 'cola', '[]'::jsonb)) e
      join public.channels c on c.id::text = e ->> 'charla'
     where e ->> 'tipo' = 'canal' and not c.es_dm and not c.es_privado
  on conflict do nothing;

  -- general y alertas-crm: todo el equipo.
  insert into public.channel_members (channel_id, user_id)
    select c.id, p.id from public.channels c cross join public.profiles p
     where c.nombre in ('general', 'alertas-crm') and not c.es_dm and not c.es_privado
  on conflict do nothing;
end $$;

-- ---------- 2. Cerrar conversaciones ----------
-- Fecha del último mensaje que había cuando la persona cerró el DM. La app lo
-- vuelve a mostrar cuando llega un mensaje más nuevo.
alter table public.channel_members add column if not exists cerrado timestamptz;

-- ---------- 3. Permisos ----------
create or replace function public.es_miembro(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from channel_members m where m.channel_id = c and m.user_id = auth.uid())
$$;

-- Antes alcanzaba con ser dueño de la fila: cualquiera podía "mudar" su fila a
-- un canal privado y entrar. Ahora la fila nueva tiene que ser de un canal que ve.
drop policy if exists "marcar leído" on public.channel_members;
create policy "marcar leído" on public.channel_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and public.puede_ver(channel_id));
-- Unirse a un canal público sigue siendo la política "marcar leído (alta)": la
-- fila es propia y el canal se ve (un privado no se ve sin ser miembro).

-- ---------- 4. Administrar canales ----------
create or replace function public._nombre_canal(p text) returns text
language plpgsql immutable as $$
declare n text := lower(btrim(coalesce(p, '')));
begin
  if n !~ '^[a-z0-9][a-z0-9_-]{0,69}$' then
    raise exception 'El nombre del canal solo puede llevar letras, números y guiones.';
  end if;
  return n;
end $$;

create or replace function public.crear_canal(p_nombre text, p_descripcion text default '', p_privado boolean default false, p_miembros uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; n text := public._nombre_canal(p_nombre);
begin
  if not public.es_del_equipo() then raise exception 'Sin permiso'; end if;
  if exists (select 1 from channels where nombre = n) then raise exception 'Ya existe un canal llamado %', n; end if;
  insert into channels (nombre, descripcion, es_privado, creado_por)
  values (n, left(coalesce(p_descripcion, ''), 250), coalesce(p_privado, false), auth.uid()) returning id into cid;
  insert into channel_members (channel_id, user_id)
    select cid, auth.uid()
    union
    select cid, p.id from profiles p where p.id = any (coalesce(p_miembros, '{}'))
  on conflict do nothing;
  return cid;
end $$;

-- Nombre y descripción: cualquiera que esté en el canal.
create or replace function public.editar_canal(p_canal uuid, p_nombre text, p_descripcion text)
returns void language plpgsql security definer set search_path = public as $$
declare c channels; n text;
begin
  select * into c from channels where id = p_canal;
  if not found or c.es_dm or not public.es_miembro(p_canal) then
    raise exception 'Solo quienes están en el canal pueden editarlo.';
  end if;
  n := lower(btrim(coalesce(p_nombre, '')));
  if n <> c.nombre then
    n := public._nombre_canal(p_nombre);
    if c.nombre = 'general' then raise exception 'El canal general no se puede renombrar.'; end if;
    if exists (select 1 from channels where nombre = n) then raise exception 'Ya existe un canal llamado %', n; end if;
  end if;
  update channels set nombre = n, descripcion = left(coalesce(p_descripcion, ''), 250) where id = p_canal;
end $$;

-- A un canal público agrega cualquiera del equipo; a uno privado, quien ya está.
create or replace function public.agregar_al_canal(p_canal uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c channels;
begin
  select * into c from channels where id = p_canal;
  if not public.es_del_equipo() or not found or c.es_dm or (c.es_privado and not public.es_miembro(p_canal)) then
    raise exception 'Solo quienes están en el canal pueden agregar gente.';
  end if;
  if not exists (select 1 from profiles where id = p_user) then raise exception 'Esa persona todavía no entra a Charla.'; end if;
  insert into channel_members (channel_id, user_id) values (p_canal, p_user) on conflict do nothing;
end $$;

-- Salir (uno mismo) o sacar a otra persona: quien está en el canal.
create or replace function public.sacar_del_canal(p_canal uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c channels;
begin
  select * into c from channels where id = p_canal;
  if not found or c.es_dm or not public.es_miembro(p_canal) then
    raise exception 'Solo quienes están en el canal pueden sacar gente.';
  end if;
  if c.nombre = 'general' then raise exception 'De general no se puede salir: es el canal de todo el equipo.'; end if;
  delete from channel_members where channel_id = p_canal and user_id = p_user;
end $$;

-- Quien crea un canal queda adentro (también si lo crea una versión vieja de la
-- app, que inserta la fila directo).
create or replace function public.creador_es_miembro() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not new.es_dm and new.creado_por is not null then
    insert into channel_members (channel_id, user_id) values (new.id, new.creado_por) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists al_crear_canal on public.channels;
create trigger al_crear_canal after insert on public.channels
for each row execute function public.creador_es_miembro();

-- Quien entra por primera vez a Charla queda en general y alertas-crm.
create or replace function public.canales_iniciales() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into channel_members (channel_id, user_id)
    select c.id, new.id from channels c
     where c.nombre in ('general', 'alertas-crm') and not c.es_dm and not c.es_privado
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists al_crear_perfil_canales on public.profiles;
create trigger al_crear_perfil_canales after insert on public.profiles
for each row execute function public.canales_iniciales();

-- ---------- 5. Barra lateral en una consulta ----------
-- De cada canal o conversación donde estoy: último mensaje, cuántos no leí y
-- hasta cuándo la cerré.
create or replace function public.mis_conversaciones()
returns table (channel_id uuid, ultimo timestamptz, no_leidos integer, cerrado timestamptz)
language sql stable security definer set search_path = public as $$
  select cm.channel_id,
         (select max(m.created_at) from messages m where m.channel_id = cm.channel_id),
         (select count(*)::integer from messages m
           where m.channel_id = cm.channel_id and m.parent_id is null
             and m.created_at > cm.last_read_at and m.user_id is distinct from cm.user_id),
         cm.cerrado
    from channel_members cm
   where cm.user_id = auth.uid()
$$;

-- ---------- 6. Mensajes directos importados de Slack ----------
-- Un DM importado se llama 'slack:<id>' mientras la otra persona no entra a
-- Charla. Cuando las dos ya tienen cuenta pasa a ser el DM normal de ambas. Si
-- ese DM ya existía (alguien lo abrió antes de vincular), se unen en uno solo:
-- antes quedaban dos conversaciones con la misma persona.
create or replace function public.fusionar_dm_slack(p_canal uuid) returns void
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; nom text; otro uuid;
begin
  if not exists (select 1 from channels where id = p_canal and es_dm and nombre like 'slack:%') then return; end if;
  if not exists (select 1 from slack_miembros where channel_id = p_canal)
     or exists (select 1 from slack_miembros sm left join slack_usuarios su on su.slack_id = sm.slack_id
                 where sm.channel_id = p_canal and su.user_id is null) then
    return;  -- falta que alguien entre a Charla
  end if;
  select array_agg(distinct su.user_id) into ids
    from slack_miembros sm join slack_usuarios su on su.slack_id = sm.slack_id
   where sm.channel_id = p_canal;
  if array_length(ids, 1) not in (1, 2) then return; end if;
  nom := 'dm:' || least(ids[1], ids[array_length(ids, 1)]) || ':' || greatest(ids[1], ids[array_length(ids, 1)]);

  insert into channel_members (channel_id, user_id) select p_canal, unnest(ids) on conflict do nothing;
  select id into otro from channels where nombre = nom and id <> p_canal;
  if otro is not null then
    update messages set channel_id = p_canal where channel_id = otro;
    insert into channel_members (channel_id, user_id, last_read_at)
      select p_canal, user_id, last_read_at from channel_members where channel_id = otro
    on conflict (channel_id, user_id) do update
      set last_read_at = greatest(channel_members.last_read_at, excluded.last_read_at);
    delete from channels where id = otro;
  end if;
  update channels set nombre = nom, descripcion = '' where id = p_canal;
end $$;

-- Igual que en 002, pero los DM se unen con fusionar_dm_slack.
create or replace function public.vincular_slack(p_user uuid, p_slack text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update slack_usuarios set user_id = p_user where slack_id = p_slack;
  update messages set user_id = p_user where slack_autor = p_slack and user_id is null and bot_nombre is null;
  insert into channel_members (channel_id, user_id)
    select channel_id, p_user from slack_miembros where slack_id = p_slack
    on conflict do nothing;
  for r in select c.id from channels c join slack_miembros sm on sm.channel_id = c.id
           where sm.slack_id = p_slack and c.es_dm and c.nombre like 'slack:%' loop
    perform public.fusionar_dm_slack(r.id);
  end loop;
end $$;

-- ---------- 7. Quién puede llamar a qué ----------
revoke execute on function public.es_miembro(uuid) from public, anon;
revoke execute on function public.crear_canal(text, text, boolean, uuid[]) from public, anon;
revoke execute on function public.editar_canal(uuid, text, text) from public, anon;
revoke execute on function public.agregar_al_canal(uuid, uuid) from public, anon;
revoke execute on function public.sacar_del_canal(uuid, uuid) from public, anon;
revoke execute on function public.mis_conversaciones() from public, anon;
grant execute on function public.es_miembro(uuid) to authenticated;
grant execute on function public.crear_canal(text, text, boolean, uuid[]) to authenticated;
grant execute on function public.editar_canal(uuid, text, text) to authenticated;
grant execute on function public.agregar_al_canal(uuid, uuid) to authenticated;
grant execute on function public.sacar_del_canal(uuid, uuid) to authenticated;
grant execute on function public.mis_conversaciones() to authenticated;
-- Solo las usan otras funciones, los disparadores y el importador.
revoke execute on function public.fusionar_dm_slack(uuid) from public, anon, authenticated;
revoke execute on function public.vincular_slack(uuid, text) from public, anon, authenticated;
revoke execute on function public.creador_es_miembro() from public, anon, authenticated;
revoke execute on function public.canales_iniciales() from public, anon, authenticated;

-- ---------- 8. Tiempo real ----------
-- Para que la barra se entere al instante cuando alguien entra o sale de un canal.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'channel_members') then
    alter publication supabase_realtime add table public.channel_members;
  end if;
end $$;
