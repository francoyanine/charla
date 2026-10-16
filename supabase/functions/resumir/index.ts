// Función "resumir": Claude lee las últimas 24 h de un canal y devuelve un resumen.
// La API key de Anthropic vive como secreto de Supabase, nunca dentro de la app.
// Se publica desde el panel de Supabase (Edge Functions → resumir → Code) o con la CLI.
// Secreto requerido (Edge Functions → Secrets): Api-key-charla, o ANTHROPIC_API_KEY.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const API_KEY = Deno.env.get('Api-key-charla') ?? Deno.env.get('ANTHROPIC_API_KEY');
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (!API_KEY) throw new Error('Falta configurar la API key de Anthropic en Supabase (Edge Functions → Secrets).');
    const { channel_id, horas = 24 } = await req.json();
    // El cliente usa el token de quien pide: las políticas RLS deciden qué puede leer.
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const desde = new Date(Date.now() - horas * 3600_000).toISOString();
    const { data: msgs, error } = await sb
      .from('messages')
      .select('texto, created_at, bot_nombre, parent_id, autor:profiles!messages_user_id_fkey(nombre)')
      .eq('channel_id', channel_id)
      .gte('created_at', desde)
      .order('created_at')
      .limit(400);
    if (error) throw new Error(error.message);
    if (!msgs?.length) return json({ resumen: `No hubo mensajes en las últimas ${horas} horas.` });

    const hora = (iso: string) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' });
    const transcripcion = msgs
      .map((m: any) => `[${hora(m.created_at)}] ${m.autor?.nombre ?? m.bot_nombre ?? 'Alguien'}${m.parent_id ? ' (en hilo)' : ''}: ${m.texto}`)
      .join('\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 700,
        system:
          'Resumes conversaciones de un canal de trabajo de una agencia de marketing, en español neutro. ' +
          'Entrega como máximo 6 viñetas que empiecen con "- ": decisiones tomadas, pendientes con su responsable y preguntas sin responder. ' +
          'Usa *negrita* solo para nombres de personas. No inventes nada que no esté en los mensajes.',
        messages: [{ role: 'user', content: transcripcion }],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message ?? 'Error de Claude');
    return json({ resumen: j.content.map((c: any) => c.text ?? '').join('').trim() });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
