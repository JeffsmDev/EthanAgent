import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, SessionMode, UserProgressContext } from './agents/tutorPrompt.js';
import { parseTutorResponse } from './agents/responseParser.js';
import { ProgressStore, isValidSessionId, ResetScope } from './store/progressStore.js';
import { ChatMessage } from './engines/aiProvider.js';
import { engineConfigFromEnv, liveStatus, resetLiveStatusCache, resolveEngine } from './engines/engineFactory.js';
import { EngineError, withResilience } from './engines/engineErrors.js';
import { EdgeTtsService } from './voice/edgeTtsService.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env de packages/backend sin depender del cwd (pnpm, PM2, node directo). Las variables ya definidas (Docker/PM2) mandan
dotenv.config({ path: path.join(backendRoot, '.env') });

const app = express();
const PORT = process.env.PORT || 4000;
const progressStore = new ProgressStore(process.env.DATA_DIR || path.join(backendRoot, 'data'));

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 4000;
const MAX_TTS_CHARS = 1500;

app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Selección modular del motor de IA: sin API key o con config inválida arranca en mock con aviso, nunca crashea
let resolved = resolveEngine(engineConfigFromEnv());
const ttsService = new EdgeTtsService(process.env.TTS_VOICE || 'en-US-ChristopherNeural');

// Express 4 no captura promesas rechazadas: sin esto una excepción async deja la petición colgada
const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    handler(req, res).catch(next);
  };

// Normaliza el historial que manda el cliente: roles válidos, textos acotados y solo los últimos turnos
function sanitizeHistory(history: unknown): ChatMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m): m is ChatMessage =>
      !!m && typeof m.content === 'string' && m.content.trim() !== '' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
}

// Health Check
app.get('/api/health', asyncRoute(async (req: Request, res: Response) => {
  const engine = await liveStatus(resolved);
  res.json({
    status: 'online',
    tutor: 'Ethan (Native English Coach)',
    activeEngine: engine.engineName,
    engine,
    ttsVoice: process.env.TTS_VOICE || 'en-US-ChristopherNeural'
  });
}));

// Cambio de motor en caliente: solo para desarrollo. En una VPS pública permitiría a cualquiera inyectar su API key
app.post('/api/config/engine', (req: Request, res: Response) => {
  if (process.env.ENABLE_ENGINE_SWITCH !== 'true') {
    return res.status(403).json({ error: 'Engine switching is disabled. Set ENABLE_ENGINE_SWITCH=true (development only).' });
  }
  const { provider, apiKey, model } = req.body || {};
  const envConfig = engineConfigFromEnv();
  resolved = resolveEngine({
    ...envConfig,
    provider,
    geminiApiKey: apiKey || envConfig.geminiApiKey,
    geminiModel: provider === 'gemini' ? model || envConfig.geminiModel : envConfig.geminiModel,
    ollamaModel: provider === 'ollama' || provider === 'local' ? model || envConfig.ollamaModel : envConfig.ollamaModel
  });
  resetLiveStatusCache();
  res.json({ message: `Engine changed to ${resolved.status.engineName}`, activeEngine: resolved.status.engineName, engine: resolved.status });
});

