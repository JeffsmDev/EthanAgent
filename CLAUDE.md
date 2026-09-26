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
  src/engines/             motores IA: gemini | ollama | mock (interfaz AIEngine en aiProvider.ts)
    engineFactory.ts       elige motor desde .env; sin key/config inválida → mock + warning para la UI
    engineErrors.ts        EngineError tipado + withResilience (timeout, backoff, cancelación)
  src/agents/tutorPrompt.ts    system prompt pedagógico (Lexical Approach + Active Recasting + STUDENT MEMORY)
  src/agents/responseParser.ts parseo único de [SPOKEN RESPONSE] / [NATIVE UPGRADE] / ```json
  src/store/progressStore.ts   persistencia JSON (nivel CEFR, sesiones, Native Upgrades)
  src/voice/edgeTtsService.ts  TTS neuronal (msedge-tts). El texto SIEMPRE se escapa (SSML)
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

- Formato de respuesta del tutor: `[SPOKEN RESPONSE]` (va a TTS) + `[NATIVE UPGRADE]` opcional + bloque ```json al cerrar el diagnóstico. El parseo vive en el backend (`src/agents/responseParser.ts`); no duplicarlo en el frontend.
- Errores del motor IA → HTTP 503 con `{ code, friendlyMessage }`; el frontend los muestra, nunca crashea.
- El backend debe correr como **una sola instancia** (el store JSON no es multi-proceso).
- `/api/config/engine` solo existe con `ENABLE_ENGINE_SWITCH=true` (desarrollo). Nunca en producción.
- Comentarios y logs en español, contenido pedagógico/UI del tutor en inglés.
- Tras cambiar código: `pnpm build` debe pasar limpio antes de dar una tarea por terminada.
