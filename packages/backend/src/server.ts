import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt, SessionMode, UserProgressContext } from './agents/tutorPrompt.js';
import { parseTutorResponse } from './agents/responseParser.js';
import { UserProgressStores, isValidSessionId, ResetScope } from './store/progressStore.js';
import { UsageStore } from './store/usageStore.js';
import { ChatMessage } from './engines/aiProvider.js';
import { EngineRegistry, engineConfigFromEnv } from './engines/engineFactory.js';
import { EngineError, withResilience } from './engines/engineErrors.js';
import { EdgeTtsService } from './voice/edgeTtsService.js';
import { WhisperSttService } from './voice/sttService.js';
import { AuthService, AuthUser } from './auth/authService.js';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env de packages/backend sin depender del cwd (pnpm, PM2, node directo). Las variables ya definidas (Docker/PM2) mandan
dotenv.config({ path: path.join(backendRoot, '.env') });

const app = express();
const PORT = process.env.PORT || 4000;
const dataDir = process.env.DATA_DIR || path.join(backendRoot, 'data');
const auth = new AuthService(dataDir);
const progressStores = new UserProgressStores(dataDir, auth.adminId);
const usageStore = new UsageStore(dataDir);

const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 4000;
const MAX_TTS_CHARS = 1500;

// Detrás de Nginx: req.secure/req.ip salen de X-Forwarded-* (cookie Secure en HTTPS, bloqueo de login por IP real)
// loopback = PM2; uniquelocal = Docker (Nginx del host llega por el bridge 172.x). El puerto solo escucha en 127.0.0.1
app.set('trust proxy', ['loopback', 'uniquelocal']);
app.use(cors());
app.use(express.json({ limit: '256kb' }));

// Selección modular del motor de IA: sin API key o con config inválida arranca en mock con aviso, nunca crashea.
// El usuario puede cambiar en caliente entre los motores configurados (la elección persiste en data/engine.json)
const engines = new EngineRegistry(engineConfigFromEnv(), dataDir);
const ttsService = new EdgeTtsService(process.env.TTS_VOICE || 'en-US-ChristopherNeural');
const sttService = new WhisperSttService(process.env.WHISPER_BIN, process.env.WHISPER_MODEL_PATH, Number(process.env.WHISPER_THREADS));
// WAV 16 kHz mono 16 bits ≈ 1,9 MB por minuto; el grabador corta a los 2 min (≈ 3,8 MB)
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

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

// Usuario autenticado de la petición (puesto por auth.requireUser)
const currentUser = (res: Response): AuthUser => res.locals.user as AuthUser;

