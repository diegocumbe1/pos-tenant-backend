#!/usr/bin/env bash
# Copia la base de PRODUCCIÓN a la réplica local de Docker.
#
# Se corre desde la raíz del backend. Si el contenedor está abajo lo levanta solo.
# Es DESTRUCTIVO sobre la base local y de solo lectura sobre producción.
#
# Dos detalles que no son negociables:
#
#   • Se vuelca contra DIRECT_URL (puerto 5432), NO contra DATABASE_URL (pooler
#     6543). El pooler de Supabase trabaja en modo transaction y rompe pg_dump.
#   • pg_dump corre DENTRO de un contenedor postgres:17. El cliente de Homebrew
#     suele ser más viejo que el servidor y pg_dump se niega a volcar una base
#     con versión mayor que la suya.
#
# `supabase_vault` se excluye: es una extensión propia de Supabase que no existe
# en una imagen de Postgres estándar. Nada del esquema de la app depende de ella.
set -euo pipefail

# Ver scripts/dev.sh: bash no hereda el PATH de ~/.zshrc donde vive el CLI de Docker.
export PATH="/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

PG_IMAGE="postgres:17"
CONTAINER="lynko-db-local"
DUMP_FILE="${DUMP_FILE:-/tmp/lynko-prod-dump.sql}"
LOCAL_URL="${LOCAL_DATABASE_URL:-postgresql://lynko:lynko@localhost:5433/postgres}"

if [[ ! -f .env ]]; then
  echo "✗ No encuentro .env en $(pwd)" >&2
  exit 1
fi

# El demonio de Docker. En macOS se intenta abrir Docker Desktop: arrancarlo tarda
# lo suyo, de ahí la espera larga.
ensure_docker_daemon() {
  docker info >/dev/null 2>&1 && return 0

  if [[ "$(uname -s)" == "Darwin" && -d /Applications/Docker.app ]]; then
    echo "→ Docker no responde; abriendo Docker Desktop…"
    open -a Docker
    for _ in $(seq 1 60); do
      docker info >/dev/null 2>&1 && return 0
      sleep 2
    done
  fi

  echo "✗ El demonio de Docker no responde. Arráncalo y repite." >&2
  exit 1
}

# El contenedor de la réplica. `docker compose up -d` sirve tanto si está parado
# como si nunca se creó, así que no hace falta distinguir los dos casos.
ensure_container() {
  if [[ "$(docker inspect -f '{{.State.Running}}' "${CONTAINER}" 2>/dev/null)" != "true" ]]; then
    echo "→ La réplica local está abajo; levantándola…"
    if docker compose version >/dev/null 2>&1; then
      docker compose up -d db
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose up -d db
    else
      echo "✗ No encuentro docker compose para levantar '${CONTAINER}'." >&2
      exit 1
    fi
  fi

  # Estar "running" no basta: Postgres tarda en aceptar conexiones y el psql de
  # más abajo fallaría con "the database system is starting up".
  for _ in $(seq 1 30); do
    if docker exec "${CONTAINER}" pg_isready -U lynko -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "✗ '${CONTAINER}' no aceptó conexiones tras 60s." >&2
  exit 1
}

ensure_docker_daemon
ensure_container

# Se lee sin imprimir: el valor lleva credenciales de producción.
DIRECT_URL="$(grep -E '^DIRECT_URL=' .env | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
if [[ -z "${DIRECT_URL}" ]]; then
  echo "✗ DIRECT_URL no está definida en .env" >&2
  exit 1
fi

echo "→ Volcando producción (solo lectura)…"
# Contenedor efímero solo para tener pg_dump en la versión correcta; --rm lo
# borra al terminar. El nombre fijo evita que Docker Desktop lo muestre con un
# nombre aleatorio que parece otra base corriendo.
docker rm -f lynko-pg-dump >/dev/null 2>&1 || true
docker run --rm --name lynko-pg-dump -e PGURL="${DIRECT_URL}" "${PG_IMAGE}" \
  pg_dump "${PGURL:-$DIRECT_URL}" \
    --no-owner \
    --no-privileges \
    --schema=public \
    --exclude-schema='supabase_vault' \
  > "${DUMP_FILE}"

echo "→ Volcado: $(du -h "${DUMP_FILE}" | cut -f1)"

echo "→ Restaurando en la réplica local (esto BORRA la base local)…"
# Solo se borra: el volcado trae su propio `CREATE SCHEMA public;` y recrearlo
# aquí haría que esa sentencia chocara ("schema public already exists").
docker exec -i lynko-db-local psql -U lynko -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP SCHEMA IF EXISTS public CASCADE;' >/dev/null

# ON_ERROR_STOP=1 porque sin él psql sigue de largo ante un fallo y el script
# termina anunciando "✓ Réplica lista" sobre una base a medio restaurar.
docker exec -i lynko-db-local psql -U lynko -d postgres -q -v ON_ERROR_STOP=1 < "${DUMP_FILE}" >/dev/null

# Las extensiones no viajan en un volcado `--schema=public`. `gen_random_uuid()` es
# nativa desde PG13, pero se crean igual para que la réplica no difiera de prod.
# `pg_stat_statements` se omite: requiere shared_preload_libraries y es solo
# observabilidad, no afecta al esquema.
docker exec -i lynko-db-local psql -U lynko -d postgres -q \
  -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";' >/dev/null

TABLES="$(docker exec -i lynko-db-local psql -U lynko -d postgres -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"

echo "✓ Réplica lista: ${TABLES} tablas en public"
echo "  Apunta el backend con: DATABASE_URL=${LOCAL_URL}"
