import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIEngine, ChatMessage, EngineGenerateOptions, EngineResult } from './aiProvider.js';
import { EngineError } from './engineErrors.js';

// Motor que usa la suscripción de Claude vía Claude Code en modo desatendido (`claude -p`).
// Autenticación: sesión iniciada del usuario del sistema (dev) o CLAUDE_CODE_OAUTH_TOKEN de `claude setup-token` (servidor).
// Cada turno es un proceso aislado: sin herramientas, sin MCP, sin CLAUDE.md, sin guardar sesión.

const MAX_OUTPUT_BYTES = 1_000_000;

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ¿Está el CLI instalado y ejecutable? (se comprueba una vez al arrancar)
export function detectClaudeCli(bin: string): string | null {
  try {
    const result = spawnSync(bin, ['--version'], { timeout: 15000, encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

// El historial va como transcripción dentro del mensaje: `claude -p` no admite turnos de asistente previos
function buildTurnPrompt(history: ChatMessage[], userMessage: string): string {
  const transcript = history
    .filter(m => m.role !== 'system')
    .map(m => `${m.role === 'assistant' ? 'Ethan' : 'Student'}: ${m.content}`)
    .join('\n\n');
  return [
    transcript ? `Conversation so far:\n\n${transcript}\n\n---` : '',
    `Student's new message:\n${userMessage}`,
    '',
    'Reply now as Ethan, following your system instructions and response format exactly.'
  ].filter(Boolean).join('\n');
}

// Clasifica los errores que el CLI escribe en texto (no hay códigos HTTP)
function classifyCliError(detail: string): EngineError {
  const text = detail.slice(0, 500);
  if (/usage limit|limit reached|out of (extra )?usage|credit balance/i.test(text)) {
    return new EngineError('QUOTA', `Claude Code: ${text}`,
      'Your Claude usage limit is reached for now. Switch Ethan to Gemini in the side panel or try again later.');
  }
  if (/log ?in|logged out|oauth|authenticat|invalid api key|unauthorized|401|token (has )?expired/i.test(text)) {
    return new EngineError('AUTH', `Claude Code: ${text}`,
      'The Claude session on the server is not valid. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in the backend .env.');
  }
  if (/model.*(not found|not available|invalid)|unknown model/i.test(text)) {
    return new EngineError('MODEL_NOT_FOUND', `Claude Code: ${text}`);
  }
  if (/rate.?limit|429|overloaded|529/i.test(text)) {
    return new EngineError('RATE_LIMIT', `Claude Code: ${text}`);
  }
  if (/ECONN|ENOTFOUND|EAI_AGAIN|network|socket|fetch failed/i.test(text)) {
    return new EngineError('NETWORK', `Claude Code: ${text}`);
  }
  return new EngineError('UPSTREAM', `Claude Code: ${text}`);
}

export class ClaudeCliEngine implements AIEngine {
  readonly provider = 'claude' as const;
  readonly name: string;
  readonly model: string;
  private readonly bin: string;
  private readonly workDir: string;

  constructor(bin: string, model: string) {
    this.bin = bin;
    this.model = model;
    this.name = `Claude Code (${model})`;
    // Directorio vacío propio: el CLI no debe descubrir CLAUDE.md ni settings de ningún proyecto
    this.workDir = path.join(os.tmpdir(), 'ethan-claude');
    fs.mkdirSync(this.workDir, { recursive: true });
  }

  // El system prompt va por archivo (evita límites de longitud de argumentos). Uno por llamada y se borra al
  // terminar: el prompt cambia casi cada turno (minutos transcurridos, memoria del alumno)
  async generateResponse(options: EngineGenerateOptions): Promise<EngineResult> {
    const promptFile = path.join(this.workDir, `system-${randomUUID()}.txt`);
    await fs.promises.writeFile(promptFile, options.systemPrompt, 'utf8');
    try {
      return await this.run(options, promptFile);
    } finally {
      fs.promises.unlink(promptFile).catch(() => { /* ya no existe */ });
    }
  }

  private async run(options: EngineGenerateOptions, promptFile: string): Promise<EngineResult> {
    const args = [
      '-p',
      '--model', this.model,
      '--system-prompt-file', promptFile,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--output-format', 'json'
    ];

    const { stdout, stderr, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: this.workDir,
        // Sin razonamiento extendido por defecto: en conversación de voz resta ~2-3 s y tokens por turno
        env: { ...process.env, MAX_THINKING_TOKENS: process.env.CLAUDE_MAX_THINKING_TOKENS ?? '0' },
        signal: options.signal,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        if (out.length > MAX_OUTPUT_BYTES) child.kill();
      });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          reject(new EngineError('NOT_CONFIGURED', `Claude Code CLI no encontrado (${this.bin})`,
            'Claude Code is not installed on the server. Switch Ethan to another engine.'));
        } else {
          // AbortError (timeout/cancelación) se reenvía tal cual para que withResilience lo clasifique
          reject(error);
        }
      });
      child.on('close', code => resolve({ stdout: out, stderr: err, exitCode: code }));
      child.stdin.end(buildTurnPrompt(options.history, options.userMessage));
    });

    let parsed: ClaudeJsonResult | null = null;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      parsed = null;
    }

    if (!parsed || parsed.is_error || exitCode !== 0) {
      throw classifyCliError(parsed?.result || stderr || stdout || `exit code ${exitCode}`);
    }
    if (!parsed.result?.trim()) {
      throw new EngineError('UPSTREAM', `Claude Code devolvió una respuesta vacía (${parsed.subtype || 'sin subtype'})`);
    }

    return {
      text: parsed.result,
      model: this.model,
      usage: {
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
        // Con suscripción no se cobra por turno: es el coste equivalente en la API que reporta el propio CLI
        costUsd: parsed.total_cost_usd ?? 0,
        costSource: 'reported'
      }
    };
  }
}
