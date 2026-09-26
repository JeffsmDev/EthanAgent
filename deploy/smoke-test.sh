#!/usr/bin/env bash
# Ethan — prueba de integración de los endpoints principales
# Uso: bash deploy/smoke-test.sh [URL_BASE] [--with-chat]
#   URL_BASE    default http://127.0.0.1:3000
#   --with-chat también prueba POST /api/chat (gasta cuota del proveedor IA y guarda los upgrades en el progreso)
set -uo pipefail

BASE="http://127.0.0.1:3000"
WITH_CHAT=false
for arg in "$@"; do
  case "$arg" in
    --with-chat) WITH_CHAT=true ;;
    http*) BASE="${arg%/}" ;;
  esac
done

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

code=$(curl -s --max-time 30 -o /tmp/ethan-smoke.mp3 -w '%{http_code} %{content_type} %{size_download}' "$BASE/api/voice/synthesize?text=Hello")
read -r http ctype size <<< "$code"
check "GET /api/voice/synthesize?text=Hello" "$([[ $http == 200 && $ctype == audio/mpeg* && ${size:-0} -gt 1000 ]] && echo true)" "HTTP $http, ${size:-0} bytes"
rm -f /tmp/ethan-smoke.mp3

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/api/user/progress")
check "GET /api/user/progress" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/")
check "GET / (frontend)" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

body=$(curl -s --max-time 15 -w $'\n%{http_code}' "$BASE/api/engines")
code=${body##*$'\n'}; json=${body%$'\n'*}
check "GET /api/engines" "$([[ $code == 200 && $json == *'"options"'* ]] && echo true)" "HTTP $code, actual: $(printf '%s' "$json" | grep -o '"engineName":"[^"]*"' | head -1 | cut -d'"' -f4)"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$BASE/api/usage")
check "GET /api/usage" "$([[ $code == 200 ]] && echo true)" "HTTP $code"

code=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/config/engine" -H 'Content-Type: application/json' -d '{"provider":"gemini","apiKey":"x"}')
check "Endpoint inseguro retirado" "$([[ $code == 404 ]] && echo true)" "HTTP $code (esperado 404)"

if $WITH_CHAT; then
  body=$(curl -s --max-time 120 -w $'\n%{http_code}' "$BASE/api/chat" -H 'Content-Type: application/json' \
    -d '{"message":"Hi Ethan! Actually I am working in a new project.","history":[],"mode":"daily_session"}')
  code=${body##*$'\n'}; json=${body%$'\n'*}
  check "POST /api/chat" "$([[ $code == 200 && $json == *'"spokenText"'* ]] && echo true)" "HTTP $code"
  [[ $code != 200 ]] && echo "      $json"
fi

echo "Resultado: $PASS OK, $FAIL fallos"
[[ $FAIL -eq 0 ]]
