# CONTEXT.md — Estado del proyecto

> Documento vivo. Se actualiza al cerrar cada fase. Reglas de trabajo en [CLAUDE.md](CLAUDE.md).

## Producto

Web app para aprender a **hablar inglés nativo** con **Ethan**, un tutor conversacional por voz:
diagnóstico CEFR adaptativo de 4 pasos → sesiones diarias de 15–30 min con corrección
*Active Recasting* (tarjeta "Native Upgrade"). Usuario objetivo: hispanohablante. **Login para pocos usuarios fijos** (Jefferson = admin, Linda, demo), cada uno con su progreso.

## Decisiones de arquitectura

| Decisión | Elección | Por qué |
|---|---|---|
| Autenticación | Usuarios fijos en `AUTH_USERS` (.env) con scrypt en memoria + cookie HttpOnly firmada (HMAC, 30 días), sin estado en servidor | 3 usuarios que no van a crecer y acceso ya filtrado por IP: una BD de usuarios no aporta nada |
| Persistencia | JSON por usuario en `packages/backend/data/users/<id>/progress.json` (antes `data/progress.json`, migrado al admin) con escritura atómica (tmp + rename) y cola de escritura serializada | Un solo usuario y datos pequeños. `better-sqlite3` exige compilación nativa (Windows dev + Alpine Docker) sin aportar valor a esta escala |
| Parseo de respuestas del tutor | Backend (`responseParser.ts`) | Única fuente de verdad; el backend necesita los upgrades para persistirlos |
| Duración de sesión | El backend registra la sesión en cada `/api/chat` (upsert por `sessionId`) y el frontend la cierra con `sendBeacon` | No se pierde la sesión aunque se cierre la pestaña |
| Motor IA sin API key | Arranca en **mock** con aviso visible en la UI | Nunca crashea; el usuario sabe qué configurar |
| Deploy | Un solo contenedor (Express sirve API + frontend estático) detrás de Nginx del host + Certbot. Alternativa PM2 | Mínima superficie en la VPS |

## Riesgos conocidos

- `gemini-2.0-flash` puede estar retirado por Google a la fecha; si responde 404, cambiar `GEMINI_MODEL` (p. ej. `gemini-2.5-flash`).
- El motor IA y el historial de costes son globales (compartidos por los usuarios); solo el admin puede cambiarlos.

## Bitácora de fases

| Fase | Estado | Notas |
|---|---|---|
| Auditoría inicial | ✅ | Build base OK. Bugs previos detectados: mic abortado cada 1 s (dependencia de callback inestable), `/api/config/engine` abierto a cualquiera, stream TTS sin handler de error, producción no sirve el frontend |
| A — Persistencia CEFR/sesiones/upgrades | ✅ | `progressStore.ts` + `responseParser.ts`; endpoints `GET /api/user/progress`, `POST /api/user/reset {scope:'level'\|'all'}`, `POST /api/user/session/end`. Memoria de errores inyectada en el prompt (STUDENT MEMORY). Frontend carga el nivel al abrir y no repite el test. Fixes: mic abortado cada 1 s, mock que cerraba el test en el 1er mensaje. Review Gemini: 6/7 hallazgos aceptados y corregidos (parser con negritas, beacon text/plain, carrera End session/Reset, CEFR inválido, `mode` sin validar); 1 rechazado (fallback de duración) |
| B — Calibración motor IA | ✅ | `engineFactory.ts` (sin key/placeholder/provider inválido → mock + aviso en UI; probe de key y modelo Gemini vía `models.get`; probe de Ollama) + `engineErrors.ts` (errores tipados, timeout por intento, backoff solo en transitorios, cancelación si el cliente se desconecta). SDK Gemini con reintentos internos desactivados (hacía 5). `/api/config/engine` bloqueado salvo `ENABLE_ENGINE_SWITCH=true`. TTS: escape SSML (un "&" tumbaba el proceso — verificado), cierre de WebSocket, fallback a voz del navegador. Review Gemini: 5 aceptados, 2 parciales, 1 rechazado |
| C — Deploy VPS Hostinger | ✅ | `Dockerfile` multi-stage (pnpm vía corepack, runtime alpine como `node`, 286 MB), `docker-compose.yml` (puerto solo en 127.0.0.1, volumen `ethan_ethan-data`), `deploy/nginx/ethan.conf.template`, `deploy/pm2/ecosystem.config.cjs`, `deploy/deploy.sh`, `deploy/smoke-test.sh`, `DEPLOY.md`, `.gitignore` (no existía: `.env` se habría subido). Validado: imagen + compose reales, `nginx -t`, shellcheck, y `deploy.sh --mode pm2` ejecutado en Ubuntu 24.04 limpio (destapó bug del symlink de pm2, corregido). Review Gemini: 5 aceptados, 1 rechazado. **Sin probar en VPS real:** modo Docker del script, Nginx+Certbot con DNS real |
| E — Motor Claude (suscripción) + costes | ✅ | `claudeCliEngine.ts`: `claude -p` desatendido (sin tools/MCP/settings, sin thinking por defecto: −2,7 s/turno), auth por `CLAUDE_CODE_OAUTH_TOKEN`. `EngineRegistry`: cambio claude⇄gemini⇄mock desde la UI, persistido. `usageStore`: coste/latencia/errores por turno → `GET /api/usage` + tarjeta *AI Engine & Cost*. Retirado `/api/config/engine` (aceptaba keys del cliente). CLI dentro de la imagen Docker (musl). Medido: Sonnet 5 ≈ $0,01–0,02/turno y 7–15 s; Haiku 4.5 ≈ $0,004/turno |
| D — Pruebas y validación | ✅ | Build limpio + `tsc --noEmit` en ambos paquetes; smoke test 6/6 (`/api/health`, `/api/chat`, `/api/voice/synthesize?text=Hello`, progress, frontend, config bloqueado) en local, en Docker y en Ubuntu; capturas de UI (usuario nuevo / que regresa) verificadas |

