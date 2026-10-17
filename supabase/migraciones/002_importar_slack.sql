-- Charla: importar desde Slack.
-- Pegar entero en Supabase → SQL Editor → Run, una vez, después de esquema.sql.
--
-- Cada persona conecta su Slack (token de usuario) y una función trae lo que
-- ella ve: canales públicos y privados, mensajes directos y grupales, hilos,
-- reacciones y archivos. Los mensajes se identifican por su id de Slack, así
-- que importar dos veces el mismo canal no duplica nada.

-- ---------- Canales privados ----------
alter table public.channels add column es_privado boolean not null default false;
alter table public.channels add column slack_id text unique;

-- Un canal privado o un DM solo lo ven sus miembros.
create or replace function public.puede_ver(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.es_del_equipo() and exists (
    select 1 from channels ch
    where ch.id = c
      and ((not ch.es_dm and not ch.es_privado)
           or exists (select 1 from channel_members m where m.channel_id = c and m.user_id = auth.uid()))
  )
$$;

-- ---------- Personas de Slack ----------
create table public.slack_usuarios (
  slack_id text primary key,
  nombre text not null,
  email text,
  avatar_url text,
  user_id uuid references public.profiles (id) on delete set null
);
alter table public.slack_usuarios enable row level security;
create policy "equipo ve personas de slack" on public.slack_usuarios for select to authenticated using (public.es_del_equipo());

-- Miembros de Slack de los canales privados y DMs importados, para sumar a
-- cada persona cuando entre a Charla.
create table public.slack_miembros (
  channel_id uuid not null references public.channels (id) on delete cascade,
  slack_id text not null,
  primary key (channel_id, slack_id)
);
alter table public.slack_miembros enable row level security;

-- ---------- Mensajes importados ----------
alter table public.messages add column slack_id text unique;   -- '<canal slack>:<ts>'
alter table public.messages add column slack_autor text;       -- quien lo escribió en Slack
alter table public.messages drop constraint messages_texto_check;
alter table public.messages add constraint messages_texto_check check (length(texto) <= 40000);

-- ---------- Conexión con Slack (solo la usan las funciones) ----------
create table public.slack_tokens (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  token text not null,
  slack_user_id text not null,
  creado timestamptz not null default now()
);
alter table public.slack_tokens enable row level security;

create table public.slack_estados (
  estado text primary key default replace(gen_random_uuid()::text, '-', ''),
  user_id uuid not null references public.profiles (id) on delete cascade,
  creado timestamptz not null default now()
);
alter table public.slack_estados enable row level security;

create table public.importaciones (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  estado jsonb not null default '{}',
  actualizado timestamptz not null default now()
);
alter table public.importaciones enable row level security;
create policy "ver mi importacion" on public.importaciones for select to authenticated using (user_id = auth.uid());

-- La app pide un "estado" para el OAuth de Slack (une la vuelta de Slack con quien lo pidió).
create function public.slack_iniciar() returns text
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if not public.es_del_equipo() then raise exception 'Sin permiso'; end if;
  delete from slack_estados where creado < now() - interval '1 hour';
  insert into slack_estados (user_id) values (auth.uid()) returning estado into e;
  return e;
end $$;

create function public.slack_conectado() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from slack_tokens where user_id = auth.uid())
$$;

revoke execute on function public.slack_iniciar() from public, anon;
revoke execute on function public.slack_conectado() from public, anon;
grant execute on function public.slack_iniciar() to authenticated;
grant execute on function public.slack_conectado() to authenticated;

-- ---------- Unir una persona de Slack con su cuenta de Charla ----------
-- Le pasa sus mensajes, la suma a sus canales privados y DMs, y si el DM
-- importado no tenía su contraparte en Charla, lo convierte en DM normal.
create function public.vincular_slack(p_user uuid, p_slack text) returns void
language plpgsql security definer set search_path = public as $$
declare r record; otro uuid; nom text;
begin
  update slack_usuarios set user_id = p_user where slack_id = p_slack;
  update messages set user_id = p_user where slack_autor = p_slack and user_id is null and bot_nombre is null;
  insert into channel_members (channel_id, user_id)
    select channel_id, p_user from slack_miembros where slack_id = p_slack
    on conflict do nothing;
  for r in select c.id from channels c join slack_miembros sm on sm.channel_id = c.id
           where sm.slack_id = p_slack and c.es_dm and c.nombre like 'slack:%' loop
    select user_id into otro from channel_members where channel_id = r.id and user_id <> p_user limit 1;
    if otro is not null then
      nom := 'dm:' || least(p_user, otro) || ':' || greatest(p_user, otro);
      if not exists (select 1 from channels where nombre = nom) then
        update channels set nombre = nom where id = r.id;
      end if;
    end if;
  end loop;
end $$;
revoke execute on function public.vincular_slack(uuid, text) from public, anon, authenticated;

-- Cuando alguien entra por primera vez, se busca su persona de Slack por correo
-- y, si no, por nombre exacto.
create function public.vincular_slack_al_entrar() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select slack_id into s from slack_usuarios
   where user_id is null and (lower(email) = lower(new.email) or lower(nombre) = lower(new.nombre))
   order by (lower(email) = lower(new.email)) desc nulls last limit 1;
  if s is not null then perform public.vincular_slack(new.id, s); end if;
  return new;
end $$;
create trigger al_crear_perfil_slack after insert on public.profiles
for each row execute function public.vincular_slack_al_entrar();

alter publication supabase_realtime add table public.slack_usuarios;
