import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { Readable } from 'node:stream';

const CONNECT_TIMEOUT_MS = 10000;

// msedge-tts inserta el texto tal cual dentro del SSML: sin escapar, "Q&A" rompe la síntesis y permite inyectar SSML
function escapeSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout tras ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class EdgeTtsService {
  private voice: string;

  constructor(voice: string = 'en-US-ChristopherNeural') {
    this.voice = voice;
  }

  // Conecta (con un reintento) y devuelve el stream de audio. El WebSocket se cierra al terminar el stream
  async synthesizeToStream(text: string, rate?: string): Promise<Readable> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const tts = new MsEdgeTTS();
      try {
        await withTimeout(tts.setMetadata(this.voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3), CONNECT_TIMEOUT_MS, 'Edge TTS');
        const { audioStream } = tts.toStream(escapeSsml(text), rate ? { rate } : undefined);
        let closed = false;
        const release = () => {
          if (closed) return;
          closed = true;
          tts.close();
        };
        audioStream.once('end', release);
        audioStream.once('close', release);
        audioStream.once('error', release);
        return audioStream;
      } catch (error) {
        lastError = error;
        tts.close();
      }
    }
    throw lastError;
  }
}