| F — Producción en VPS Hostinger | ✅ | https://ethan.srv1686217.hstgr.cloud (Docker, Nginx, Let's Encrypt hasta 2026-12-25 con renovación automática). Acceso: firewall Hostinger con 22/443 solo desde la IP del usuario (dinámica → actualizar reglas cuando cambie), 80 abierto solo para ACME. Smoke test HTTPS 7/7. Motor por defecto `claude` (Sonnet 5); falta el token |

| G — Voz robusta + Ethan habla primero | ✅ | Brave bloquea la Web Speech API (error `network`, antes silenciado). Nuevo: grabación Web Audio → WAV 16 kHz → `POST /api/voice/transcribe` → whisper.cpp v1.9.4 `base.en` compilado en la imagen (AVX2). Conserva los errores del alumno (verificado). Auto-stop por silencio. Pantalla "Start session": el clic desbloquea el audio y Ethan saluda en voz alta. Errores de micrófono visibles. E2E con micrófono simulado en Edge OK |

| H — Aprendizaje guiado para hispanohablantes | ✅ | Formato de Ethan: `[SPOKEN RESPONSE]` + `[SPANISH]` (traducción) + `[NATIVE UPGRADE]` con 🗣️ pronunciación y 🇪🇸 explicación + `[STEP_STATUS]` (test: `repeat` si la respuesta no basta → la etapa no avanza) + `[SCORES]` (práctica: fluidez/vocabulario/gramática 1-5 vs nivel actual). Nivel manual (`POST /api/user/level`) y barra de progreso al siguiente nivel (media ≥ 4,3 en 30 respuestas → botón de subir). Grabación: pausa configurable 2/4/6 s o manual con cuenta atrás, hasta 2 min (Nginx `client_max_body_size 10m`). Resumen al cerrar sesión. Botones 🔊/🐌 para escuchar la frase correcta. Coste Sonnet sube a ~$0,012-0,018/turno por el español |

| I — Login multiusuario | ✅ | `auth/authService.ts` + `LoginScreen`/`AuthGate`. 3 usuarios de `AUTH_USERS`, progreso separado por usuario (migración automática del JSON antiguo al admin), `usage.json` guarda `userId`. Motor y reset de costes solo admin (403). Rate limit de login por IP (`trust proxy` loopback + bridge Docker). Smoke test: `--login usuario:clave`. Verificado: login/logout, cookie falsificada → 401, aislamiento Linda/demo, smoke 10/10. **Desplegado en la VPS** (2026-09-27): progreso migrado a jefferson (A2, 2 sesiones, 16 upgrades), smoke HTTPS 9/9, cookie Secure. Backup previo en `/opt/ethan-data-backup-20260927.tgz` |

## Pendiente / siguientes pasos

- Generar `CLAUDE_CODE_OAUTH_TOKEN` en la VPS (`ssh -t vps-agent "~/.local/bin/claude setup-token"`) y guardarlo con `sudo bash /opt/ethan/deploy/set-claude-token.sh`. La sesión interactiva de Claude de `claudeagent` está caducada (re-login con `claude` → `/login` si se quiere usar allí).
- (Opcional) `GEMINI_API_KEY` gratuita de AI Studio para comparar costes con Claude y decidir motor.
- Firewall: la regla 443 del segundo usuario usa 192.168.101.4 (IP privada, no funciona desde Internet): sustituirla por su IP pública (ifconfig.me).
