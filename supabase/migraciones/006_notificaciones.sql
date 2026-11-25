-- Charla: notificaciones (número en el ícono, avisos push al teléfono y al navegador).
-- Pegar entero en Supabase → SQL Editor → Run. Se puede correr más de una vez.
-- No depende de 004 ni de 005. Va junto con la función "notificar" (Verify JWT apagado).
--
-- Quién recibe un aviso por un mensaje nuevo (nunca quien lo escribió):
--   • mensaje directo: la otra persona del chat;
--   • canal: quien fue mencionado con @usuario, y todos los que ven el canal si dice
--     @canal, @todos o @aqui.
-- El número del ícono cuenta lo mismo: mensajes directos sin leer + menciones sin leer.

-- ---------- Dispositivos suscritos ----------
create table if not exists public.push_suscripciones (
  endpoint text primary key,                 -- dirección que entrega el navegador o el teléfono
  user_id uuid not null references public.profiles (id) on delete cascade,
  p256dh text not null,
  auth text not null,
  dispositivo text not null default '',
  creado timestamptz not null default now(),
  visto timestamptz not null default now()
);
create index if not exists push_suscripciones_user on public.push_suscripciones (user_id);
alter table public.push_suscripciones enable row level security;
drop policy if exists "ver mis dispositivos" on public.push_suscripciones;
create policy "ver mis dispositivos" on public.push_suscripciones for select to authenticated using (user_id = auth.uid());
drop policy if exists "quitar mis dispositivos" on public.push_suscripciones;
create policy "quitar mis dispositivos" on public.push_suscripciones for delete to authenticated using (user_id = auth.uid());

-- Alta o renovación del dispositivo de quien llama. Si otra persona entra en el mismo
-- navegador, el dispositivo pasa a ser suyo (por eso es una función y no una política).
create or replace function public.guardar_suscripcion(p_endpoint text, p_p256dh text, p_auth text, p_dispositivo text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.es_del_equipo() then raise exception 'Sin permiso'; end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 20 and 200 or coalesce(length(p_auth), 0) not between 8 and 100 then
    raise exception 'Suscripción no válida';
  end if;
  insert into push_suscripciones (endpoint, user_id, p256dh, auth, dispositivo)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(coalesce(p_dispositivo, ''), 200))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        dispositivo = excluded.dispositivo, visto = now();
end $$;

