#!/usr/bin/env bash
# =============================================================================
# Ethan — guarda el token de Claude (suscripción) y reinicia la app
#
# 1. Genera el token (una vez, dura ~1 año):   claude setup-token
# 2. En la VPS:                                sudo bash /opt/ethan/deploy/set-claude-token.sh
#    Pega el token cuando lo pida: NO se muestra en pantalla ni queda en el historial de la shell.
# =============================================================================
set -Eeuo pipefail

ok()  { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Ejecuta con sudo: sudo bash deploy/set-claude-token.sh"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/packages/backend/.env"
[[ -f "$ENV_FILE" ]] || die "No existe $ENV_FILE (ejecuta primero deploy/deploy.sh)"

read -rsp "Pega el token de 'claude setup-token' (no se mostrará): " TOKEN
echo
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^sk-ant-[A-Za-z0-9_-]{20,}$ ]] || die "Eso no parece un token de Claude (empieza por sk-ant-…)"

if grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' "$ENV_FILE"; then
  sed -i "s|^CLAUDE_CODE_OAUTH_TOKEN=.*|CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}|" "$ENV_FILE"
else
  echo "CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}" >> "$ENV_FILE"
fi
unset TOKEN
ok "Token guardado en packages/backend/.env (permisos $(stat -c %a "$ENV_FILE"))"

cd "$APP_DIR"
if command -v docker > /dev/null && docker compose ps -q ethan 2> /dev/null | grep -q .; then
  # up -d recrea el contenedor porque cambió el env_file
  docker compose up -d > /dev/null
  CHECK=(docker exec ethan-english-coach sh -c)
elif command -v pm2 > /dev/null; then
  APP_USER="$(stat -c %U "$APP_DIR/packages/backend/data" 2> /dev/null || echo root)"
  sudo -u "$APP_USER" -H pm2 restart ethan-english-coach --update-env > /dev/null
  CHECK=(sudo -u "$APP_USER" -H sh -c)
else
  die "No encuentro la app corriendo (ni Docker ni PM2)"
fi
ok "Ethan reiniciado"

# Prueba real y barata con el propio CLI (Haiku, respuesta de una palabra)
sleep 3
# En Docker el contenedor ya tiene el .env (env_file); con PM2 se carga aquí. `.` de un archivo inexistente
# abortaría sh, por eso va condicionado
RESULT="$("${CHECK[@]}" 'cd /tmp; if [ -f '"$ENV_FILE"' ]; then set -a; . '"$ENV_FILE"'; set +a; fi; echo "Reply with the single word OK" | "${CLAUDE_BIN:-claude}" -p --model claude-haiku-4-5-20251001 --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --output-format json' 2>&1 || true)"
if [[ "$RESULT" == *'"is_error":false'* ]]; then
  ok "Claude responde con tu suscripción. Ya puedes practicar con Ethan"
else
  die "Claude no respondió bien: $(printf '%s' "$RESULT" | grep -o '"result":"[^"]*"' | head -1)"
fi
