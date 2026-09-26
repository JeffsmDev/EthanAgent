import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Voz → texto en el propio servidor con whisper.cpp. Funciona en cualquier navegador (Brave bloquea la Web Speech
// API) y no envía la voz del usuario a terceros. Conserva los errores gramaticales tal cual: clave para el tutor.
// El frontend envía WAV PCM 16 kHz mono, el formato nativo de whisper.cpp (no hace falta ffmpeg).

const TIMEOUT_MS = 45000;

export class SttUnavailableError extends Error {}

export class WhisperSttService {
  private readonly bin: string;
  private readonly modelPath: string;
  private readonly threads: number;
  readonly available: boolean;
  private readonly workDir: string;

  constructor(bin?: string, modelPath?: string, threads?: number) {
    this.bin = bin || 'whisper-cli';
    this.modelPath = modelPath || '';
    this.threads = threads && threads > 0 ? threads : Math.max(1, Math.min(4, os.cpus().length));
    this.workDir = path.join(os.tmpdir(), 'ethan-stt');
    // Disponible solo si hay modelo configurado y existe (en Docker lo aporta la imagen; en local normalmente no)
    this.available = !!this.modelPath && fs.existsSync(this.modelPath) && (path.isAbsolute(this.bin) ? fs.existsSync(this.bin) : true);
    if (this.available) fs.mkdirSync(this.workDir, { recursive: true });
    console.log(this.available
      ? `🎧 Transcripción en servidor activa (whisper.cpp, ${this.threads} hilos)`
      : '🎧 Transcripción en servidor no configurada: el navegador usará su reconocimiento de voz');
  }

  async transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
    if (!this.available) throw new SttUnavailableError('whisper.cpp no está configurado');
    const file = path.join(this.workDir, `${randomUUID()}.wav`);
    await fs.promises.writeFile(file, wav);
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(this.bin, ['-m', this.modelPath, '-f', file, '-l', 'en', '-nt', '-np', '-t', String(this.threads)], {
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
        let out = '';
        let err = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`whisper-cli exit ${code}: ${err.slice(-300)}`))));
      });
      return cleanTranscript(stdout);
    } finally {
      fs.promises.unlink(file).catch(() => { /* ya no existe */ });
    }
  }
}

// Whisper marca el silencio/ruido con etiquetas ([BLANK_AUDIO], (music)…): no son habla del usuario
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
