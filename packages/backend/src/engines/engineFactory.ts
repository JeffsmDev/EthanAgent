import path from 'node:path';
import { AIEngine, ProviderName } from './aiProvider.js';
import { ClaudeCliEngine, detectClaudeCli } from './claudeCliEngine.js';
import { GeminiEngine } from './geminiEngine.js';
import { LocalOllamaEngine } from './localOllamaEngine.js';
import { MockEngine } from './mockEngine.js';
import { EngineError, ResilienceOptions } from './engineErrors.js';
import { JsonFile } from '../store/jsonFile.js';

export type { ProviderName } from './aiProvider.js';

export interface EngineStatus {
  requestedProvider: string;
  activeProvider: ProviderName;
  engineName: string;
  model: string;
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
  claudeBin?: string;
  claudeModel?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  ollamaEnabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
}

// Opción que el usuario puede elegir en la UI (solo motores configurados en el servidor: nunca se envían keys)
export interface EngineOption {
  provider: ProviderName;
  label: string;
  model: string;
  available: boolean;
  reason: string | null;
}

const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
const DEFAULT_OLLAMA_MODEL = 'llama3.1:latest';

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
    claudeBin: env.CLAUDE_BIN,
    claudeModel: env.CLAUDE_MODEL,
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL,
    ollamaBaseUrl: env.OLLAMA_BASE_URL,
    ollamaModel: env.OLLAMA_MODEL,
    ollamaEnabled: env.OLLAMA_ENABLED === 'true',
    timeoutMs: env.AI_TIMEOUT_MS ? Number(env.AI_TIMEOUT_MS) : undefined,
    maxRetries: env.AI_MAX_RETRIES ? Number(env.AI_MAX_RETRIES) : undefined
  };
}

// La detección del CLI lanza un proceso: se hace una vez por binario
const claudeCliCache = new Map<string, string | null>();
function claudeCliVersion(bin: string): string | null {
  if (!claudeCliCache.has(bin)) {
    const version = detectClaudeCli(bin);
    claudeCliCache.set(bin, version);
    console.log(version ? `🤖 Claude Code CLI detectado: ${version}` : `⚠️ Claude Code CLI no encontrado (${bin})`);
  }
  return claudeCliCache.get(bin) ?? null;
}

function status(requested: string, engine: AIEngine, warning: string | null = null): EngineStatus {
  return {
    requestedProvider: requested,
    activeProvider: engine.provider,
    engineName: engine.name,
    model: engine.model,
    ready: true,
    warning
  };
}

function mockFallback(requested: string, warning: string | null): ResolvedEngine {
  const engine = new MockEngine();
  return { engine, resilience: { timeoutMs: 5000, maxRetries: 0 }, status: status(requested, engine, warning) };
}

export function resolveEngine(config: EngineConfig): ResolvedEngine {
  const requested = (config.provider || 'mock').trim().toLowerCase();
  const maxRetries = positiveInt(config.maxRetries, 2);

  if (requested === 'claude') {
    const bin = config.claudeBin?.trim() || 'claude';
    if (!claudeCliVersion(bin)) {
      return mockFallback(requested,
        'Demo mode: Claude Code CLI was not found on the server. Install it (or set CLAUDE_BIN) and restart, or pick another engine.');
    }
    const engine = new ClaudeCliEngine(bin, config.claudeModel?.trim() || DEFAULT_CLAUDE_MODEL);
    // Cada turno arranca un proceso (~2 s) + el modelo; un reintento como máximo porque cada uno consume cuota
    return {
      engine,
      resilience: { timeoutMs: positiveInt(config.timeoutMs, 90000), maxRetries: Math.min(maxRetries, 1) },
      status: status(requested, engine)
    };
  }

  if (requested === 'gemini') {
    if (!isUsableApiKey(config.geminiApiKey)) {
      console.warn('⚠️ AI_PROVIDER=gemini pero GEMINI_API_KEY no está configurada → arrancando en modo demo (mock)');
      return mockFallback(requested,
        'Demo mode: no Gemini API key configured. Ethan is using scripted answers. Add GEMINI_API_KEY to packages/backend/.env and restart the server to unlock the real tutor.');
    }
    const engine = new GeminiEngine(config.geminiApiKey.trim(), config.geminiModel?.trim() || DEFAULT_GEMINI_MODEL);
    return {
      engine,
      resilience: { timeoutMs: positiveInt(config.timeoutMs, 30000), maxRetries },
      status: status(requested, engine)
    };
  }

  if (requested === 'ollama' || requested === 'local') {
    // Los modelos locales en CPU pueden tardar bastante más que una API
    const engine = new LocalOllamaEngine(config.ollamaBaseUrl?.trim() || 'http://localhost:11434', config.ollamaModel?.trim() || DEFAULT_OLLAMA_MODEL);
    return {
      engine,
      resilience: { timeoutMs: positiveInt(config.timeoutMs, 120000), maxRetries: Math.min(maxRetries, 1) },
      status: status(requested, engine)
    };
  }

  if (requested !== 'mock') {
    console.warn(`⚠️ AI_PROVIDER="${requested}" no es válido (claude | gemini | ollama | mock) → usando mock`);
    return mockFallback(requested, `Demo mode: AI_PROVIDER="${requested}" is not valid. Use claude, gemini, ollama or mock in packages/backend/.env.`);
  }
  return mockFallback(requested, 'Demo mode: AI_PROVIDER=mock. Ethan is using scripted answers for testing.');
}

