-- Charla: los avisos respetan quién está en cada canal.
-- Pegar entero en Supabase → SQL Editor → Run, después de 004 (miembros en los canales
-- públicos) y de 006 (notificaciones). Se puede volver a correr.
--
-- En 006, un @canal (o @todos, @aqui) avisaba a "todos los que pueden ver el canal". Los
-- canales públicos los puede leer todo el equipo, así que le llegaba a todos, estuvieran
-- o no en el canal. Desde 004 cada canal tiene sus miembros: el aviso y el número del
-- ícono cuentan solo para quienes están adentro (igual que en Slack, a quien mencionan
-- en un canal donde no está no le llega nada hasta que lo agregan).
-- Son las mismas dos funciones de 006 con ese único cambio.

-- ---------- Conteos para el número del ícono ----------
-- Por conversación donde la persona está: mensajes directos sin leer y menciones sin leer.
create or replace function public._avisos_de(p_user uuid)
returns table (channel_id uuid, directos int, menciones int)
language sql stable security definer set search_path = public as $$
  with yo as (select id, usuario from profiles where id = p_user),
  mias as (
    select c.id, c.es_dm, cm.last_read_at as desde, yo.usuario
    from channels c
    cross join yo
    join channel_members cm on cm.channel_id = c.id and cm.user_id = yo.id
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
    from mias v
  )
  select channel_id, directos, menciones from conteos where directos > 0 or menciones > 0
$$;

-- ---------- A quién avisar por un mensaje ----------
-- Un elemento por dispositivo. Mensaje directo: la otra persona. Canal: quienes están en
-- el canal y fueron mencionados (@usuario, @canal, @todos, @aqui). Nunca a quien escribió.
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
    and exists (select 1 from channel_members cm where cm.channel_id = c.id and cm.user_id = p.id)
    and (c.es_dm or (position('@' in coalesce(m.texto, '')) > 0 and public._menciona(m.texto, p.usuario)));
  return res;
end $$;

-- Siguen siendo internas: solo las llama el servidor.
revoke execute on function public._avisos_de(uuid) from public, anon, authenticated;
revoke execute on function public._push_destinos(uuid, uuid) from public, anon, authenticated;
grant execute on function public._avisos_de(uuid) to service_role;
grant execute on function public._push_destinos(uuid, uuid) to service_role;