// Login: cookie HttpOnly firmada. Mensaje genérico para no revelar si el usuario existe
app.post('/api/auth/login', (req: Request, res: Response) => {
  const ip = req.ip || 'unknown';
  if (auth.isLockedOut(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.', code: 'LOCKED' });
  }
  const user = auth.verify(req.body?.username, req.body?.password, ip);
  if (!user) {
    return res.status(401).json({ error: 'Wrong username or password.', code: 'BAD_CREDENTIALS' });
  }
  auth.setSessionCookie(req, res, user);
  res.json({ user });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  auth.clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = auth.userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Please sign in.', code: 'UNAUTHENTICATED' });
  res.json({ user });
});

// Health Check (público: lo usan el smoke test y la monitorización)
app.get('/api/health', asyncRoute(async (req: Request, res: Response) => {
  const engine = await engines.currentStatus();
  res.json({
    status: 'online',
    tutor: 'Ethan (Native English Coach)',
    activeEngine: engine.engineName,
    engine,
    ttsVoice: process.env.TTS_VOICE || 'en-US-ChristopherNeural',
    // true → el frontend graba y transcribe en el servidor (funciona en Brave/Firefox); false → Web Speech del navegador
    stt: { available: sttService.available, engine: sttService.available ? 'whisper.cpp' : null }
  });
}));

// A partir de aquí toda la API exige sesión
app.use('/api', auth.requireUser);

// Motores elegibles. Solo se puede elegir entre los que el servidor ya tiene configurados: nunca se aceptan keys
app.get('/api/engines', asyncRoute(async (req: Request, res: Response) => {
  res.json({ current: await engines.currentStatus(), options: engines.options() });
}));

app.post('/api/engine', auth.requireAdmin, asyncRoute(async (req: Request, res: Response) => {
  try {
    const selected = await engines.select(String(req.body?.provider || ''));
    res.json({ current: await engines.currentStatus(), options: engines.options() });
  } catch (error) {
    if (error instanceof EngineError) {
      return res.status(400).json({ error: error.friendlyMessage, code: error.code });
    }
    throw error;
  }
}));

// Historial de coste por motor para decidir cuál conviene (Claude vs Gemini)
app.get('/api/usage', (req: Request, res: Response) => {
  const days = Number(req.query.days);
  const since = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : undefined;
  res.json({ summary: usageStore.summary(since), recent: usageStore.recent(Number(req.query.limit) || 50) });
});

app.post('/api/usage/reset', auth.requireAdmin, asyncRoute(async (req: Request, res: Response) => {
  await usageStore.reset();
  res.json({ message: 'Usage history reset' });
}));

// Chat conversacional con el tutor
app.post('/api/chat', asyncRoute(async (req: Request, res: Response) => {
  const progressStore = progressStores.forUser(currentUser(res).id);
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
  const { engine, resilience } = engines.current;
  const usageSessionId = isValidSessionId(sessionId) ? sessionId : null;
  const startedAt = Date.now();
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

    const result = await withResilience(
      engine.name,
      resilience,
      signal => engine.generateResponse({ systemPrompt, history: safeHistory, userMessage: message.trim(), signal }),
      clientGone.signal
    );
    const latencyMs = Date.now() - startedAt;
    const rawResponse = result.text;
    usageStore.record({ provider: engine.provider, model: result.model, sessionId: usageSessionId, userId: currentUser(res).id, latencyMs, usage: result.usage })
      .catch(err => console.error('Error registrando consumo:', err));

    engines.noteTurn(engine.provider);

    const { spokenText, spanishText, upgrades, diagnosticData, stepStatus, scores } = parseTutorResponse(rawResponse);

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
      if (safeMode === 'daily_session' && scores) {
        await progressStore.recordScores(scores, upgrades.length);
      }
    } catch (persistError) {
      console.error('Error persistiendo progreso:', persistError);
    }

    res.json({
      rawResponse,
      spokenText,
      spanishText,
      upgrades,
      // Solo en diagnóstico: advance = la respuesta cuenta y se pasa a la siguiente etapa; repeat = se repite
      stepStatus: safeMode === 'placement' ? (stepStatus ?? 'advance') : null,
      scores,
      levelProgress: progressStore.getLevelProgress(),
      // Si el nivel no se pudo guardar (CEFR inválido), el test NO se da por terminado: el usuario sigue en diagnóstico
      diagnosticData: diagnosticData?.testCompleted
        ? (savedLevel ? { ...diagnosticData, assignedLevel: savedLevel } : { ...diagnosticData, testCompleted: false })
        : diagnosticData,
      engineUsed: engine.name,
      usage: {
        provider: engine.provider,
        model: result.model,
        latencyMs,
        costUsd: result.usage?.costUsd ?? 0,
        costSource: result.usage?.costSource ?? null,
        session: usageSessionId ? usageStore.sessionCost(usageSessionId) : null
      }
    });
  } catch (error) {
    if (error instanceof EngineError && error.code === 'CANCELLED') {
      console.warn('Cliente desconectado: llamada al motor cancelada');
      return;
    }
    if (error instanceof EngineError) {
      console.error(`Error del motor en /api/chat: ${error.message}`);
      engines.noteTurn(engine.provider, error);
      // Los fallos también cuentan al comparar motores (fiabilidad)
      usageStore.record({ provider: engine.provider, model: engine.model, sessionId: usageSessionId, userId: currentUser(res).id, latencyMs: Date.now() - startedAt, errorCode: error.code })
        .catch(err => console.error('Error registrando consumo:', err));
      // 503 = servicio de IA no disponible; el frontend muestra friendlyMessage y el usuario puede reintentar
      return res.status(503).json({ error: error.friendlyMessage, code: error.code, retryable: error.retryable });
    }
    console.error('Error inesperado en /api/chat:', error);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.', code: 'INTERNAL' });
  }
}));

