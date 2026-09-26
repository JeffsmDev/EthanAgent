# CLAUDE.md — Ethan (Native English Coach)

Reglas y guía para cualquier agente (Claude, Gemini, Codex…) que trabaje en este repo.
El estado vivo del proyecto y la bitácora de fases están en [CONTEXT.md](CONTEXT.md) — léelo primero.

## Reglas inquebrantables

- **Solo `pnpm`.** Prohibido `npm`/`npx`/`yarn` (instalar, scripts, build, Docker, deploy). Usa `pnpm dlx` en vez de `npx`.
- **Nunca** commitear `packages/backend/.env` ni `packages/backend/data/` (progreso del usuario).
- Las API keys solo viven en `.env` del servidor; nunca en el frontend ni en el código.
- Gemini (vía skill `gemini-agent`) tiene rol de **revisor en solo lectura**; sus hallazgos se verifican antes de aplicarse.

## Estructura (monorepo pnpm)

```
packages/backend    Node 22 + TS + Express (ESM, NodeNext → imports con extensión .js)
  src/server.ts            rutas HTTP; en producción también sirve el frontend compilado
  src/engines/             motores IA: claude | gemini | ollama | mock (interfaz AIEngine en aiProvider.ts)
    claudeCliEngine.ts     Claude vía `claude -p` (suscripción, CLAUDE_CODE_OAUTH_TOKEN), sin tools/MCP/settings
    engineFactory.ts       EngineRegistry: motores disponibles + cambio en caliente persistido (data/engine.json)
    pricing.ts             tarifas Gemini para estimar coste (Claude reporta el suyo)
    engineErrors.ts        EngineError tipado + withResilience (timeout, backoff, cancelación)
  src/agents/tutorPrompt.ts    system prompt pedagógico (Lexical Approach + Active Recasting + STUDENT MEMORY)
  src/agents/responseParser.ts parseo único de [SPOKEN RESPONSE] / [NATIVE UPGRADE] / ```json
  src/store/progressStore.ts   persistencia JSON (nivel CEFR, sesiones, Native Upgrades)
  src/store/usageStore.ts      historial de coste/latencia por turno y motor (data/usage.json)
  src/store/jsonFile.ts        helper de JSON con escritura atómica compartido por los stores
  src/voice/edgeTtsService.ts  TTS neuronal (msedge-tts). El texto SIEMPRE se escapa (SSML)
  src/voice/sttService.ts      voz → texto con whisper.cpp en el servidor (Docker). Sin él, el frontend usa Web Speech
  data/progress.json       datos del usuario (gitignored, volumen en Docker)
packages/frontend   React 18 + Vite + CSS vanilla (proxy /api → :4000 en dev)
Dockerfile, docker-compose.yml   imagen única (API + frontend), puerto solo en 127.0.0.1
deploy/             nginx (plantilla), pm2 (ecosystem.config.cjs) y deploy.sh — guía en DEPLOY.md
```

## Comandos

```bash
pnpm install                 # dependencias de todo el monorepo
pnpm dev                     # backend :4000 + frontend :3000 en paralelo
pnpm build                   # compila backend (tsc) y frontend (tsc + vite)
pnpm start                   # producción: backend sirve API + frontend en :4000
```

## Convenciones

- Formato de respuesta del tutor: `[SPOKEN RESPONSE]` (único texto que va a TTS) + `[SPANISH]` + `[NATIVE UPGRADE]` opcional (con Pronunciation y Explicación) + `[STEP_STATUS]` (test) o `[SCORES]` (práctica) + bloque ```json al cerrar el diagnóstico. El parseo vive en el backend (`src/agents/responseParser.ts`); no duplicarlo en el frontend.
- Errores del motor IA → HTTP 503 con `{ code, friendlyMessage }`; el frontend los muestra, nunca crashea.
- El backend debe correr como **una sola instancia** (el store JSON no es multi-proceso).
- El cambio de motor (`POST /api/engine`) solo elige entre motores ya configurados en el servidor: **nunca** aceptar keys/tokens desde el cliente.
- Todo motor nuevo devuelve `EngineResult` con `usage` (tokens + coste) para que el historial de costes siga siendo comparable.
- Comentarios y logs en español, contenido pedagógico/UI del tutor en inglés.
- Tras cambiar código: `pnpm build` debe pasar limpio antes de dar una tarea por terminada.