// Motores elegibles en caliente desde la UI. La elección se guarda en data/engine.json y sobrevive a reinicios
export class EngineRegistry {
  private readonly config: EngineConfig;
  private readonly settings: JsonFile<{ provider: ProviderName }>;
  current: ResolvedEngine;
  // Último fallo "de configuración" del motor activo (credencial caducada, cuota agotada…): se muestra en la UI
  // hasta que un turno vuelva a funcionar. Es la única señal fiable de que una sesión OAuth expiró
  private blockingFailure: { provider: ProviderName; message: string } | null = null;

  constructor(config: EngineConfig, dataDir: string) {
    this.config = config;
    this.settings = new JsonFile(path.join(dataDir, 'engine.json'));
    const saved = (this.settings.read() as { provider?: string } | null)?.provider;
    // Si el motor guardado dejó de estar disponible (p. ej. se quitó la key), manda el .env
    const savedOption = this.options().find(o => o.provider === saved && o.available);
    this.current = resolveEngine({ ...config, provider: savedOption ? saved : config.provider });
  }

  options(): EngineOption[] {
    const c = this.config;
    const claudeBin = c.claudeBin?.trim() || 'claude';
    const claudeOk = !!claudeCliVersion(claudeBin);
    const geminiOk = isUsableApiKey(c.geminiApiKey);
    const ollamaOk = !!c.ollamaEnabled || ['ollama', 'local'].includes((c.provider || '').toLowerCase());
    return [
      {
        provider: 'claude', label: 'Claude (your subscription)', model: c.claudeModel?.trim() || DEFAULT_CLAUDE_MODEL,
        available: claudeOk, reason: claudeOk ? null : 'Claude Code CLI not installed on the server'
      },
      {
        provider: 'gemini', label: 'Gemini (API)', model: c.geminiModel?.trim() || DEFAULT_GEMINI_MODEL,
        available: geminiOk, reason: geminiOk ? null : 'GEMINI_API_KEY not set'
      },
      {
        provider: 'ollama', label: 'Ollama (local)', model: c.ollamaModel?.trim() || DEFAULT_OLLAMA_MODEL,
        available: ollamaOk, reason: ollamaOk ? null : 'Set OLLAMA_ENABLED=true'
      },
      { provider: 'mock', label: 'Demo (scripted)', model: 'scripted', available: true, reason: null }
    ];
  }

  noteTurn(provider: ProviderName, error?: EngineError): void {
    if (!error) {
      if (this.blockingFailure?.provider === provider) this.blockingFailure = null;
      return;
    }
    if (['AUTH', 'QUOTA', 'NOT_CONFIGURED', 'MODEL_NOT_FOUND'].includes(error.code)) {
      this.blockingFailure = { provider, message: error.friendlyMessage };
    }
  }

  async currentStatus(): Promise<EngineStatus> {
    const status = await liveStatus(this.current);
    const failure = this.blockingFailure;
    return failure && failure.provider === status.activeProvider
      ? { ...status, ready: false, warning: failure.message }
      : status;
  }

  async select(provider: string): Promise<ResolvedEngine> {
    const option = this.options().find(o => o.provider === provider);
    if (!option) {
      throw new EngineError('BAD_REQUEST', `Motor desconocido: ${provider}`, `Unknown engine "${provider}".`);
    }
    if (!option.available) {
      throw new EngineError('NOT_CONFIGURED', `Motor no disponible: ${provider}`, `${option.label} is not available: ${option.reason}.`);
    }
    const next = resolveEngine({ ...this.config, provider });
    await this.settings.write({ provider: option.provider });
    this.current = next;
    this.blockingFailure = null;
    resetLiveStatusCache();
    console.log(`🔀 Motor cambiado a ${this.current.status.engineName}`);
    return this.current;
  }
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
    : { ...resolved.status, ready: false, warning: `Ollama is not responding at ${resolved.engine.baseUrl}. Start it with "ollama serve" (and pull the model) or pick another engine.` };
}

export function resetLiveStatusCache(): void {
  ollamaProbe = null;
  geminiProbe = null;
}
