#!/usr/bin/env bash
# =============================================================================
# Ethan — Native English Coach · Deploy en VPS Ubuntu/Debian (Hostinger)
#
# Uso (desde la raíz del repo clonado en la VPS):
#   sudo bash deploy/deploy.sh --domain ethan.midominio.com --email yo@midominio.com
#
# Opciones:
#   --domain <dominio>     Dominio apuntando (registro A) a la IP de la VPS. Necesario para Nginx + SSL
#   --email <email>        Email para Let's Encrypt (si falta, no se emite SSL)
#   --mode docker|pm2      docker (default, recomendado) o pm2 (Node 22 + pnpm directamente en el host)
#   --provider <motor>     Motor por defecto: claude | gemini | ollama | mock (se puede cambiar luego desde la UI)
#   --claude-model <id>    Modelo del motor claude (default claude-sonnet-5)
#   --gemini-key <key>     Guarda GEMINI_API_KEY en packages/backend/.env (y usa gemini si no se indica --provider)
#   --allow-ip <ip|cidr>   Solo estas IPs acceden a la app (repetible). Sin él, la app queda abierta a todo Internet
#   --app-port <puerto>    Puerto interno en 127.0.0.1 al que Nginx hace proxy (default 3000)
#   --skip-nginx           No toca Nginx/SSL; publica la app en 0.0.0.0:<app-port> (sin HTTPS no funciona el micrófono)
#   --no-pull              No hace git pull antes de desplegar
#
# Re-ejecutarlo es seguro (idempotente): actualiza código, reconstruye y recarga sin perder el progreso.
# =============================================================================
set -Eeuo pipefail

DOMAIN=""
EMAIL=""
MODE="docker"
GEMINI_KEY=""
PROVIDER=""
CLAUDE_MODEL=""
ALLOW_IPS=()
APP_PORT="3000"
SKIP_NGINX=false
DO_PULL=true

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }
trap 'die "Falló en la línea $LINENO: $BASH_COMMAND"' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)      DOMAIN="${2:-}"; shift 2 ;;
    --email)       EMAIL="${2:-}"; shift 2 ;;
    --mode)        MODE="${2:-}"; shift 2 ;;
    --gemini-key)  GEMINI_KEY="${2:-}"; shift 2 ;;
    --provider)    PROVIDER="${2:-}"; shift 2 ;;
    --claude-model) CLAUDE_MODEL="${2:-}"; shift 2 ;;
    --allow-ip)    ALLOW_IPS+=("${2:-}"); shift 2 ;;
    --app-port)    APP_PORT="${2:-}"; shift 2 ;;
    --skip-nginx)  SKIP_NGINX=true; shift ;;
    --no-pull)     DO_PULL=false; shift ;;
    -h|--help)     sed -n '2,23p' "$0"; exit 0 ;;
    *) die "Opción desconocida: $1 (usa --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Ejecuta con sudo: sudo bash deploy/deploy.sh ..."
[[ "$MODE" == "docker" || "$MODE" == "pm2" ]] || die "--mode debe ser docker o pm2"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "--app-port debe ser numérico"
# Validar el formato también protege el reemplazo con sed de set_env
[[ -z "$GEMINI_KEY" || "$GEMINI_KEY" =~ ^[A-Za-z0-9_-]+$ ]] || die "--gemini-key tiene caracteres no válidos"
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "--domain no es un dominio válido"
[[ -z "$PROVIDER" || "$PROVIDER" =~ ^(claude|gemini|ollama|mock)$ ]] || die "--provider debe ser claude, gemini, ollama o mock"
[[ -z "$CLAUDE_MODEL" || "$CLAUDE_MODEL" =~ ^[A-Za-z0-9._-]+$ ]] || die "--claude-model no es válido"
for ip in "${ALLOW_IPS[@]}"; do
  [[ "$ip" =~ ^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$ ]] || die "--allow-ip '$ip' no es una IP/CIDR válida"
done
if ! $SKIP_NGINX && [[ -z "$DOMAIN" ]]; then
  die "Falta --domain (o usa --skip-nginx para exponer la app por IP:puerto sin HTTPS)"
fi

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$APP_DIR/pnpm-workspace.yaml" ]] || die "No encuentro el monorepo en $APP_DIR"
ENV_FILE="$APP_DIR/packages/backend/.env"
cd "$APP_DIR"
export DEBIAN_FRONTEND=noninteractive
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Los comandos sobre el repo (git, pnpm) corren como su dueño: si corrieran como root,
# el usuario perdería permisos sobre sus propios archivos (.git, node_modules, dist)
REPO_OWNER="$(stat -c %U "$APP_DIR")"
as_owner() {
  if [[ "$REPO_OWNER" == "root" ]]; then
    "$@"
  else
    sudo -u "$REPO_OWNER" -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$@"
  fi
}

