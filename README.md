# Charla

Chat interno del equipo de Everfresh Media, al estilo de Slack. Es una app web
(se instala como app en Mac, Windows, iPhone y Android) con Supabase como
servidor: base de datos, tiempo real, inicio de sesión con Google y archivos.
Para 5–20 personas entra en el plan gratis de Supabase.

## Qué hace

- **Canales** públicos y **mensajes directos**, en tiempo real.
- **Hilos**, **reacciones**, **menciones** con autocompletado (`@franco`, `@canal`).
- Formato: `*negrita*`, `_cursiva_`, `~tachado~`, `` `código` ``, bloques con ```` ``` ````, links.
- **Archivos e imágenes** (arrastrar, pegar o 📎), hasta 25 MB, privados del equipo.
- **No leídos** por canal, **avisos de escritorio** en DMs y menciones, "**está escribiendo…**", quién está **en línea**.
- **Editar** (también con ↑ en el cuadro vacío) y **borrar** mensajes propios.
- **Buscar** en todo (`⌘K`).
- **✦ Resumir con Claude**: resumen de las últimas 24 h del canal (decisiones, pendientes, preguntas abiertas).
- **Webhook entrante**: GitHub Actions, GHL o cualquier script puede publicar en un canal (para reemplazar `#alertas-crm` de Slack).
- Solo entran cuentas de Google del dominio de la empresa, y eso lo valida la base de datos, no la app.

## Probar sin servidor (modo demo)

```bash
node scripts/servir.mjs
```

Abrir http://localhost:5180. Con `supabaseUrl` vacío en `web/config.js`, la app
corre en modo demo: todo queda en el navegador. Abre dos pestañas y entra como
dos personas distintas para ver el tiempo real.

## Ponerla en producción (unos 30 minutos, una vez)

1. **Supabase**: crear una cuenta en supabase.com y un proyecto (plan Free, región
   São Paulo o us-east). Copiar `Project URL` y `anon public key` desde
   Settings → API.
2. **Base de datos**: SQL Editor → pegar `supabase/esquema.sql` → Run. Si el
   dominio no es solo `everfreshmedia.com`, agregar los otros a
   `dominios_permitidos` (y en `web/config.js`).
3. **Google**: en Google Cloud Console (puede ser el mismo proyecto de Toma) crear
   un ID de cliente OAuth de tipo *Aplicación web*, con la URI de redirección
   `https://<proyecto>.supabase.co/auth/v1/callback`. Pegar el Client ID y el
   secreto en Supabase → Authentication → Providers → Google.
4. **Config**: poner `supabaseUrl` y `supabaseAnonKey` en `web/config.js`. La anon
   key es pública por diseño; la seguridad está en las políticas RLS.
5. **Publicar la carpeta `web/`** en un hosting estático gratis (Cloudflare Pages,
   Netlify o GitHub Pages). Agregar esa URL en Supabase → Authentication → URL
   Configuration (Site URL y Redirect URLs).
6. **Resumen con Claude** (opcional): con la CLI de Supabase,
   ```bash
   supabase secrets set Api-key-charla=sk-ant-...
   supabase functions deploy resumir
   ```
   Usar una key propia de Charla con límite de gasto. Vive en Supabase, nunca en la app.

Cada persona abre la URL, entra con Google y, en Chrome, *Instalar Charla* (o en
iPhone, Compartir → *Agregar a inicio*) para tenerla como app con avisos.

## Webhook entrante

Crear un webhook para un canal (SQL Editor):

```sql
insert into webhooks (channel_id, nombre)
select id, 'CRM' from channels where nombre = 'alertas-crm'
returning token;
```

Publicar desde cualquier lado:

```bash
curl -X POST "$SUPABASE_URL/rest/v1/rpc/publicar" -H "apikey: $SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"p_token":"<token>","p_texto":"⚠️ 3 oportunidades sin mover"}'
```

Con archivos (por ejemplo, PDFs), usar la función `webhook`:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/webhook" -H "Authorization: Bearer $SUPABASE_ANON_KEY" -H "Content-Type: application/json" -d '{"token":"<token>","texto":"...","adjuntos":[{"nombre":"a.pdf","tipo":"application/pdf","base64":"...","titulo":"..."}]}'
```

Publica el texto y después un mensaje por archivo.

## Archivos

```
web/                    la app (HTML/CSS/JS sin dependencias ni compilación)
  backend-supabase.js   conexión real
  backend-demo.js       modo demo (localStorage + BroadcastChannel)
supabase/esquema.sql    tablas, permisos (RLS), tiempo real, archivos, webhook
supabase/functions/resumir   resumen con Claude
scripts/servir.mjs      servidor local para probar
```

## Límites del plan gratis de Supabase (verificar al crear el proyecto)

500 MB de base de datos (millones de mensajes de texto), 1 GB de archivos y 200
conexiones simultáneas. El proyecto se pausa si pasa una semana sin uso, lo que
no pasa con un chat diario. Si los archivos crecen, el plan Pro cuesta USD 25 al
mes para todo el equipo e incluye respaldos diarios.
