// Errores tipados de los motores IA + política única de timeout/reintentos

export type EngineErrorCode =
  | 'AUTH'             // API key inválida o sin permisos → no reintentar
  | 'MODEL_NOT_FOUND'  // modelo retirado o mal escrito → no reintentar
  | 'BAD_REQUEST'      // petición inválida → no reintentar
  | 'RATE_LIMIT'       // cuota / 429 → reintentar con backoff
  | 'TIMEOUT'          // el proveedor tardó demasiado → reintentar
  | 'NETWORK'          // DNS, conexión rechazada, reset → reintentar
  | 'UPSTREAM'         // 5xx del proveedor → reintentar
  | 'CANCELLED'        // el cliente cerró la conexión → no reintentar
  | 'QUOTA'            // cuota de la suscripción/plan agotada (se resetea en horas) → no reintentar
  | 'NOT_CONFIGURED';  // motor no instalado o sin credenciales en el servidor → no reintentar

const RETRYABLE: ReadonlySet<EngineErrorCode> = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'UPSTREAM']);

// Mensajes que ve el usuario en la UI (en inglés, como el resto de la interfaz)
const FRIENDLY: Record<EngineErrorCode, string> = {
  AUTH: "The AI provider rejected Ethan's credentials. Check the key/token in packages/backend/.env and restart the server.",
  MODEL_NOT_FOUND: 'The configured AI model is not available. Update the model name (GEMINI_MODEL / CLAUDE_MODEL / OLLAMA_MODEL) in the backend .env.',
  BAD_REQUEST: "Ethan couldn't process that message. Try rephrasing it.",
  RATE_LIMIT: 'Ethan is getting too many requests right now. Wait a few seconds and try again.',
  TIMEOUT: 'Ethan took too long to answer. Please try again.',
  NETWORK: "Ethan can't reach the AI service (network problem). Check the connection and try again.",
  UPSTREAM: 'The AI service is having trouble right now. Please try again in a moment.',
  CANCELLED: 'Request cancelled.',
  QUOTA: 'The usage quota for this AI engine is used up for now. Switch to another engine or try again later.',
  NOT_CONFIGURED: 'This AI engine is not set up on the server. Pick another engine or check the backend configuration.'
};

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;
  readonly friendlyMessage: string;

  constructor(code: EngineErrorCode, detail: string, friendlyMessage?: string) {
    super(`[${code}] ${detail}`);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.friendlyMessage = friendlyMessage || FRIENDLY[code];
  }
}

export function classifyHttpStatus(status: number): EngineErrorCode {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM';
  return 'BAD_REQUEST';
}

// Convierte cualquier error (fetch, SDK, abort) en EngineError
export function toEngineError(error: unknown, context: string): EngineError {
  if (error instanceof EngineError) return error;
  const err = error as { name?: string; message?: string; status?: number; cause?: { code?: string } };
  const message = err?.message || String(error);

  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new EngineError('TIMEOUT', `${context}: ${message}`);
  }
  if (typeof err?.status === 'number') {
    // Gemini responde 400 (no 401) cuando la API key es inválida
    if (err.status === 400 && /api key/i.test(message)) {
      return new EngineError('AUTH', `${context}: HTTP 400 ${message}`);
    }
    // 429 = límite por minuto (reintentable) o cuota diaria/de facturación agotada (reintentar no sirve)
    if (err.status === 429 && /per ?day|daily|billing|exceeded your current quota/i.test(message)) {
      return new EngineError('QUOTA', `${context}: HTTP 429 ${message}`,
        'The free daily quota for this AI engine is used up. Switch engine in the side panel or try again tomorrow.');
    }
    const code = classifyHttpStatus(err.status);
    return new EngineError(code, `${context}: HTTP ${err.status} ${message}`);
  }
  // fetch de Node lanza TypeError('fetch failed') con la causa real en error.cause
  if (err?.name === 'TypeError' || err?.cause?.code || /ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(message)) {
    return new EngineError('NETWORK', `${context}: ${message}${err?.cause?.code ? ` (${err.cause.code})` : ''}`);
  }
  return new EngineError('UPSTREAM', `${context}: ${message}`);
}

export interface ResilienceOptions {
  timeoutMs: number;
  maxRetries: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Ejecuta la llamada con timeout por intento y reintentos con backoff exponencial solo en errores transitorios.
// cancelSignal (desconexión del cliente) aborta el intento en curso y corta los reintentos: no se gastan tokens en vano
export async function withResilience<T>(
  label: string,
  options: ResilienceOptions,
  call: (signal: AbortSignal) => Promise<T>,
  cancelSignal?: AbortSignal
): Promise<T> {
  let lastError: EngineError | null = null;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    if (cancelSignal?.aborted) throw new EngineError('CANCELLED', `${label}: cliente desconectado`);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`timeout tras ${options.timeoutMs} ms`, 'TimeoutError')),
      options.timeoutMs
    );
    const onCancel = () => controller.abort(new DOMException('cliente desconectado', 'AbortError'));
    cancelSignal?.addEventListener('abort', onCancel, { once: true });
    try {
      return await call(controller.signal);
    } catch (error) {
      if (cancelSignal?.aborted) throw new EngineError('CANCELLED', `${label}: cliente desconectado`);
      lastError = toEngineError(error, label);
      if (!lastError.retryable || attempt === options.maxRetries) break;
      const backoff = (lastError.code === 'RATE_LIMIT' ? 2000 : 800) * 2 ** attempt;
      console.warn(`⚠️ ${lastError.message} — reintento ${attempt + 1}/${options.maxRetries} en ${backoff} ms`);
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
      cancelSignal?.removeEventListener('abort', onCancel);
    }
  }
  throw lastError;
}
