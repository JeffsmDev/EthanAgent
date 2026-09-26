import { useState, useEffect, useRef } from 'react';

// Tipado para Web Speech API
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  }
}

// Traduce los códigos de error de la Web Speech API a un mensaje útil para el usuario
function describeSpeechError(code: string): string | null {
  switch (code) {
    case 'network':
      return "Your browser's speech recognition service is unavailable (Brave blocks it). Use Chrome/Edge, or type your answer.";
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow it in the address bar (🔒 icon) and try again.';
    case 'audio-capture':
      return 'No microphone was found. Check that one is connected.';
    case 'no-speech':
      return "I didn't hear anything — try again a bit closer to the mic.";
    case 'aborted':
      return null;
    default:
      return `Speech recognition failed (${code}). You can type your answer instead.`;
  }
}

export function useSpeechRecognition(onResultCallback: (text: string) => void, onErrorCallback?: (message: string) => void) {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [isSupported, setIsSupported] = useState(true);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  // El callback cambia en cada render del padre; guardarlo en un ref evita recrear (y abortar) el reconocimiento
  const onResultRef = useRef(onResultCallback);
  onResultRef.current = onResultCallback;
  const onErrorRef = useRef(onErrorCallback);
  onErrorRef.current = onErrorCallback;

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US'; // Escucha inglés nativo

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let current = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        current += event.results[i][0].transcript;
      }
      setTranscript(current);

      // Si es el resultado final
      if (event.results[event.results.length - 1].isFinal) {
        onResultRef.current(current.trim());
        setTranscript('');
      }
    };

    recognition.onerror = (event: any) => {
      console.warn('Speech recognition error:', event.error);
      setIsListening(false);
      const message = describeSpeechError(String(event.error));
      if (message) onErrorRef.current?.(message);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.abort();
    };
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) return;

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      setTranscript('');
      try {
        recognitionRef.current.start();
        setIsListening(true);
      } catch (err) {
        console.error('Failed to start speech recognition:', err);
      }
    }
  };

  return {
    isListening,
    transcript,
    isSupported,
    toggleListening
  };
}
