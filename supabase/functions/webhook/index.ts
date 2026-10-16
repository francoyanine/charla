// Función "webhook": publica en un canal de Charla desde afuera (GitHub Actions,
// scripts), con archivos adjuntos. El token del webhook decide el canal y el
// nombre del bot (tabla webhooks).
//
// POST {SUPABASE_URL}/functions/v1/webhook
//   headers: Authorization: Bearer <anon key>, Content-Type: application/json
//   body: { token, texto, adjuntos?: [{ nombre, tipo, base64, titulo? }] }
//
// Publica el texto y después un mensaje por adjunto (Charla lleva un archivo
// por mensaje). Los archivos van al bucket privado "archivos".
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const LIMITE = 25 * 1024 * 1024;
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Usa POST' }, 405);
  try {
    const { token, texto = '', adjuntos = [] } = await req.json();
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: w } = await sb.from('webhooks').select('channel_id, nombre').eq('token', String(token ?? '')).maybeSingle();
    if (!w) return json({ error: 'Token inválido' }, 401);

    const ids: string[] = [];
    const insertar = async (fila: Record<string, unknown>) => {
      const { data, error } = await sb.from('messages')
        .insert({ channel_id: w.channel_id, bot_nombre: w.nombre, ...fila }).select('id').single();
      if (error) throw new Error(error.message);
      ids.push(data.id);
    };

    if (String(texto).trim()) await insertar({ texto: String(texto).slice(0, 8000) });

    for (const a of adjuntos) {
      const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
      if (bytes.length > LIMITE) throw new Error(`${a.nombre} pesa más de 25 MB`);
      const limpio = String(a.nombre).normalize('NFD').replace(/[^\w.-]+/g, '_');
      const ruta = `${w.channel_id}/${crypto.randomUUID()}-${limpio}`;
      const tipo = a.tipo || 'application/octet-stream';
      const { error } = await sb.storage.from('archivos').upload(ruta, bytes, { contentType: tipo });
      if (error) throw new Error(`No se pudo subir ${a.nombre}: ${error.message}`);
      await insertar({ texto: a.titulo ?? '', archivo: { nombre: a.nombre, tipo, tamano: bytes.length, ruta } });
    }

    return json({ ok: true, mensajes: ids.length });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
