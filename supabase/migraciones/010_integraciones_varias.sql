-- Charla: más de una integración puede mandar tareas.
--
-- La 009 solo aceptaba al portal ('portal-nnk'). Ahora vale cualquier fila de
-- `integraciones`: el nombre pasa a ser una etiqueta, para saber quién es y
-- poder darla de baja sola (delete from integraciones where nombre = '…').
--
-- Suma la integración 'secretaria-nnk': la rutina que lee las reuniones de
-- Google Meet y le carga a cada persona lo que se comprometió, a nombre de
-- Franco. Su clave vive en el .env.local del proyecto del portal.
--
-- Se puede correr más de una vez.

create or replace function public.tarea_portal(p_clave text, p_de text, p_para text, p_texto text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_de uuid; v_para uuid; v_de_email text; v_para_email text; v_ok boolean;
  a uuid; b uuid; nom text; cid uuid; mid uuid;
begin
  if p_clave is null or not exists (
    select 1 from public.integraciones i
     where i.clave_sha256 = encode(sha256(convert_to(p_clave, 'UTF8')), 'hex')
  ) then
    raise exception 'clave';
  end if;
  if coalesce(trim(p_texto), '') = '' then raise exception 'texto'; end if;

  -- Solo entre personas que ya entraron alguna vez a Charla (tienen perfil).
  select p.id, p.email into v_de, v_de_email from public.profiles p where lower(p.email) = lower(trim(p_de)) limit 1;
  if v_de is null then raise exception 'sin-perfil-de'; end if;
  select p.id, p.email into v_para, v_para_email from public.profiles p where lower(p.email) = lower(trim(p_para)) limit 1;
  if v_para is null or v_para = v_de then raise exception 'sin-perfil-para'; end if;
  -- Donde ya existe la lista de accesos (003_accesos.sql), además tienen que seguir habilitadas.
  if to_regprocedure('public.acceso_por_email(text,text)') is not null then
    execute 'select public.acceso_por_email($1, $3) and public.acceso_por_email($2, $3)'
      into v_ok using v_de_email, v_para_email, 'charla'::text;
    if not coalesce(v_ok, false) then raise exception 'sin-perfil-para'; end if;
  end if;

  -- Mismo canal de mensaje directo que abre la app (ver abrir_dm).
  a := least(v_de, v_para); b := greatest(v_de, v_para);
  nom := 'dm:' || a || ':' || b;
  select c.id into cid from public.channels c where c.nombre = nom and c.es_dm;
  if cid is null then
    insert into public.channels (nombre, es_dm, creado_por) values (nom, true, v_de) returning id into cid;
  end if;
  insert into public.channel_members (channel_id, user_id) values (cid, a), (cid, b) on conflict do nothing;
  -- Si alguno había cerrado la conversación en la barra lateral, vuelve a aparecer.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'channel_members' and column_name = 'cerrado') then
    execute 'update public.channel_members set cerrado = null where channel_id = $1 and cerrado is not null' using cid;
  end if;

  insert into public.messages (channel_id, user_id, texto)
  values (cid, v_de, left(p_texto, 8000)) returning id into mid;
  return mid;
end $$;

revoke execute on function public.tarea_portal(text, text, text, text) from public;
grant execute on function public.tarea_portal(text, text, text, text) to anon;

insert into public.integraciones (nombre, clave_sha256) values ('secretaria-nnk', 'bf7aec6b75e08ff3d18c52c57a76d557520c84b5d01549a812db364a898c42df')
on conflict (nombre) do update set clave_sha256 = excluded.clave_sha256;
