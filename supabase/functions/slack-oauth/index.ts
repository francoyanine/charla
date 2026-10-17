// Función "slack-oauth": la vuelta del "Conectar con Slack".
//
// Slack redirige acá con ?code&state. El state une la vuelta con la persona de
// Charla que lo pidió (tabla slack_estados, la crea slack_iniciar()). Se cambia
// el code por un token de usuario de Slack, se guarda en slack_tokens (solo lo
// leen las funciones) y se vuelve a Charla con #slack=ok.
//
// Esta función se publica con "Verify JWT" apagado: Slack no manda la sesión.
// Secreto requerido: SLACK_CLIENT_SECRET (Edge Functions → Secrets).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CLIENT_ID = Deno.env.get('SLACK_CLIENT_ID') ?? '8632422247190.12334762159477';
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const REDIRECT = `${SB_URL}/functions/v1/slack-oauth`;
const CHARLA = 'https://francoyanine.github.io/charla/';

const volver = (resultado: string) =>
  new Response(null, { status: 302, headers: { Location: `${CHARLA}#slack=${encodeURIComponent(resultado)}` } });

Deno.serve(async (req) => {
  const u = new URL(req.url);
  if (u.searchParams.get('error')) return volver('cancelado');
  const code = u.searchParams.get('code');
  const estado = u.searchParams.get('state');
  if (!code || !estado) return volver('error');

  const admin = createClient(SB_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: e } = await admin.from('slack_estados').select('user_id, creado').eq('estado', estado).maybeSingle();
  await admin.from('slack_estados').delete().eq('estado', estado);
  if (!e || Date.now() - new Date(e.creado).getTime() > 3600_000) return volver('vencido');

  const secreto = Deno.env.get('SLACK_CLIENT_SECRET');
  if (!secreto) return volver('sin-secreto');
  const r = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: secreto, code, redirect_uri: REDIRECT }),
  });
  const j = await r.json();
  const token = j.authed_user?.access_token;
  if (!j.ok || !token) return volver(`error-${j.error ?? 'sin-token'}`);

  await admin.from('slack_tokens').upsert({ user_id: e.user_id, token, slack_user_id: j.authed_user.id, creado: new Date().toISOString() });
  return volver('ok');
});
