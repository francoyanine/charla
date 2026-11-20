-- Charla: limpieza de lo que dejó la importación de Slack (noviembre 2026).
-- Pegar entero en Supabase → SQL Editor → Run, DESPUÉS de 004_barra_lateral.sql.
-- Para ensayarlo sin dejar nada escrito: pegarlo entre "begin;" y "rollback;".
-- Borra datos: correr solo con el OK de Franco sobre la vista previa.
-- Se puede volver a correr: la segunda vez no encuentra nada que cambiar.

-- ---------- 1. Nicolás: unir su perfil con su persona de Slack ----------
-- En Slack usa otro correo, por eso no se vinculó solo y aparecía dos veces.
do $$
declare p uuid;
begin
  select id into p from public.profiles where usuario = 'nicolas';
  if p is null then raise exception 'No encuentro el perfil de Nicolás (@nicolas).'; end if;
  if exists (select 1 from public.slack_usuarios where slack_id = 'U08JVM2DTJ6' and user_id is null) then
    perform public.vincular_slack(p, 'U08JVM2DTJ6');
  end if;
end $$;

-- ---------- 2. DMs duplicados: los dos ya están en Charla ----------
-- Conversaciones importadas que quedaron como 'slack:' aunque las dos personas
-- ya tienen cuenta (porque el DM vacío de Charla existía antes): se unen.
do $$
declare r record;
begin
  for r in select id from public.channels where es_dm and nombre like 'slack:%' loop
    perform public.fusionar_dm_slack(r.id);
  end loop;
end $$;

-- ---------- 3. DMs de bots y aplicaciones de Slack ----------
-- Slackbot, Google Calendar, Google Drive, Zapier, etc.: en Slack no tienen
-- correo. Se borran con sus mensajes (avisos automáticos).
delete from public.channels c
 where c.es_dm and c.nombre like 'slack:%'
   and exists (select 1 from public.slack_miembros sm join public.slack_usuarios su on su.slack_id = sm.slack_id
                where sm.channel_id = c.id and su.email is null and su.user_id is null);

-- Conversaciones con alguien que Slack ya no reconoce (cuenta borrada): quedaban
-- como "Mensaje directo", sin nombre.
delete from public.channels c
 where c.es_dm and c.nombre like 'slack:%'
   and exists (select 1 from public.slack_miembros sm
                where sm.channel_id = c.id
                  and not exists (select 1 from public.slack_usuarios su where su.slack_id = sm.slack_id));

-- ---------- 4. DMs importados sin ningún mensaje ----------
delete from public.channels c
 where c.es_dm and c.nombre like 'slack:%'
   and not exists (select 1 from public.messages m where m.channel_id = c.id);

-- ---------- 5. general + general-nam-nidhan-khalsa-llc = general ----------
-- Queda el canal que vino de Slack (tiene casi todo el historial), con el
-- nombre y la descripción de general. Los mensajes del general de Charla pasan a él.
do $$
declare viejo uuid; nuevo uuid; d text;
begin
  select id, descripcion into viejo, d from public.channels where nombre = 'general' and not es_dm;
  select id into nuevo from public.channels where nombre = 'general-nam-nidhan-khalsa-llc' and not es_dm;
  if viejo is null or nuevo is null then raise notice 'general: nada que unir.'; return; end if;
  update public.messages set channel_id = nuevo where channel_id = viejo;
  insert into public.channel_members (channel_id, user_id, last_read_at)
    select nuevo, user_id, last_read_at from public.channel_members where channel_id = viejo
  on conflict (channel_id, user_id) do update
    set last_read_at = greatest(public.channel_members.last_read_at, excluded.last_read_at);
  update public.webhooks set channel_id = nuevo where channel_id = viejo;
  delete from public.channels where id = viejo;
  update public.channels set nombre = 'general', descripcion = d where id = nuevo;
end $$;

-- ---------- 6. Nombres que la importación partió en las tildes ----------
do $$
declare r record;
begin
  for r in select * from (values
      ('comunicacio-n-equipo', 'comunicacion-equipo'),
      ('formacio-n-chile', 'formacion-chile'),
      ('formacio-n-colombia', 'formacion-colombia'),
      ('formacion-espan-a', 'formacion-espana'),
      ('grupo-cristobal-andre-s', 'grupo-cristobal-andres'),
      ('grupo-luisa-nicola-s', 'grupo-luisa-nicolas')) as t (viejo, nuevo) loop
    update public.channels set nombre = r.nuevo
     where nombre = r.viejo and not exists (select 1 from public.channels where nombre = r.nuevo);
  end loop;
end $$;
