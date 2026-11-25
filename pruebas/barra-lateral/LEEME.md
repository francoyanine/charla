# Ensayo de la barra lateral (004, 005 y 007)

Ensaya las migraciones `004_barra_lateral.sql`, `005_limpieza_datos.sql` y
`007_avisos_con_miembros.sql` sobre una copia de la base real en un Postgres en memoria
(PGlite), sin tocar Supabase. Necesita Node.

```bash
npm install          # una vez, en esta carpeta
node descargar.mjs   # baja real.json: estructura sin textos de mensajes ni correos (solo lee)
node ensayo.mjs      # termina en "TODO OK" o lista las fallas
```

`descargar.mjs` usa la variable `CHARLA_SERVICE_KEY` (o la lee del archivo que indique
`CHARLA_ENV`). `real.json` no se guarda en el repositorio.

Qué comprueba `ensayo.mjs`:

- `begin; 004; 005; 007; rollback;` deja la base idéntica.
- Permisos, simulando la sesión de cada persona: canales privados, unirse y salir,
  agregar y sacar gente, editar, cerrar conversaciones, y que nadie entra solo a un privado.
- Avisos: un `@canal` le llega solo a quien está en el canal.
- La limpieza: sin conversaciones duplicadas ni vacías, un solo `general`, ningún mensaje huérfano.
- Correr todo por segunda vez no cambia nada.
- Al final imprime la vista previa: qué se borra y cómo queda la barra de cada persona.

La app en modo demo se prueba a mano (`node scripts/servir.mjs` y `http://localhost:5180/?demo`)
y con `../notificaciones/avisos.test.mjs`.
