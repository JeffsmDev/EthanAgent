import { AIEngine, EngineGenerateOptions } from './aiProvider.js';
import { EngineError, classifyHttpStatus } from './engineErrors.js';

export class LocalOllamaEngine implements AIEngine {
  name: string;
  readonly baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama3.1:latest') {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.name = `Local Ollama (${model})`;
  }

  async generateResponse(options: EngineGenerateOptions): Promise<string> {
    const messages = [
      { role: 'system', content: options.systemPrompt },
      ...options.history,
      { role: 'user', content: options.userMessage }
    ];

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: options.signal,
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.7
        }
      })
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new EngineError(classifyHttpStatus(res.status), `Ollama HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }

    const data = await res.json() as { message?: { content?: string } };
    const content = data?.message?.content;
    if (!content) {
      throw new EngineError('UPSTREAM', 'Ollama devolvió una respuesta vacía');
    }
    return content;
  }

  // Sondeo rápido para el estado en /api/health (no lanza)
  async isReachable(timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
