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

export interface AIEngine {
  name: string;
  generateResponse(options: EngineGenerateOptions): Promise<string>;
}