create or replace function public.quitar_suscripcion(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_suscripciones where endpoint = p_endpoint and user_id = auth.uid()
$$;

revoke execute on function public.guardar_suscripcion(text, text, text, text) from public, anon;
revoke execute on function public.quitar_suscripcion(text) from public, anon;
grant execute on function public.guardar_suscripcion(text, text, text, text) to authenticated;
grant execute on function public.quitar_suscripcion(text) to authenticated;

-- ---------- Ajustes privados y registro de envíos (solo los usa la función "notificar") ----------
create table if not exists public.push_ajustes (clave text primary key, valor text not null);
alter table public.push_ajustes enable row level security;   -- sin políticas: nadie la lee desde la app

create table if not exists public.push_enviados (
  message_id uuid primary key,
  creado timestamptz not null default now()
);
alter table public.push_enviados enable row level security;  -- sin políticas

-- Secreto con que la base de datos llama a la función, y dónde está la función.
insert into public.push_ajustes (clave, valor)
values ('secreto', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
on conflict (clave) do nothing;
insert into public.push_ajustes (clave, valor)
values ('url', 'https://swcvialsunqnwyuwkydy.supabase.co/functions/v1/notificar')
on conflict (clave) do nothing;

-- ---------- Menciones ----------
-- ¿El texto menciona a esta persona (@usuario) o a todo el canal (@canal, @todos, @aqui)?
-- Misma regla que la app (meMenciona en web/app.js).
create or replace function public._menciona(p_texto text, p_usuario text) returns boolean
language sql immutable as $$
  select coalesce(p_texto, '') ~* ('(^|[\s(])@(' || regexp_replace(p_usuario, '([^a-zA-Z0-9_])', '\\\1', 'g') || '|canal|todos|aqui)($|[^a-zA-Z0-9_])')
$$;

-- ---------- Conteos para el número del ícono ----------
-- Por conversación que la persona puede ver: mensajes directos sin leer y menciones sin leer.
create or replace function public._avisos_de(p_user uuid)
returns table (channel_id uuid, directos int, menciones int)
language sql stable security definer set search_path = public as $$
  with yo as (select id, usuario, created_at from profiles where id = p_user),
  visibles as (
    select c.id, c.es_dm, coalesce(cm.last_read_at, yo.created_at) as desde, yo.usuario
    from channels c
    cross join yo
    left join channel_members cm on cm.channel_id = c.id and cm.user_id = yo.id
    where (not c.es_dm and not c.es_privado) or cm.user_id is not null
  ),
  conteos as (
    select v.id as channel_id,
      case when v.es_dm then (
        select count(*) from messages m
        where m.channel_id = v.id and m.parent_id is null and m.created_at > v.desde and m.user_id is distinct from p_user
      ) else 0 end::int as directos,
      case when v.es_dm then 0 else (
        select count(*) from messages m
        where m.channel_id = v.id and m.created_at > v.desde and m.user_id is distinct from p_user
          and position('@' in m.texto) > 0 and public._menciona(m.texto, v.usuario)
      ) end::int as menciones
    from visibles v
  )
  select channel_id, directos, menciones from conteos where directos > 0 or menciones > 0
$$;

-- Lo mismo para quien llama: la app lo pide al abrir.
create or replace function public.mis_avisos()
returns table (channel_id uuid, directos int, menciones int)
language sql stable security definer set search_path = public as $$
  select * from public._avisos_de(auth.uid())
$$;

-- ---------- A quién avisar por un mensaje ----------
-- Devuelve un elemento por dispositivo: a dónde mandar y qué mostrar. Lista vacía si el
-- mensaje no existe, es importado de Slack, tiene más de 10 minutos o (si se indica) no es
-- de p_autor.
create or replace function public._push_destinos(p_mensaje uuid, p_autor uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m messages; c channels; quien text; titulo text; cuerpo text; res jsonb;
begin
  select * into m from messages where id = p_mensaje;
  if not found or m.slack_id is not null or m.created_at < now() - interval '10 minutes' then return '[]'::jsonb; end if;
  if p_autor is not null and m.user_id is distinct from p_autor then return '[]'::jsonb; end if;
  select * into c from channels where id = m.channel_id;
  quien := coalesce(m.bot_nombre, (select nombre from profiles where id = m.user_id), 'Alguien');
  cuerpo := case
    when btrim(coalesce(m.texto, '')) <> '' then left(m.texto, 180)
    when m.archivo is not null then '📎 ' || coalesce(m.archivo ->> 'nombre', 'Archivo')
    else 'Mensaje nuevo' end;
  titulo := case when c.es_dm then quien else quien || ' en #' || c.nombre end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
      'titulo', titulo, 'cuerpo', cuerpo, 'canal', m.channel_id, 'id', m.id,
      'hilo', m.parent_id,
      'insignia', (select coalesce(sum(a.directos + a.menciones), 0) from public._avisos_de(p.id) a))), '[]'::jsonb)
    into res
  from profiles p
  join push_suscripciones s on s.user_id = p.id
  where p.id is distinct from m.user_id
    and (
      (c.es_dm and exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = p.id))
      or (not c.es_dm
          and (not c.es_privado or exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = p.id))
          and position('@' in coalesce(m.texto, '')) > 0 and public._menciona(m.texto, p.usuario))
    );
  return res;
end $$;

