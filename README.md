# EthanAgent

**Ethan** es un tutor conversacional por voz para aprender a hablar inglés nativo (hispanohablantes).
Diagnóstico CEFR adaptativo de 4 pasos → sesiones diarias de 15–30 min con corrección *Active Recasting* ("Native Upgrade"),
memoria de errores recurrentes entre sesiones y voz neuronal (Edge TTS).

**Stack:** monorepo `pnpm` · Node 22 + Express + TypeScript · React + Vite · Gemini / Ollama / Mock.

## Inicio rápido

```bash
pnpm install
cp packages/backend/.env.example packages/backend/.env   # añade tu GEMINI_API_KEY
pnpm dev                                                  # http://localhost:3000
```

> Solo `pnpm` (nunca `npm`). Sin API key la app arranca en modo demo y lo avisa en la interfaz.

## Documentación

- [DEPLOY.md](DEPLOY.md) — ejecución local, variables de entorno y despliegue en VPS Hostinger (Docker o PM2 + Nginx + SSL)
- [CLAUDE.md](CLAUDE.md) — reglas y estructura para agentes que trabajen en el repo
- [CONTEXT.md](CONTEXT.md) — estado del proyecto, decisiones de arquitectura y bitácora