// Chat conversacional con el tutor
app.post('/api/chat', asyncRoute(async (req: Request, res: Response) => {
  const {
    message,
    history,
    mode = 'placement',
    userContext = {},
    sessionId,
    topic = ''
  }: {
    message: unknown;
    history: unknown;
    mode: SessionMode;
    userContext: UserProgressContext;
    sessionId?: string;
    topic?: string;
  } = req.body || {};

  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ error: 'Message is required.', code: 'BAD_REQUEST' });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`, code: 'BAD_REQUEST' });
  }
  const safeMode: SessionMode = mode === 'daily_session' ? 'daily_session' : 'placement';
  // Se captura el motor al inicio: un cambio en caliente no afecta a la petición en curso
  const { engine, resilience } = resolved;
  // Si el usuario recarga o cierra la pestaña se aborta la llamada al LLM (res 'close', no req: en Node ≥16 req
  // emite 'close' al terminar de leer el body)
  const clientGone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientGone.abort();
  });

  try {
    // El progreso persistido manda sobre lo que diga el cliente
    const progress = progressStore.getProgress();
    const enrichedContext: UserProgressContext = {
      ...userContext,
      cefrLevel: progress.cefrLevel || userContext.cefrLevel,
      priorityAreas: progress.diagnostic?.priorityAreas,
      recommendedTheme: progress.diagnostic?.firstSessionRecommendedTheme,
      weakPoints: progressStore.getWeakPoints().map(({ original, native, count }) => ({ original, native, count }))
    };

    const systemPrompt = buildSystemPrompt(safeMode, enrichedContext);
    const safeHistory = sanitizeHistory(history);

    const rawResponse = await withResilience(
      engine.name,
      resilience,
      signal => engine.generateResponse({ systemPrompt, history: safeHistory, userMessage: message.trim(), signal }),
      clientGone.signal
    );

    const { spokenText, upgrades, diagnosticData } = parseTutorResponse(rawResponse);

    // Persistencia best-effort: un fallo de disco no debe romper la conversación
    let savedLevel = null;
    try {
      await progressStore.addUpgrades(upgrades);
      if (diagnosticData?.testCompleted) {
        savedLevel = await progressStore.saveDiagnostic(diagnosticData);
      }
      if (isValidSessionId(sessionId)) {
        await progressStore.recordTurn(sessionId, safeMode, String(topic));
      }
    } catch (persistError) {
      console.error('Error persistiendo progreso:', persistError);
    }

    res.json({
      rawResponse,
      spokenText,
      upgrades,
      // Si el nivel no se pudo guardar (CEFR inválido), el test NO se da por terminado: el usuario sigue en diagnóstico
      diagnosticData: diagnosticData?.testCompleted
        ? (savedLevel ? { ...diagnosticData, assignedLevel: savedLevel } : { ...diagnosticData, testCompleted: false })
        : diagnosticData,
      engineUsed: engine.name
    });
  } catch (error) {
    if (error instanceof EngineError && error.code === 'CANCELLED') {
      console.warn('Cliente desconectado: llamada al motor cancelada');
      return;
    }
    if (error instanceof EngineError) {
      console.error(`Error del motor en /api/chat: ${error.message}`);
      // 503 = servicio de IA no disponible; el frontend muestra friendlyMessage y el usuario puede reintentar
      return res.status(503).json({ error: error.friendlyMessage, code: error.code, retryable: error.retryable });
    }
    console.error('Error inesperado en /api/chat:', error);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
  }
}));

// Progreso del usuario: nivel CEFR, historial de sesiones y Native Upgrades acumulados
app.get('/api/user/progress', (req: Request, res: Response) => {
  const progress = progressStore.getProgress();
  const sessions = [...progress.sessions].reverse();
  res.json({
    cefrLevel: progress.cefrLevel,
    diagnostic: progress.diagnostic,
    stats: {
      totalSessions: sessions.length,
      totalMinutes: sessions.reduce((sum, s) => sum + s.durationMinutes, 0),
      totalUpgrades: progress.nativeUpgrades.length
    },
    sessions: sessions.slice(0, 50),
    weakPoints: progressStore.getWeakPoints(10),
    nativeUpgrades: progress.nativeUpgrades,
    updatedAt: progress.updatedAt
  });
});

// scope 'level' = repetir solo el diagnóstico; 'all' (default) = borrar todo el progreso
app.post('/api/user/reset', asyncRoute(async (req: Request, res: Response) => {
  const scope: ResetScope = req.body?.scope === 'level' ? 'level' : 'all';
  await progressStore.reset(scope);
  res.json({ message: scope === 'level' ? 'Diagnostic reset' : 'All progress reset', scope });
}));

// Cierre de sesión (botón o navigator.sendBeacon al cerrar la pestaña)
// sendBeacon envía text/plain (tipo CORS-safelisted), por eso esta ruta acepta también texto
app.post('/api/user/session/end', express.text({ type: 'text/plain' }), asyncRoute(async (req: Request, res: Response) => {
  let body = req.body || {};
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const { sessionId, durationMinutes } = body;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'sessionId inválido' });
  }
  const session = await progressStore.endSession(sessionId, Number(durationMinutes));
  res.json({ session });
}));

// Síntesis de voz con Edge-TTS
app.get('/api/voice/synthesize', asyncRoute(async (req: Request, res: Response) => {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text) {
    return res.status(400).json({ error: 'Parámetro text requerido' });
  }
  if (text.length > MAX_TTS_CHARS) {
    return res.status(400).json({ error: `Texto demasiado largo (máx ${MAX_TTS_CHARS} caracteres)` });
  }

  let stream;
  try {
    stream = await ttsService.synthesizeToStream(text);
  } catch (error) {
    console.error('Error conectando con Edge TTS:', error);
    // 502: el servicio de voz externo falló; el frontend cae a la voz del navegador
    return res.status(502).json({ error: 'Voice service unavailable' });
  }

  // El cliente pudo cortar (stop / nueva frase) mientras se negociaba con Edge: no sintetizar para nadie
  if (res.destroyed || req.socket.destroyed) {
    stream.destroy();
    return;
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  // Sin handler de 'error', un stream cortado a mitad tumbaba el proceso de Node
  stream.on('error', error => {
    console.error('Error en el stream de Edge TTS:', error.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Voice service unavailable' });
    } else {
      res.destroy();
    }
  });
  // Si el usuario corta el audio (stop / nueva frase), se libera la conexión con Edge
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}));

// Rutas /api inexistentes → 404 JSON (no deben caer en el index.html del frontend)
app.use('/api', (req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Producción: el backend sirve el frontend compilado (un solo proceso/contenedor detrás de Nginx)
const frontendDist = process.env.FRONTEND_DIST || path.resolve(backendRoot, '../frontend/dist');
if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  app.use(express.static(frontendDist, {
    index: false,
    setHeaders: (res, filePath) => {
      // Los assets de Vite llevan hash en el nombre: caché inmutable. El resto se revalida
      res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    }
  }));
  // SPA: cualquier otra ruta GET devuelve index.html
  app.get('*', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`🖥️  Sirviendo frontend desde ${frontendDist}`);
}

// JSON malformado u otros errores de middleware → respuesta JSON, no página HTML de Express
app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const status = typeof error?.status === 'number' ? error.status : 500;
  if (status >= 500) console.error('Error no controlado:', error);
  res.status(status).json({ error: status === 413 ? 'Request too large' : status < 500 ? 'Invalid request' : 'Internal server error' });
});

// Última red de seguridad: registrar en vez de dejar morir el proceso por una promesa olvidada
process.on('unhandledRejection', reason => {
  console.error('⚠️ Promesa rechazada sin manejar:', reason);
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Tutor English Backend iniciado en http://localhost:${PORT}`);
  console.log(`🧠 Motor de IA activo: ${resolved.status.engineName}${resolved.status.warning ? ` — ${resolved.status.warning}` : ''}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PORT} ya está en uso (¿otro "pnpm dev" abierto?). Ciérralo o cambia PORT en packages/backend/.env`);
    process.exit(1);
  }
  throw error;
});