// Progreso del usuario: nivel CEFR, historial de sesiones y Native Upgrades acumulados
app.get('/api/user/progress', (req: Request, res: Response) => {
  const progressStore = progressStores.forUser(currentUser(res).id);
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
    levelProgress: progressStore.getLevelProgress(),
    nativeUpgrades: progress.nativeUpgrades,
    updatedAt: progress.updatedAt
  });
});

// Fijar el nivel a mano (sin test) o subir de nivel cuando el progreso lo permite
app.post('/api/user/level', asyncRoute(async (req: Request, res: Response) => {
  const progressStore = progressStores.forUser(currentUser(res).id);
  const current = progressStore.getLevelProgress();
  const levelUp = req.body?.source === 'level-up';
  if (levelUp && !(current?.readyToLevelUp && current.nextLevel === req.body?.level)) {
    return res.status(400).json({ error: 'Not ready to level up yet.', code: 'NOT_READY' });
  }
  const level = await progressStore.setLevel(req.body?.level, levelUp ? 'level-up' : 'manual');
  if (!level) {
    return res.status(400).json({ error: 'Level must be one of A1, A2, B1, B2, C1.', code: 'BAD_LEVEL' });
  }
  res.json({ cefrLevel: level, diagnostic: progressStore.getProgress().diagnostic, levelProgress: progressStore.getLevelProgress() });
}));

// scope 'level' = repetir solo el diagnóstico; 'all' (default) = borrar todo el progreso
app.post('/api/user/reset', asyncRoute(async (req: Request, res: Response) => {
  const progressStore = progressStores.forUser(currentUser(res).id);
  const scope: ResetScope = req.body?.scope === 'level' ? 'level' : 'all';
  await progressStore.reset(scope);
  res.json({ message: scope === 'level' ? 'Diagnostic reset' : 'All progress reset', scope });
}));

// Cierre de sesión (botón o navigator.sendBeacon al cerrar la pestaña)
// sendBeacon envía text/plain (tipo CORS-safelisted), por eso esta ruta acepta también texto
app.post('/api/user/session/end', express.text({ type: 'text/plain' }), asyncRoute(async (req: Request, res: Response) => {
  const progressStore = progressStores.forUser(currentUser(res).id);
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

  // rate=slow → versión lenta para practicar la pronunciación de una corrección
  const rate = req.query.rate === 'slow' ? '-30%' : undefined;
  let stream;
  try {
    stream = await ttsService.synthesizeToStream(text, rate);
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

// Voz → texto (whisper.cpp en el servidor). Cuerpo: WAV PCM 16 kHz mono
app.post('/api/voice/transcribe', express.raw({ type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'], limit: MAX_AUDIO_BYTES }),
  asyncRoute(async (req: Request, res: Response) => {
    if (!sttService.available) {
      return res.status(501).json({ error: 'Server-side transcription is not configured.', code: 'STT_UNAVAILABLE' });
    }
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
      return res.status(400).json({ error: 'Expected a WAV audio body.', code: 'BAD_AUDIO' });
    }
    const clientGone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) clientGone.abort();
    });
    const startedAt = Date.now();
    try {
      const text = await sttService.transcribe(audio, clientGone.signal);
      res.json({ text, latencyMs: Date.now() - startedAt });
    } catch (error) {
      if (clientGone.signal.aborted) return;
      console.error('Error transcribiendo audio:', error);
      res.status(502).json({ error: "Sorry, I couldn't process that recording. Try again or type your answer.", code: 'STT_FAILED' });
    }
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
  const { status } = engines.current;
  console.log(`👥 Usuarios: ${auth.userIds.join(', ') || '(ninguno — revisa AUTH_USERS)'}`);
  console.log(`🧠 Motor de IA activo: ${status.engineName}${status.warning ? ` — ${status.warning}` : ''}`);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PORT} ya está en uso (¿otro "pnpm dev" abierto?). Ciérralo o cambia PORT en packages/backend/.env`);
    process.exit(1);
  }
  throw error;
});
