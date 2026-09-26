import { GoogleGenAI } from '@google/genai';
import { AIEngine, EngineGenerateOptions } from './aiProvider.js';
import { EngineError, toEngineError } from './engineErrors.js';

export class GeminiEngine implements AIEngine {
  name: string;
  private ai: GoogleGenAI;
  private modelName: string;

  constructor(apiKey: string, modelName: string = 'gemini-2.0-flash') {
    // Reintentos del SDK desactivados (por defecto hace 5): la política vive en withResilience
    this.ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
    this.modelName = modelName;
    this.name = `Gemini (${modelName})`;
  }

  async generateResponse(options: EngineGenerateOptions): Promise<string> {
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
    return response.text;
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
