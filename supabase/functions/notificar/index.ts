// Función "notificar": manda los avisos push de Charla (teléfono y navegador).
//
// Se publica desde el panel de Supabase (Edge Functions → notificar → Code) con
// "Verify JWT" APAGADO: la llama la base de datos (sin sesión) y también la app.
// Necesita la migración supabase/migraciones/006_notificaciones.sql.
//
//   GET                      → { clave }: la llave pública con que la app se suscribe.
//   POST { message_id }      → avisa a quien corresponda por ese mensaje. La puede pedir
//                              la base de datos (cabecera x-charla-secreto) o quien
//                              escribió el mensaje (su sesión). Un mensaje se avisa una
//                              sola vez aunque lo pidan los dos.
//   POST { prueba: true }    → aviso de prueba a los dispositivos de quien llama.
//
// No hay secretos que configurar a mano: las llaves del servicio (VAPID) se crean solas la
// primera vez y quedan en la tabla push_ajustes, que solo lee el servidor.
// El cifrado es el estándar de Web Push (RFC 8291, aes128gcm) con la firma VAPID (RFC 8292).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Quién manda los avisos, para el servicio de push (no es un secreto).
const SUJETO = 'https://francoyanine.github.io/charla/';
// Solo se le habla a servicios de push conocidos (Chrome/Android, Apple, Firefox, Edge).
const SERVICIOS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- utilidades ----------
const te = new TextEncoder();
function b64u(datos: ArrayBuffer | Uint8Array): string {
  const b = datos instanceof Uint8Array ? datos : new Uint8Array(datos);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function deB64u(t: string): Uint8Array {
  const s = atob(t.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(t.length / 4) * 4, '='));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function unir(...partes: Uint8Array[]): Uint8Array {
  const r = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { r.set(p, i); i += p.length; }
  return r;
}
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function rpc(nombre: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(nombre, args);
  if (error) throw new Error(`${nombre}: ${error.message}`);
  return data;
}

// ---------- llaves del servicio (VAPID) ----------
type Llaves = { publica: string; firma: CryptoKey };
let llavesEnMemoria: Llaves | null = null;
async function llaves(): Promise<Llaves> {
  if (llavesEnMemoria) return llavesEnMemoria;
  let guardado = await rpc('_push_ajuste', { p_clave: 'vapid' }) as string | null;
  if (!guardado) {
    const par = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', par.privateKey);
    const publica = b64u(await crypto.subtle.exportKey('raw', par.publicKey));
    // Si dos llamadas llegan a la vez, queda la primera que se guardó.
    guardado = await rpc('_push_fijar_ajuste', { p_clave: 'vapid', p_valor: JSON.stringify({ jwk, publica }) }) as string;
  }
  const { jwk, publica } = JSON.parse(guardado);
  const firma = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  llavesEnMemoria = { publica, firma };
  return llavesEnMemoria;
}

async function autorizacion(endpoint: string, ll: Llaves): Promise<string> {
  const cabecera = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const cuerpo = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUJETO })));
  const firma = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ll.firma, te.encode(`${cabecera}.${cuerpo}`) as BufferSource);
  return `vapid t=${cabecera}.${cuerpo}.${b64u(firma)}, k=${ll.publica}`;
}

// ---------- cifrado del mensaje (RFC 8291) ----------
async function hkdf(sal: Uint8Array, ikm: Uint8Array, info: Uint8Array, largo: number): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal as BufferSource, info: info as BufferSource }, k, largo * 8));
}
async function cifrar(texto: string, p256dh: string, auth: string): Promise<Uint8Array> {
  const delNavegador = deB64u(p256dh);          // llave pública del dispositivo (65 bytes)
  const secretoAuth = deB64u(auth);              // secreto del dispositivo (16 bytes)
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const mia = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const llaveNavegador = await crypto.subtle.importKey('raw', delNavegador as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: llaveNavegador }, par.privateKey, 256));
  const ikm = await hkdf(secretoAuth, compartido, unir(te.encode('WebPush: info\0'), delNavegador, mia), 32);
  const sal = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(sal, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(sal, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const llave = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // El 0x02 final marca que este es el último (y único) registro.
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, llave, unir(te.encode(texto), new Uint8Array([2])) as BufferSource));
  // Encabezado: sal (16) + tamaño de registro (4) + largo de la llave (1) + llave (65).
  return unir(sal, new Uint8Array([0, 0, 16, 0]), new Uint8Array([mia.length]), mia, cifrado);
}

type Destino = { endpoint: string; p256dh: string; auth: string; titulo: string; cuerpo: string; canal: string | null; id: string; hilo: string | null; insignia: number };

// Devuelve el código de respuesta del servicio de push (0 si no se pudo ni intentar).
async function enviar(d: Destino, ll: Llaves): Promise<number> {
  try {
    const url = new URL(d.endpoint);
    if (url.protocol !== 'https:' || !SERVICIOS.some((s) => s.test(url.hostname))) return 0;
    const aviso = JSON.stringify({ titulo: d.titulo, cuerpo: d.cuerpo, canal: d.canal, id: d.id, hilo: d.hilo, insignia: d.insignia });
    const r = await fetch(d.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await autorizacion(d.endpoint, ll),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body: (await cifrar(aviso, d.p256dh, d.auth)) as BodyInit,
    });
    await r.body?.cancel();
    return r.status;
  } catch {
    return 0;
  }
}

async function repartir(destinos: Destino[]) {
  const ll = await llaves();
  const codigos = await Promise.all(destinos.map((d) => enviar(d, ll)));
  // 404 o 410: el servicio dice que ese dispositivo ya no existe. Se da de baja, salvo que
  // sea recién registrado: en sus primeros minutos el servicio puede no conocerlo todavía.
  const rechazados = destinos.filter((_, i) => codigos[i] === 404 || codigos[i] === 410).map((d) => d.endpoint);
  const borrados = rechazados.length ? Number(await rpc('_push_borrar', { p_endpoints: rechazados })) || 0 : 0;
  const enviados = codigos.filter((c) => c >= 200 && c < 300).length;
  return { enviados, vencidos: borrados, fallidos: codigos.length - enviados - borrados, codigos };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    if (req.method === 'GET') return json({ clave: (await llaves()).publica });
    if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
    const { message_id, prueba } = await req.json().catch(() => ({}));

    // ¿Quién llama? La base de datos (con el secreto) o una persona (con su sesión).
    let autor: string | null = null;
    const secreto = req.headers.get('x-charla-secreto');
    if (secreto) {
      const real = await rpc('_push_ajuste', { p_clave: 'secreto' }) as string | null;
      if (!real || !iguales(secreto, real)) return json({ error: 'Sin permiso' }, 401);
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
      const { data: { user } } = await admin.auth.getUser(jwt);
      if (!user) return json({ error: 'Sin sesión' }, 401);
      autor = user.id;
    }

    if (prueba) {
      if (!autor) return json({ error: 'La prueba se pide con una sesión' }, 400);
      const destinos = await rpc('_push_prueba', { p_user: autor }) as Destino[];
      return json({ dispositivos: destinos.length, ...(await repartir(destinos)) });
    }

    if (typeof message_id !== 'string' || !UUID.test(message_id)) return json({ error: 'Falta message_id' }, 400);
    const destinos = await rpc('_push_destinos', { p_mensaje: message_id, p_autor: autor }) as Destino[];
    if (!destinos.length) return json({ enviados: 0 });
    if (!(await rpc('_push_reclamar', { p_mensaje: message_id }))) return json({ enviados: 0, repetido: true });
    return json(await repartir(destinos));
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
