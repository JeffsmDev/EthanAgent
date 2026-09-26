import { CostSource } from './aiProvider.js';

// Tarifas públicas de la API de Gemini en USD por millón de tokens (tier de pago, texto).
// Con una key del tier gratuito de AI Studio el coste real es $0: esto es el "equivalente" para comparar motores.
// Si Google cambia precios o usas otro modelo: GEMINI_PRICE_INPUT_PER_MTOK / GEMINI_PRICE_OUTPUT_PER_MTOK en el .env
const GEMINI_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 }
};

export function geminiPrice(model: string): { input: number; output: number } | null {
  const input = Number(process.env.GEMINI_PRICE_INPUT_PER_MTOK);
  const output = Number(process.env.GEMINI_PRICE_OUTPUT_PER_MTOK);
  if (input > 0 && output > 0) return { input, output };
  // "gemini-2.5-flash-001" → tarifa de "gemini-2.5-flash" (la clave más larga que sea prefijo)
  const key = Object.keys(GEMINI_PRICES)
    .filter(k => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? GEMINI_PRICES[key] : null;
}

export function estimateCost(
  price: { input: number; output: number } | null,
  inputTokens: number,
  outputTokens: number
): { costUsd: number; costSource: CostSource } {
  if (!price) return { costUsd: 0, costSource: 'unknown' };
  return {
    costUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
    costSource: 'estimated'
  };
}
