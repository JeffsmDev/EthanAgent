# CONTEXT.md — Estado del proyecto

> Documento vivo. Se actualiza al cerrar cada fase. Reglas de trabajo en [CLAUDE.md](CLAUDE.md).

## Producto

Web app para aprender a **hablar inglés nativo** con **Ethan**, un tutor conversacional por voz:
diagnóstico CEFR adaptativo de 4 pasos → sesiones diarias de 15–30 min con corrección
*Active Recasting* (tarjeta "Native Upgrade"). Usuario objetivo: hispanohablante. App **mono-usuario** (sin login).

## Decisiones de arquitectura

| Decisión | Elección | Por qué |
|---|---|---|
| Persistencia | JSON en `packages/backend/data/progress.json` con escritura atómica (tmp + rename) y cola de escritura serializada | Un solo usuario y datos pequeños. `better-sqlite3` exige compilación nativa (Windows dev + Alpine Docker) sin aportar valor a esta escala |
| Parseo de respuestas del tutor | Backend (`responseParser.ts`) | Única fuente de verdad; el backend necesita los upgrades para persistirlos |
| Duración de sesión | El backend registra la sesión en cada `/api/chat` (upsert por `sessionId`) y el frontend la cierra con `sendBeacon` | No se pierde la sesión aunque se cierre la pestaña |
| Motor IA sin API key | Arranca en **mock** con aviso visible en la UI | Nunca crashea; el usuario sabe qué configurar |
| Deploy | Un solo contenedor (Express sirve API + frontend estático) detrás de Nginx del host + Certbot. Alternativa PM2 | Mínima superficie en la VPS |

## Riesgos conocidos

- `gemini-2.0-flash` puede estar retirado por Google a la fecha; si responde 404, cambiar `GEMINI_MODEL` (p. ej. `gemini-2.5-flash`).
- Sin autenticación: en una VPS pública cualquiera con la URL puede usar/resetear el progreso. Mitigación: basic auth en Nginx (plantilla incluida, comentada).

## Bitácora de fases

| Fase | Estado | Notas |
|---|---|---|
| Auditoría inicial | ✅ | Build base OK. Bugs previos detectados: mic abortado cada 1 s (dependencia de callback inestable), `/api/config/engine` abierto a cualquiera, stream TTS sin handler de error, producción no sirve el frontend |
| A — Persistencia CEFR/sesiones/upgrades | ✅ | `progressStore.ts` + `responseParser.ts`; endpoints `GET /api/user/progress`, `POST /api/user/reset {scope:'level'\|'all'}`, `POST /api/user/session/end`. Memoria de errores inyectada en el prompt (STUDENT MEMORY). Frontend carga el nivel al abrir y no repite el test. Fixes: mic abortado cada 1 s, mock que cerraba el test en el 1er mensaje. Review Gemini: 6/7 hallazgos aceptados y corregidos (parser con negritas, beacon text/plain, carrera End session/Reset, CEFR inválido, `mode` sin validar); 1 rechazado (fallback de duración) |
| B — Calibración motor IA | ✅ | `engineFactory.ts` (sin key/placeholder/provider inválido → mock + aviso en UI; probe de key y modelo Gemini vía `models.get`; probe de Ollama) + `engineErrors.ts` (errores tipados, timeout por intento, backoff solo en transitorios, cancelación si el cliente se desconecta). SDK Gemini con reintentos internos desactivados (hacía 5). `/api/config/engine` bloqueado salvo `ENABLE_ENGINE_SWITCH=true`. TTS: escape SSML (un "&" tumbaba el proceso — verificado), cierre de WebSocket, fallback a voz del navegador. Review Gemini: 5 aceptados, 2 parciales, 1 rechazado |
| C — Deploy VPS Hostinger | ✅ | `Dockerfile` multi-stage (pnpm vía corepack, runtime alpine como `node`, 286 MB), `docker-compose.yml` (puerto solo en 127.0.0.1, volumen `ethan_ethan-data`), `deploy/nginx/ethan.conf.template`, `deploy/pm2/ecosystem.config.cjs`, `deploy/deploy.sh`, `deploy/smoke-test.sh`, `DEPLOY.md`, `.gitignore` (no existía: `.env` se habría subido). Validado: imagen + compose reales, `nginx -t`, shellcheck, y `deploy.sh --mode pm2` ejecutado en Ubuntu 24.04 limpio (destapó bug del symlink de pm2, corregido). Review Gemini: 5 aceptados, 1 rechazado. **Sin probar en VPS real:** modo Docker del script, Nginx+Certbot con DNS real |
| D — Pruebas y validación | ✅ | Build limpio + `tsc --noEmit` en ambos paquetes; smoke test 6/6 (`/api/health`, `/api/chat`, `/api/voice/synthesize?text=Hello`, progress, frontend, config bloqueado) en local, en Docker y en Ubuntu; capturas de UI (usuario nuevo / que regresa) verificadas |

## Pendiente / siguientes pasos

- Poner una `GEMINI_API_KEY` real y comprobar si `gemini-2.0-flash` sigue disponible (el banner lo dirá).
- Subir el repo (no es git todavía) y ejecutar `deploy/deploy.sh` en la VPS.
- Activar basic auth en Nginx (la app no tiene login).
