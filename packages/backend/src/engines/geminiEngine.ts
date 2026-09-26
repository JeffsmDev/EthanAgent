import { GoogleGenAI } from '@google/genai';
import { AIEngine, EngineGenerateOptions, EngineResult } from './aiProvider.js';
import { EngineError, toEngineError } from './engineErrors.js';
import { estimateCost, geminiPrice } from './pricing.js';

export class GeminiEngine implements AIEngine {
  readonly provider = 'gemini' as const;
  name: string;
  private ai: GoogleGenAI;
  private modelName: string;

  get model(): string {
    return this.modelName;
  }

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash') {
    // Reintentos del SDK desactivados (por defecto hace 5): la política vive en withResilience
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    this.modelName = modelName;
    this.name = `Gemini (${modelName})`;
  }

  async generateResponse(options: EngineGenerateOptions): Promise<EngineResult> {
    const contents = options.history
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    contents.push({
      role: 'user',
      parts: [{ text: options.userMessage }]
    });

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents,
      config: {
        systemInstruction: options.systemPrompt,
        temperature: options.temperature ?? 0.7,
        abortSignal: options.signal
      }
    });

    if (!response.text) {
      // Respuesta vacía = bloqueada por filtros de seguridad o cortada; reintentar no suele ayudar
      const reason = response.candidates?.[0]?.finishReason || 'EMPTY';
      throw new EngineError('BAD_REQUEST', `Gemini devolvió respuesta vacía (${reason})`,
        "Ethan couldn't answer that one. Try saying it a different way.");
    }
    // Los tokens de "thinking" (modelos 2.5) se facturan como salida
    // promptTokenCount ya incluye los cacheados: se separan para no contarlos dos veces (mismo criterio que Claude)
    const meta = response.usageMetadata;
    const cachedTokens = meta?.cachedContentTokenCount ?? 0;
    const promptTokens = meta?.promptTokenCount ?? 0;
    const outputTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0);
    return {
      text: response.text,
      model: this.modelName,
      usage: {
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        outputTokens,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
        // Estimación conservadora: los tokens cacheados se cobran a tarifa completa
        ...estimateCost(geminiPrice(this.modelName), promptTokens, outputTokens)
      }
    };
  }

  // Verifica key y modelo sin gastar tokens (detecta API key inválida o modelo retirado por Google)
  async verify(timeoutMs = 5000): Promise<EngineError | null> {
    try {
      await this.ai.models.get({ model: this.modelName, config: { abortSignal: AbortSignal.timeout(timeoutMs) } });
      return null;
    } catch (error) {
      return toEngineError(error, this.name);
    }
  }
}
