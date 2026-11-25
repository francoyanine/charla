#!/bin/zsh
# Levanta el Supabase de mentira y la función real en Deno para las pruebas de push.
cd "$(dirname "$0")"
export CHARLA_REPO="${CHARLA_REPO:-$PWD/../..}"
node stub-supabase.mjs > stub.log 2>&1 &
export SUPABASE_URL=http://localhost:54399 SUPABASE_SERVICE_ROLE_KEY=servicio
deno run --allow-net --allow-env "$CHARLA_REPO/supabase/functions/notificar/index.ts" > funcion.log 2>&1 &
wait
