export type ProviderName = 'claude' | 'gemini' | 'ollama' | 'mock';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface EngineGenerateOptions {
  systemPrompt: string;
  history: ChatMessage[];
  userMessage: string;
  temperature?: number;
  // Lo aporta withResilience: cada intento tiene su propio timeout
  signal?: AbortSignal;
}

// reported = el proveedor informa el coste (Claude Code); estimated = tokens × tarifa pública (Gemini);
// free = sin coste monetario (Ollama local); unknown = modelo sin tarifa conocida
export type CostSource = 'reported' | 'estimated' | 'free' | 'unknown';

export interface EngineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costSource: CostSource;
}

export interface EngineResult {
  text: string;
  model: string;
  // null = el motor no mide consumo (mock)
  usage: EngineUsage | null;
}

export interface AIEngine {
  name: string;
  provider: ProviderName;
  model: string;
  generateResponse(options: EngineGenerateOptions): Promise<EngineResult>;
}
