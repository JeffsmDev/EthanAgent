#!/usr/bin/env bash
# Ethan — prueba de integración de los endpoints principales
# Uso: bash deploy/smoke-test.sh [URL_BASE] [--login Usuario:clave] [--with-chat]
#   URL_BASE    default http://127.0.0.1:3000
#   --login     inicia sesión (usa un usuario de AUTH_USERS; recomendado: demo). Sin él solo se comprueba que la API exige login
#   --with-chat también prueba POST /api/chat (gasta cuota del proveedor IA y guarda los upgrades en el progreso)
set -uo pipefail

BASE="http://127.0.0.1:3000"
WITH_CHAT=false
LOGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-chat) WITH_CHAT=true ;;
    --login) LOGIN="${2:-}"; shift ;;
    http*) BASE="${1%/}" ;;
  esac
  shift
done
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

PASS=0
FAIL=0
check() { # check NOMBRE CONDICIÓN_OK DETALLE
  if [[ "$2" == "true" ]]; then
    printf '  \033[32m✔\033[0m %-34s %s\n' "$1" "$3"; PASS=$((PASS + 1))
  else
    printf '  \033[31m✖\033[0m %-34s %s\n' "$1" "$3"; FAIL=$((FAIL + 1))
  fi
}

echo "Smoke test contra $BASE"

body=$(curl -s --max-time 15 -w $'\n%{http_code}' "$BASE/api/health")
code=${body##*$'\n'}; json=${body%$'\n'*}
check "GET /api/health" "$([[ $code == 200 && $json == *'"status":"online"'* ]] && echo true)" "HTTP $code"
warning=$(printf '%s' "$json" | grep -o '"warning":"[^"]*"' | head -1)
[[ -n "$warning" ]] && echo "      ⚠ ${warning#\"warning\":}"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/api/user/progress")
check "API protegida sin login" "$([[ $code == 401 ]] && echo true)" "HTTP $code (esperado 401)"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/")
check "GET / (frontend)" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

if [[ -z "$LOGIN" ]]; then
  echo "  (sin --login: se omiten las pruebas de la API autenticada)"
  echo "Resultado: $PASS OK, $FAIL fallos"
  [[ $FAIL -eq 0 ]]
  exit
fi

payload=$(printf '{"username":"%s","password":"%s"}' "${LOGIN%%:*}" "${LOGIN#*:}")
code=$(curl -s --max-time 15 -c "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "$payload")
check "POST /api/auth/login" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

code=$(curl -s --max-time 30 -b "$JAR" -o /tmp/ethan-smoke.mp3 -w '%{http_code} %{content_type} %{size_download}' "$BASE/api/voice/synthesize?text=Hello")
read -r http ctype size <<< "$code"
check "GET /api/voice/synthesize?text=Hello" "$([[ $http == 200 && $ctype == audio/mpeg* && ${size:-0} -gt 1000 ]] && echo true)" "HTTP $http, ${size:-0} bytes"
rm -f /tmp/ethan-smoke.mp3

code=$(curl -s --max-time 15 -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/user/progress")
check "GET /api/user/progress" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

body=$(curl -s --max-time 15 -b "$JAR" -w $'\n%{http_code}' "$BASE/api/engines")
code=${body##*$'\n'}; json=${body%$'\n'*}
check "GET /api/engines" "$([[ $code == 200 && $json == *'"options"'* ]] && echo true)" "HTTP $code, actual: $(printf '%s' "$json" | grep -o '"engineName":"[^"]*"' | head -1 | cut -d'"' -f4)"

code=$(curl -s --max-time 15 -b "$JAR" -o /dev/null -w '%{http_code}' "$BASE/api/usage")
check "GET /api/usage" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

code=$(curl -s --max-time 15 -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config/engine" -H 'Content-Type: application/json' -d '{"provider":"gemini","apiKey":"x"}')
check "Endpoint inseguro retirado" "$([[ $code == 404 ]] && echo true)" "HTTP $code (esperado 404)"

if $WITH_CHAT; then
  body=$(curl -s --max-time 120 -b "$JAR" -w $'\n%{http_code}' "$BASE/api/chat" -H 'Content-Type: application/json' \
    -d '{"message":"Hi Ethan! Actually I am working in a new project.","history":[],"mode":"daily_session"}')
  code=${body##*$'\n'}; json=${body%$'\n'*}
  check "POST /api/chat" "$([[ $code == 200 && $json == *'"spokenText"'* ]] && echo true)" "HTTP $code"
  [[ $code != 200 ]] && echo "      $json"
fi

echo "Resultado: $PASS OK, $FAIL fallos"
[[ $FAIL -eq 0 ]]
