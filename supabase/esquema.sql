-- Charla: esquema completo para Supabase.
-- Pegar entero en Supabase → SQL Editor → Run. Se puede correr una sola vez.
-- Toda la seguridad vive aquí (RLS): la app solo lleva la anon key, que es pública.

-- ---------- Quién puede entrar ----------
create table public.dominios_permitidos (dominio text primary key);
insert into public.dominios_permitidos values ('everfreshmedia.com');

-- ---------- Tablas ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  nombre text not null,
  usuario text not null unique,
  email text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,          -- los DM se llaman 'dm:<uuid>:<uuid>'
  descripcion text not null default '',
  es_dm boolean not null default false,
  creado_por uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.channel_members (
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  bot_nombre text,                      -- mensajes que llegan por webhook
  parent_id uuid references public.messages (id) on delete cascade,
  texto text not null default '' check (length(texto) <= 8000),
  archivo jsonb,
  editado boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_canal_fecha on public.messages (channel_id, created_at desc);
create index messages_padre on public.messages (parent_id);

create table public.reactions (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  emoji text not null check (length(emoji) <= 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table public.webhooks (
  token text primary key default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  channel_id uuid not null references public.channels (id) on delete cascade,
  nombre text not null,
  created_at timestamptz not null default now()
);

-- ---------- Alta de usuarios: solo dominios permitidos ----------
create function public.nuevo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  dom text := lower(split_part(new.email, '@', 2));
  base text := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9._-]', '', 'g');
  handle text := base;
  n int := 1;
begin
  if not exists (select 1 from dominios_permitidos where dominio = dom) then
    raise exception 'Dominio no permitido: %', dom;
  end if;
  while exists (select 1 from profiles where usuario = handle) loop
    n := n + 1; handle := base || n;
  end loop;
  insert into profiles (id, nombre, usuario, email, avatar_url)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', base),
          handle, new.email, new.raw_user_meta_data ->> 'avatar_url');
  return new;
end $$;

create trigger al_crear_usuario after insert on auth.users
for each row execute function public.nuevo_usuario();

-- ---------- Funciones de permiso ----------
create function public.es_del_equipo() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid())
$$;

create function public.puede_ver(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.es_del_equipo() and exists (
    select 1 from channels ch
    where ch.id = c
      and (not ch.es_dm or exists (select 1 from channel_members m where m.channel_id = c and m.user_id = auth.uid()))
  )
$$;

-- ---------- RLS ----------
alter table public.dominios_permitidos enable row level security;
alter table public.profiles enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.reactions enable row level security;
alter table public.webhooks enable row level security;   -- sin políticas: solo desde el SQL Editor

create policy "equipo ve perfiles" on public.profiles for select to authenticated using (public.es_del_equipo());
create policy "cada uno edita su perfil" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "ver canales" on public.channels for select to authenticated using (public.puede_ver(id));
create policy "crear canales" on public.channels for insert to authenticated
  with check (public.es_del_equipo() and not es_dm and creado_por = auth.uid());
create policy "editar canal propio" on public.channels for update to authenticated
  using (creado_por = auth.uid()) with check (creado_por = auth.uid() and not es_dm);

create policy "ver miembros" on public.channel_members for select to authenticated using (public.puede_ver(channel_id));
create policy "marcar leído (alta)" on public.channel_members for insert to authenticated
  with check (user_id = auth.uid() and public.puede_ver(channel_id));
create policy "marcar leído" on public.channel_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "ver mensajes" on public.messages for select to authenticated using (public.puede_ver(channel_id));
create policy "escribir" on public.messages for insert to authenticated
  with check (user_id = auth.uid() and bot_nombre is null and public.puede_ver(channel_id));
create policy "editar propios" on public.messages for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and bot_nombre is null and public.puede_ver(channel_id));
create policy "borrar propios" on public.messages for delete to authenticated using (user_id = auth.uid());

create policy "ver reacciones" on public.reactions for select to authenticated
  using (exists (select 1 from messages m where m.id = message_id and public.puede_ver(m.channel_id)));
create policy "reaccionar" on public.reactions for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from messages m where m.id = message_id and public.puede_ver(m.channel_id)));
create policy "quitar reacción" on public.reactions for delete to authenticated using (user_id = auth.uid());

-- ---------- Mensajes directos ----------
create function public.abrir_dm(otro uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  a uuid := least(auth.uid(), otro);
  b uuid := greatest(auth.uid(), otro);
  nom text := 'dm:' || a || ':' || b;
  cid uuid;
begin
  if not public.es_del_equipo() or not exists (select 1 from profiles where id = otro) then
    raise exception 'Usuario no válido';
  end if;
  select id into cid from channels where nombre = nom;
  if cid is null then
    insert into channels (nombre, es_dm, creado_por) values (nom, true, auth.uid()) returning id into cid;
    insert into channel_members (channel_id, user_id) values (cid, a), (cid, b) on conflict do nothing;
  end if;
  return cid;
end $$;
revoke execute on function public.abrir_dm(uuid) from public, anon;
grant execute on function public.abrir_dm(uuid) to authenticated;

-- ---------- Webhook entrante (alertas del CRM, GitHub Actions, etc.) ----------
-- POST {SUPABASE_URL}/rest/v1/rpc/publicar  con  {"p_token": "...", "p_texto": "..."}
create function public.publicar(p_token text, p_texto text) returns uuid
language plpgsql security definer set search_path = public as $$
declare w webhooks; mid uuid;
begin
  select * into w from webhooks where token = p_token;
  if not found then raise exception 'Token inválido'; end if;
  insert into messages (channel_id, bot_nombre, texto)
  values (w.channel_id, w.nombre, left(p_texto, 8000)) returning id into mid;
  return mid;
end $$;
revoke execute on function public.publicar(text, text) from public;
grant execute on function public.publicar(text, text) to anon, authenticated;

-- ---------- Tiempo real ----------
alter table public.messages replica identity full;
alter table public.reactions replica identity full;
alter publication supabase_realtime add table public.messages, public.reactions, public.channels, public.profiles;

-- ---------- Archivos (privados, solo el equipo) ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('archivos', 'archivos', false, 26214400) on conflict (id) do nothing;
create policy "equipo lee archivos" on storage.objects for select to authenticated
  using (bucket_id = 'archivos' and public.es_del_equipo());
create policy "equipo sube archivos" on storage.objects for insert to authenticated
  with check (bucket_id = 'archivos' and public.es_del_equipo());

-- ---------- Canales iniciales ----------
insert into public.channels (nombre, descripcion) values
  ('general', 'Anuncios y conversación de todo el equipo'),
  ('random', 'Lo que no es trabajo'),
  ('alertas-crm', 'Avisos automáticos del CRM');