# ----------------------------------------------------------------------------- 1. Paquetes base
log "Instalando paquetes base"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git > /dev/null
if ! $SKIP_NGINX; then
  apt-get install -y -qq nginx certbot python3-certbot-nginx > /dev/null
fi
ok "Paquetes base listos"

# ----------------------------------------------------------------------------- 2. Código
if $DO_PULL && [[ -d .git ]]; then
  log "Actualizando código (git pull)"
  as_owner git -C "$APP_DIR" pull --ff-only || warn "git pull falló; se despliega el código local tal cual"
fi

# ----------------------------------------------------------------------------- 3. Variables de entorno
log "Configurando packages/backend/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$APP_DIR/packages/backend/.env.example" "$ENV_FILE"
  ok "Creado .env desde .env.example"
fi
set_env() { # set_env CLAVE VALOR → reemplaza o añade la línea sin tocar el resto
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}
if [[ -n "$GEMINI_KEY" ]]; then
  set_env GEMINI_API_KEY "$GEMINI_KEY"
  [[ -z "$PROVIDER" ]] && PROVIDER="gemini"
  ok "Gemini configurado"
fi
if [[ -n "$PROVIDER" ]]; then
  set_env AI_PROVIDER "$PROVIDER"
  ok "Motor por defecto: $PROVIDER"
fi
[[ -n "$CLAUDE_MODEL" ]] && set_env CLAUDE_MODEL "$CLAUDE_MODEL"
chown "$REPO_OWNER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
if ! grep -qE '^GEMINI_API_KEY=.{10,}' "$ENV_FILE" && grep -qE '^AI_PROVIDER=gemini' "$ENV_FILE"; then
  warn "AI_PROVIDER=gemini sin API key: Ethan arrancará en modo demo (mock) y lo avisará en la interfaz"
fi
if grep -qE '^AI_PROVIDER=claude' "$ENV_FILE" && ! grep -qE '^CLAUDE_CODE_OAUTH_TOKEN=.{20,}' "$ENV_FILE"; then
  warn "AI_PROVIDER=claude sin CLAUDE_CODE_OAUTH_TOKEN: genera uno con 'claude setup-token' y añádelo a $ENV_FILE"
fi

# ----------------------------------------------------------------------------- 4. App
BIND="127.0.0.1"
$SKIP_NGINX && BIND="0.0.0.0"

if [[ "$MODE" == "docker" ]]; then
  log "Desplegando con Docker"
  if ! command -v docker > /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
  fi
  docker compose version > /dev/null 2>&1 || die "Falta el plugin 'docker compose'"
  APP_BIND="$BIND" APP_PORT="$APP_PORT" docker compose up -d --build --remove-orphans
  docker image prune -f > /dev/null || true