-- Marca el mensaje como avisado. Devuelve true solo la primera vez: así, aunque la app y
-- la base de datos pidan el aviso a la vez, sale una sola notificación.
create or replace function public._push_reclamar(p_mensaje uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  delete from push_enviados where creado < now() - interval '7 days';
  insert into push_enviados (message_id) values (p_mensaje) on conflict do nothing;
  return found;
end $$;

-- Dispositivos de una persona con un aviso de prueba ("Probar notificación" en la app).
create or replace function public._push_prueba(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
      'titulo', 'Charla', 'cuerpo', 'Las notificaciones funcionan en este dispositivo.',
      'canal', null, 'id', 'prueba-' || s.user_id::text, 'hilo', null,
      'insignia', (select coalesce(sum(a.directos + a.menciones), 0) from public._avisos_de(p_user) a))), '[]'::jsonb)
  from push_suscripciones s where s.user_id = p_user
$$;

-- Dispositivos que ya no existen (el servicio de avisos respondió 404 o 410). No se borra
-- uno registrado hace menos de una hora: recién creado, el servicio puede no conocerlo aún
-- y responder lo mismo. Devuelve cuántos borró.
drop function if exists public._push_borrar(text[]);
create function public._push_borrar(p_endpoints text[])
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from push_suscripciones where endpoint = any (p_endpoints) and creado < now() - interval '1 hour';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public._push_ajuste(p_clave text)
returns text language sql stable security definer set search_path = public as $$
  select valor from push_ajustes where clave = p_clave
$$;

-- Guarda el ajuste solo si no existía y devuelve el que quedó (para crear las llaves una vez).
create or replace function public._push_fijar_ajuste(p_clave text, p_valor text)
returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  insert into push_ajustes (clave, valor) values (p_clave, p_valor) on conflict (clave) do nothing;
  select valor into v from push_ajustes where clave = p_clave;
  return v;
end $$;

-- Las funciones internas solo las puede llamar el servidor (service role).
revoke execute on function public._avisos_de(uuid) from public, anon, authenticated;
revoke execute on function public._push_destinos(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._push_reclamar(uuid) from public, anon, authenticated;
revoke execute on function public._push_prueba(uuid) from public, anon, authenticated;
revoke execute on function public._push_borrar(text[]) from public, anon, authenticated;
revoke execute on function public._push_ajuste(text) from public, anon, authenticated;
revoke execute on function public._push_fijar_ajuste(text, text) from public, anon, authenticated;
grant execute on function public._avisos_de(uuid) to service_role;
grant execute on function public._push_destinos(uuid, uuid) to service_role;
grant execute on function public._push_reclamar(uuid) to service_role;
grant execute on function public._push_prueba(uuid) to service_role;
grant execute on function public._push_borrar(text[]) to service_role;
grant execute on function public._push_ajuste(text) to service_role;
grant execute on function public._push_fijar_ajuste(text, text) to service_role;
revoke execute on function public.mis_avisos() from public, anon;
grant execute on function public.mis_avisos() to authenticated;

-- ---------- La base de datos pide el aviso por cada mensaje nuevo ----------
-- Así también avisan los mensajes de bots y los de quien cierra la app justo después de
-- enviar. La app pide el aviso por su lado: el que llegue primero gana (_push_reclamar).
do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'No se pudo activar pg_net (%): los avisos saldrán solo desde la app.', sqlerrm;
end $$;

create or replace function public.avisar_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text; u text;
begin
  if new.slack_id is not null or new.created_at < now() - interval '10 minutes' then return new; end if;
  select valor into s from push_ajustes where clave = 'secreto';
  select valor into u from push_ajustes where clave = 'url';
  if s is null or u is null then return new; end if;
  perform net.http_post(
    url := u,
    body := jsonb_build_object('message_id', new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-charla-secreto', s));
  return new;
exception when others then
  return new;   -- un problema con el aviso nunca impide que el mensaje se guarde
end $$;

drop trigger if exists al_insertar_mensaje_push on public.messages;
create trigger al_insertar_mensaje_push after insert on public.messages
for each row execute function public.avisar_push();
