#!/usr/bin/env bash
# Arranca el backend en modo watch atado al ciclo de vida de la réplica local.
#
# Levanta el contenedor `db` antes de Nest y lo detiene al salir: Ctrl+C, cerrar
# la terminal o terminar la tarea de VS Code. Así Postgres no queda corriendo en
# segundo plano cuando ya no se está desarrollando.
#
#   scripts/dev.sh             → solo levanta la réplica (sin tocar sus datos)
#   scripts/dev.sh --replica   → además la refresca con un volcado de producción
set -euo pipefail

# bash no lee ~/.zshrc, que es donde se agrega el CLI de Docker Desktop al PATH.
# Sin esto, desde la tarea de VS Code `docker` no existe y todo parece "Docker caído".
export PATH="/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")/.."

stop_db() {
  trap - EXIT
  echo ""
  echo "→ Deteniendo la réplica local…"
  docker compose stop db >/dev/null 2>&1 || true
}

# EXIT cubre también los fallos de `set -e`; las señales solo fuerzan la salida
# para que el trap de EXIT corra una única vez.
trap stop_db EXIT
trap 'exit 130' INT TERM HUP

if [[ "${1:-}" == "--replica" ]]; then
  ./scripts/db-replica.sh
else
  docker compose up -d --wait db
fi

TZ=America/Bogota npx nest start --watch
