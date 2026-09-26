import { useCallback, useRef, useState } from 'react';

// Graba el micrófono con Web Audio y devuelve un WAV PCM 16 kHz mono (formato nativo de whisper.cpp).
// Para solo tras ~1,5 s de silencio una vez que el usuario habló, o al pulsar de nuevo el botón.

const TARGET_RATE = 16000;
const SILENCE_AFTER_SPEECH_MS = 1500;
const NO_SPEECH_TIMEOUT_MS = 10000;
const MAX_RECORDING_MS = 60000;

export type RecorderResult =
  | { kind: 'audio'; wav: Blob; durationMs: number }
  | { kind: 'no-speech' };

// Promedia muestras para bajar de la frecuencia del micrófono (44,1/48 kHz) a 16 kHz
function downsample(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_RATE) return input;
  const ratio = inputRate / TARGET_RATE;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    output[i] = sum / Math.max(1, end - start);
  }
  return output;
}

function encodeWav(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export function useVoiceRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  const sessionRef = useRef<{
    stream: MediaStream;
    context: AudioContext;
    processor: ScriptProcessorNode;
    chunks: Float32Array[];
    startedAt: number;
    finish: (result: RecorderResult) => void;
  } | null>(null);

  const cleanup = () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    session.processor.disconnect();
    session.stream.getTracks().forEach(track => track.stop());
    session.context.close().catch(() => { /* ya cerrado */ });
    setIsRecording(false);
  };

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const total = session.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(total);
    let offset = 0;
    for (const chunk of session.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const rate = session.context.sampleRate;
    const finish = session.finish;
    const durationMs = Date.now() - session.startedAt;
    cleanup();
    finish({ kind: 'audio', wav: encodeWav(downsample(merged, rate)), durationMs });
  }, []);

  // Resuelve cuando termina la grabación (silencio, botón o límite). Lanza si no hay permiso de micrófono
  const record = useCallback(async (): Promise<RecorderResult> => {
    if (sessionRef.current) throw new Error('already-recording');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioCtx();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);

    return new Promise<RecorderResult>(resolve => {
      let noiseFloor = 0;
      let calibrationFrames = 0;
      let heardSpeech = false;
      let lastVoiceAt = Date.now();
      const startedAt = Date.now();

      sessionRef.current = { stream, context, processor, chunks: [], startedAt, finish: resolve };
      setIsRecording(true);

      processor.onaudioprocess = event => {
        const session = sessionRef.current;
        if (!session) return;
        const data = new Float32Array(event.inputBuffer.getChannelData(0));
        session.chunks.push(data);

        // Detección de voz por energía, con umbral adaptado al ruido de fondo de los primeros ~0,3 s
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (calibrationFrames < 3) {
          noiseFloor = Math.max(noiseFloor, rms);
          calibrationFrames++;
          return;
        }
        // Acotado: si el usuario empieza a hablar al instante, la "calibración" mide su voz y no debe
        // dejar el umbral por encima de ella
        const threshold = Math.min(0.04, Math.max(0.015, noiseFloor * 2.5));
        const now = Date.now();
        if (rms > threshold) {
          heardSpeech = true;
          lastVoiceAt = now;
        }

        if (heardSpeech && now - lastVoiceAt > SILENCE_AFTER_SPEECH_MS) {
          stop();
        } else if (!heardSpeech && now - startedAt > NO_SPEECH_TIMEOUT_MS) {
          cleanup();
          resolve({ kind: 'no-speech' });
        } else if (now - startedAt > MAX_RECORDING_MS) {
          stop();
        }
      };

      source.connect(processor);
      // ScriptProcessor solo procesa si está conectado al destino (su salida es silencio)
      processor.connect(context.destination);
    });
  }, [stop]);

  const cancel = useCallback(() => {
    const finish = sessionRef.current?.finish;
    cleanup();
    finish?.({ kind: 'no-speech' });
  }, []);

  return { isRecording, record, stop, cancel };
}