else
  log "Desplegando con PM2 (Node 22 + pnpm)"
  NODE_MAJOR="$(node -v 2> /dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
  if [[ "${NODE_MAJOR:-0}" -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs > /dev/null
  fi
  corepack enable
  as_owner pnpm install --frozen-lockfile
  as_owner pnpm build
  if ! command -v pm2 > /dev/null; then
    export PNPM_HOME="/usr/local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"
    mkdir -p "$PNPM_HOME"
    pnpm add -g pm2
    # Wrapper y no symlink: el shim de pnpm resuelve rutas relativas a su propia ubicación
    printf '#!/bin/sh\nexec "%s/pm2" "$@"\n' "$PNPM_HOME" > /usr/local/bin/pm2
    chmod 755 /usr/local/bin/pm2
  fi

  # La app NUNCA corre como root: usa el dueño del repo o, si es root, un usuario de sistema dedicado
  APP_USER="$REPO_OWNER"
  if [[ "$APP_USER" == "root" ]]; then
    APP_USER="ethan"
    id -u "$APP_USER" > /dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
    chgrp "$APP_USER" "$ENV_FILE"
    chmod 640 "$ENV_FILE"
  fi
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  sudo -u "$APP_USER" test -r "$APP_DIR/packages/backend/dist/server.js" \
    || die "El usuario '$APP_USER' no puede leer $APP_DIR (¿repo dentro de /root?). Clónalo en /opt/ethan y re-ejecuta"
  mkdir -p "$APP_DIR/packages/backend/data"
  chown -R "$APP_USER": "$APP_DIR/packages/backend/data"

  if $SKIP_NGINX; then
    warn "Con PM2 la app escucha en todas las interfaces del puerto $APP_PORT"
  fi
  sudo -u "$APP_USER" -H env PORT="$APP_PORT" pm2 startOrReload "$APP_DIR/deploy/pm2/ecosystem.config.cjs" --update-env
  sudo -u "$APP_USER" -H pm2 save
  # Servicio systemd pm2-<usuario>: la app vuelve sola tras reiniciar la VPS
  env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" > /dev/null
  ok "PM2 corriendo como '$APP_USER'"
fi

# ----------------------------------------------------------------------------- 5. Health check local
log "Esperando a que Ethan responda en 127.0.0.1:$APP_PORT"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" > /dev/null 2>&1; then
    ok "Backend online"
    break
  fi
  [[ $i -eq 40 ]] && die "La app no respondió en 80 s. Revisa: $([[ $MODE == docker ]] && echo 'docker compose logs' || echo 'pm2 logs ethan-english-coach')"
  sleep 2
done

# ----------------------------------------------------------------------------- 6. Nginx + SSL
if ! $SKIP_NGINX; then
  log "Configurando Nginx para $DOMAIN"
  # Allowlist de IPs (la plantilla la incluye en location /; el reto de Let's Encrypt queda fuera)
  ALLOWLIST=/etc/nginx/ethan-allowlist.conf
  {
    echo "# Generado por deploy/deploy.sh — IPs con acceso a Ethan. Editar y: nginx -t && systemctl reload nginx"
    if [[ ${#ALLOW_IPS[@]} -gt 0 ]]; then
      for ip in "${ALLOW_IPS[@]}"; do echo "allow $ip;"; done
      echo "deny all;"
    else
      echo "allow all;"
    fi
  } > "$ALLOWLIST"
  if [[ ${#ALLOW_IPS[@]} -gt 0 ]]; then
    ok "Acceso restringido a: ${ALLOW_IPS[*]}"
  else
    warn "Sin --allow-ip: la app queda accesible desde cualquier IP"
  fi
  SITE=/etc/nginx/sites-available/ethan.conf
  # Siempre se regenera desde la plantilla (así un cambio de --app-port o de dominio se aplica);
  # si ya había certificado, Certbot vuelve a instalar el bloque 443 más abajo sin emitir uno nuevo
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__APP_PORT__/$APP_PORT/g" deploy/nginx/ethan.conf.template > "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/ethan.conf
  nginx -t
  systemctl reload nginx
  ok "Nginx recargado"

  if command -v ufw > /dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 'Nginx Full' > /dev/null && ok "UFW: puertos 80/443 abiertos"
  fi

  CERT_EXISTS=false
  [[ -d "/etc/letsencrypt/live/$DOMAIN" ]] && CERT_EXISTS=true
  if [[ -n "$EMAIL" ]] || $CERT_EXISTS; then
    if ! $CERT_EXISTS; then
      PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
      DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
      if [[ -n "$PUBLIC_IP" && "$DNS_IP" != "$PUBLIC_IP" ]]; then
        warn "El DNS de $DOMAIN apunta a '${DNS_IP:-nada}' y esta VPS es $PUBLIC_IP. Certbot fallará hasta que el registro A propague."
      fi
    fi
    CERTBOT_ARGS=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring)
    [[ -n "$EMAIL" ]] && CERTBOT_ARGS+=(-m "$EMAIL")
    log "Configurando SSL (Let's Encrypt)"
    if certbot "${CERTBOT_ARGS[@]}"; then
      ok "HTTPS activo (renovación automática vía certbot.timer)"
    else
      warn "Certbot falló. Revisa DNS y el firewall de hPanel (puertos 80/443) y re-ejecuta el script"
    fi
  else
    warn "Sin --email no se emite SSL. El micrófono del navegador REQUIERE HTTPS"
  fi
fi

# ----------------------------------------------------------------------------- 7. Resumen
echo
ok "Deploy completado ($MODE)"
if $SKIP_NGINX; then
  echo "   URL: http://<IP-de-la-VPS>:$APP_PORT  (sin HTTPS: el micrófono no funcionará)"
else
  echo "   URL: https://$DOMAIN"
fi
echo "   Estado:   curl -s http://127.0.0.1:$APP_PORT/api/health"
if [[ "$MODE" == "docker" ]]; then
  echo "   Logs:     docker compose logs -f ethan"
  echo "   Backup:   docker run --rm -v ethan_ethan-data:/d -v \$PWD:/b alpine tar czf /b/ethan-data.tgz -C /d ."
else
  echo "   Logs:     sudo -u $APP_USER -H pm2 logs ethan-english-coach"
  echo "   Backup:   tar czf ethan-data.tgz -C packages/backend data"
fi
