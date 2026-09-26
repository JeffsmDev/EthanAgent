import { AIEngine } from './aiProvider.js';
import { GeminiEngine } from './geminiEngine.js';
import { LocalOllamaEngine } from './localOllamaEngine.js';
import { MockEngine } from './mockEngine.js';
import { EngineError, ResilienceOptions } from './engineErrors.js';

export type ProviderName = 'gemini' | 'ollama' | 'mock';

export interface EngineStatus {
  requestedProvider: string;
  activeProvider: ProviderName;
  engineName: string;
  ready: boolean;
  // Aviso amigable para mostrar en la UI (API key ausente, Ollama caído, provider inválido…)
  warning: string | null;
}

export interface ResolvedEngine {
  engine: AIEngine;
  status: EngineStatus;
  resilience: ResilienceOptions;
}

export interface EngineConfig {
  provider?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

// Valores de ejemplo que la gente deja en el .env sin cambiar
const PLACEHOLDER_KEYS = /^(|tu_api_key_aqui|your[_-]?api[_-]?key.*|changeme|xxx+|<.*>)$/i;

export function isUsableApiKey(key: string | undefined): key is string {
  return typeof key === 'string' && !PLACEHOLDER_KEYS.test(key.trim());
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? Math.floor(value as number) : fallback;
}

export function engineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return {
    provider: env.AI_PROVIDER,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS ? Number(env.AI_TIMEOUT_MS) : undefined,
    maxRetries: env.AI_MAX_RETRIES ? Number(env.AI_MAX_RETRIES) : undefined
  };
}

function mockFallback(requested: string, warning: string | null, resilience: ResilienceOptions): ResolvedEngine {
  const engine = new MockEngine();
  return {
    engine,
    resilience,
    status: { requestedProvider: requested, activeProvider: 'mock', engineName: engine.name, ready: true, warning }
  };
}

export function resolveEngine(config: EngineConfig): ResolvedEngine {
  const requested = (config.provider || 'mock').trim().toLowerCase();
  const maxRetries = positiveInt(config.maxRetries, 2);

  if (requested === 'gemini') {
    const resilience = { timeoutMs: positiveInt(config.timeoutMs, 30000), maxRetries };
    if (!isUsableApiKey(config.geminiApiKey)) {
      console.warn('⚠️ AI_PROVIDER=gemini pero GEMINI_API_KEY no está configurada → arrancando en modo demo (mock)');
      return mockFallback(requested,
        'Demo mode: no Gemini API key configured. Ethan is using scripted answers. Add GEMINI_API_KEY to packages/backend/.env and restart the server to unlock the real tutor.',
        resilience);
    }
    const engine = new GeminiEngine(config.geminiApiKey.trim(), config.geminiModel?.trim() || 'gemini-2.0-flash');
    return {
      engine,
      resilience,
      status: { requestedProvider: requested, activeProvider: 'gemini', engineName: engine.name, ready: true, warning: null }
    };
  }

  if (requested === 'ollama' || requested === 'local') {
    // Los modelos locales en CPU pueden tardar bastante más que una API
    const resilience = { timeoutMs: positiveInt(config.timeoutMs, 120000), maxRetries: Math.min(maxRetries, 1) };
    const engine = new LocalOllamaEngine(config.ollamaBaseUrl?.trim() || 'http://localhost:11434', config.ollamaModel?.trim() || 'llama3.1:latest');
    return {
      engine,
      resilience,
      status: { requestedProvider: requested, activeProvider: 'ollama', engineName: engine.name, ready: true, warning: null }
    };
  }

  const resilience = { timeoutMs: 5000, maxRetries: 0 };
  if (requested !== 'mock') {
    console.warn(`⚠️ AI_PROVIDER="${requested}" no es válido (gemini | ollama | mock) → usando mock`);
    return mockFallback(requested, `Demo mode: AI_PROVIDER="${requested}" is not valid. Use gemini, ollama or mock in packages/backend/.env.`, resilience);
  }
  return mockFallback(requested, 'Demo mode: AI_PROVIDER=mock. Ethan is using scripted answers for testing.', resilience);
}

// Estado en vivo: Ollama → ¿responde el servidor local? (cache 15 s). Gemini → ¿key y modelo válidos? (cache 5 min)
let ollamaProbe: { at: number; reachable: boolean } | null = null;
// Ligada a la instancia: un verify() lento del motor anterior no contamina el estado tras un cambio en caliente
let geminiProbe: { engine: GeminiEngine; at: number; error: EngineError | null } | null = null;

export async function liveStatus(resolved: ResolvedEngine): Promise<EngineStatus> {
  if (resolved.engine instanceof GeminiEngine) {
    const engine = resolved.engine;
    if (!geminiProbe || geminiProbe.engine !== engine || Date.now() - geminiProbe.at > 300000) {
      const error = await engine.verify();
      // Un fallo transitorio (red/timeout) no se cachea: se vuelve a comprobar en el siguiente health
      geminiProbe = error?.retryable ? null : { engine, at: Date.now(), error };
      if (error) return { ...resolved.status, ready: false, warning: error.friendlyMessage };
    }
    return geminiProbe?.error
      ? { ...resolved.status, ready: false, warning: geminiProbe.error.friendlyMessage }
      : resolved.status;
  }
  if (!(resolved.engine instanceof LocalOllamaEngine)) return resolved.status;
  if (!ollamaProbe || Date.now() - ollamaProbe.at > 15000) {
    ollamaProbe = { at: Date.now(), reachable: await resolved.engine.isReachable() };
  }
  return ollamaProbe.reachable
    ? resolved.status
    : { ...resolved.status, ready: false, warning: `Ollama is not responding at ${resolved.engine.baseUrl}. Start it with "ollama serve" (and pull the model) or switch AI_PROVIDER in the backend .env.` };
}

export function resetLiveStatusCache(): void {
  ollamaProbe = null;
  geminiProbe = null;
}
