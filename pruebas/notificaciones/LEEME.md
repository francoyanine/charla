# Pruebas de las notificaciones

Prueban el número del ícono, los avisos, el sonido y el push de punta a punta, sin tocar
el Supabase real. Necesitan Node, Deno y Google Chrome.

```bash
npm install                        # una vez, en esta carpeta
(cd ../../web && python3 -m http.server 5185) &   # la app en modo demo
```

| Prueba | Qué cubre | Cómo |
|---|---|---|
| `sql.test.mjs` | La migración 006 en un Postgres en memoria (PGlite): permisos, a quién se avisa, conteos, disparador. | `node sql.test.mjs` |
| `avisos.test.mjs` | La app en modo demo con tres personas: número del ícono, avisos, sonido, "no estoy en el computador", franja para activar. | `node avisos.test.mjs` |
| `cliente.test.mjs` | Las llamadas de `backend-supabase.js` contra un Supabase de mentira y la función real; la franja en iPhone y Android. | `./servidores.sh &` y `node cliente.test.mjs` |
| `push.test.mjs` | Push real: Chrome se suscribe, la función `notificar` (en Deno) cifra y envía por el servicio de Google y la notificación aparece. Abre una ventana de Chrome. | `./servidores.sh &` y `node push.test.mjs` |
| `wkmac.swift` | La app de Mac por dentro (WebKit + puente nativo): número del Dock y avisos nativos. | `swiftc -O wkmac.swift -o wkmac && ./wkmac "http://localhost:5185/?demo"` |
| `escala.test.mjs` | Tiempos con el volumen real. Necesita `real.json` (estructura de la base sin textos; no se guarda en el repositorio). | `node escala.test.mjs` |

`servidores.sh` levanta el Supabase de mentira (`stub-supabase.mjs`, puerto 54399) y la
función `notificar` en Deno (puerto 8000). Entre una corrida y otra de `push.test.mjs`
conviene reiniciarlo, porque la base de prueba queda con datos.
