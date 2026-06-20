#!/usr/bin/env bash
#
# sync-checklist.sh — Sincroniza docs/MVP_PRODUCTION_CHECKLIST.md entre el repo
# frontend (pos-system) y el backend (pos-system-backend).
#
# El checklist es UNA fuente de verdad compartida. Este script copia el archivo
# de un repo al otro, mostrando el diff antes de sobrescribir.
#
# Es el MISMO script en ambos repos: detecta en cuál está corriendo por su
# propia ubicación y deduce el repo "hermano".
#
# Uso:
#   ./scripts/sync-checklist.sh status      # (default) compara ambas copias
#   ./scripts/sync-checklist.sh push        # copia ESTE repo  -> el OTRO
#   ./scripts/sync-checklist.sh pull        # copia el OTRO    -> ESTE repo
#   ./scripts/sync-checklist.sh push -y     # sin confirmación
#
# Override de rutas (si los repos no son hermanos en disco):
#   OTHER_REPO=/ruta/al/otro/repo ./scripts/sync-checklist.sh status
#
set -euo pipefail

REL_PATH="docs/MVP_PRODUCTION_CHECKLIST.md"

# ── Resolver el repo en el que vive este script ──────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THIS_REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
THIS_NAME="$(basename "$THIS_REPO")"
PARENT_DIR="$(dirname "$THIS_REPO")"

# ── Deducir el repo hermano (override con $OTHER_REPO) ───────────────────────
if [[ -n "${OTHER_REPO:-}" ]]; then
  OTHER_REPO="$(cd "$OTHER_REPO" && pwd)"
else
  case "$THIS_NAME" in
    pos-system-backend) OTHER_REPO="$PARENT_DIR/pos-system" ;;
    pos-system)         OTHER_REPO="$PARENT_DIR/pos-system-backend" ;;
    *)
      echo "✖ No reconozco el repo '$THIS_NAME'. Define OTHER_REPO=/ruta/al/otro." >&2
      exit 1
      ;;
  esac
fi

if [[ ! -d "$OTHER_REPO" ]]; then
  echo "✖ Repo hermano no encontrado: $OTHER_REPO" >&2
  echo "  Pásalo explícito:  OTHER_REPO=/ruta ./scripts/sync-checklist.sh $*" >&2
  exit 1
fi

THIS_FILE="$THIS_REPO/$REL_PATH"
OTHER_FILE="$OTHER_REPO/$REL_PATH"
OTHER_NAME="$(basename "$OTHER_REPO")"

cmd="${1:-status}"
flag="${2:-}"

# ── Helpers ──────────────────────────────────────────────────────────────────
mtime() { [[ -f "$1" ]] && date -r "$1" "+%Y-%m-%d %H:%M:%S" || echo "(no existe)"; }

show_diff() {
  if [[ ! -f "$1" ]]; then echo "  (origen no existe: $1)"; return; fi
  if [[ ! -f "$2" ]]; then echo "  (destino nuevo, se creará)"; return; fi
  if diff -q "$1" "$2" >/dev/null; then
    echo "  ✔ Idénticos, nada que copiar."
    return 1
  fi
  echo "  Diff (destino < | origen >):"
  diff "$2" "$1" | sed 's/^/    /' || true
  return 0
}

confirm() {
  [[ "$flag" == "-y" || "$flag" == "--yes" ]] && return 0
  read -r -p "  ¿Sobrescribir $1? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

copy() {
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  echo "  ✅ Copiado → $2"
}

# ── Comandos ─────────────────────────────────────────────────────────────────
case "$cmd" in
  status)
    echo "ESTE  ($THIS_NAME):  $(mtime "$THIS_FILE")"
    echo "OTRO  ($OTHER_NAME): $(mtime "$OTHER_FILE")"
    echo
    if [[ -f "$THIS_FILE" && -f "$OTHER_FILE" ]] && diff -q "$THIS_FILE" "$OTHER_FILE" >/dev/null; then
      echo "✔ Ambas copias están sincronizadas."
    else
      echo "✖ Difieren. Diff (OTRO < | ESTE >):"
      diff "$OTHER_FILE" "$THIS_FILE" 2>/dev/null | sed 's/^/  /' || true
      echo
      echo "→ 'push' para enviar ESTE al OTRO · 'pull' para traer el OTRO a ESTE."
    fi
    ;;

  push)
    echo "PUSH: $THIS_NAME  ──►  $OTHER_NAME"
    if show_diff "$THIS_FILE" "$OTHER_FILE"; then
      confirm "$OTHER_FILE" && copy "$THIS_FILE" "$OTHER_FILE" || echo "  ⏭  Cancelado."
    fi
    ;;

  pull)
    echo "PULL: $OTHER_NAME  ──►  $THIS_NAME"
    if show_diff "$OTHER_FILE" "$THIS_FILE"; then
      confirm "$THIS_FILE" && copy "$OTHER_FILE" "$THIS_FILE" || echo "  ⏭  Cancelado."
    fi
    ;;

  *)
    echo "Uso: $0 {status|push|pull} [-y]" >&2
    exit 1
    ;;
esac
