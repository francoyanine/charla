// Supabase de mentira para probar en local: atiende /rest/v1/rpc/* sobre PGlite (con el
// esquema real + 006), /auth/v1/user y reenvía /functions/v1/notificar a la función en Deno.
// Las "sesiones" son fichas tok-<persona>; "servicio" es la service role.
import http from 'node:http';
import { crearBase } from './base.mjs';

const PUERTO = 54399;
const FUNCION = 'http://localhost:8000';
const base = await crearBase();
const { db, u, c, como } = base;
const TABLA = new Set(['mis_avisos', '_avisos_de']);
let fila = Promise.resolve();
const enFila = (f) => { const r = fila.then(f, f); fila = r.catch(() => {}); return r; };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

function quienEs(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (t === 'servicio') return 'servidor';
  if (t.startsWith('tok-') && u[t.slice(4)]) return t.slice(4);
  return 'anon';
}
function leer(req) {
  return new Promise((ok) => { let s = ''; req.on('data', (x) => { s += x; }); req.on('end', () => ok(s)); });
}

http.createServer(async (req, res) => {
  const fin = (codigo, cuerpo) => { res.writeHead(codigo, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(cuerpo)); };
  try {
    if (req.method === 'OPTIONS') return fin(200, {});
    const url = new URL(req.url, 'http://x');
    const texto = await leer(req);
    const cuerpo = texto ? JSON.parse(texto) : {};
    if (!url.pathname.startsWith('/_prueba/estado')) console.log(new Date().toISOString().slice(11, 23), req.method, url.pathname, quienEs(req), texto.slice(0, 150));
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpc) {
      const nombre = rpc[1];
      const ks = Object.keys(cuerpo);
      const args = ks.map((k, i) => `${k} := $${i + 1}`).join(', ');
      const vals = ks.map((k) => cuerpo[k]);
      try {
        const q = TABLA.has(nombre) ? `select * from public.${nombre}(${args})` : `select public.${nombre}(${args}) as r`;
        const filas = await enFila(() => como(quienEs(req), q, vals));
        return fin(200, TABLA.has(nombre) ? filas : filas[0].r);
      } catch (e) {
        return fin(400, { message: e.message, code: 'P0001' });
      }
    }
    if (url.pathname === '/auth/v1/user') {
      const q = quienEs(req);
      if (q in u) return fin(200, { id: u[q], aud: 'authenticated', role: 'authenticated', email: `${q}@everfreshmedia.com` });
      return fin(401, { message: 'invalid JWT' });
    }
    if (url.pathname === '/functions/v1/notificar') {
      const cab = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) cab.Authorization = req.headers.authorization;
      const r = await fetch(FUNCION, { method: req.method, headers: cab, body: req.method === 'POST' ? texto : undefined });
      res.writeHead(r.status, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(await r.text());
    }
    // --- control de la prueba
    if (url.pathname === '/_prueba/estado') {
      return fin(200, {
        u, c,
        llamadas: (await enFila(() => db.query('select * from net.llamadas'))).rows,
        suscripciones: (await enFila(() => db.query('select endpoint, user_id, dispositivo from push_suscripciones'))).rows,
        secreto: (await enFila(() => db.query("select valor from push_ajustes where clave = 'secreto'"))).rows[0].valor,
        vapid: (await enFila(() => db.query("select count(*)::int n from push_ajustes where clave = 'vapid'"))).rows[0].n,
      });
    }
    if (url.pathname === '/_prueba/mensaje') return fin(200, { id: await enFila(() => base.mensaje(cuerpo.autor, cuerpo.canal, cuerpo.texto, cuerpo.extra || {})) });
    if (url.pathname === '/_prueba/sql') return fin(200, (await enFila(() => db.query(cuerpo.q, cuerpo.p || []))).rows);
    return fin(404, { message: 'no existe' });
  } catch (e) {
    return fin(500, { message: String(e.message || e) });
  }
}).listen(PUERTO, () => console.log('stub listo', PUERTO));
