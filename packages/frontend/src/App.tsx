import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  Send,
  Volume2,
  Award,
  Clock,
  Sparkles,
  CheckCircle2,
  RotateCcw,
  Zap,
  VolumeX,
  TrendingUp,
  Square,
  Trash2,
  AlertTriangle,
  X
} from 'lucide-react';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';

interface NativeUpgrade {
  original: string;
  native: string;
  tip: string;
}

interface Message {
  id: string;
  sender: 'user' | 'tutor' | 'system';
  text: string;
  spokenText?: string;
  upgrades?: NativeUpgrade[];
}

interface DiagnosticResult {
  testCompleted?: boolean;
  assignedLevel: string;
  strengths: string[];
  priorityAreas: string[];
  firstSessionRecommendedTheme: string;
}

interface WeakPoint extends NativeUpgrade {
  count: number;
}

interface UserProgress {
  cefrLevel: string | null;
  diagnostic: DiagnosticResult | null;
  stats: { totalSessions: number; totalMinutes: number; totalUpgrades: number };
  sessions: { id: string; topic: string; startedAt: string; durationMinutes: number }[];
  weakPoints: WeakPoint[];
}

type Mode = 'placement' | 'daily_session';

interface EngineStatus {
  activeProvider: string;
  engineName: string;
  ready: boolean;
  warning: string | null;
}

const PLACEMENT_WELCOME: Message = {
  id: 'welcome',
  sender: 'tutor',
  text: "Hey! Welcome aboard! I'm Ethan, your native English coach. Traditional classes waste time on dry theory—my goal is to get you speaking with natural flow, rhythm, and confidence. Let's start with a quick 4-step diagnostic to map your real baseline. Tell me a bit about yourself: what do you do, and what brings you here today?",
  spokenText: "Hey! Welcome aboard! I'm Ethan, your native English coach. Let's start with a quick 4-step diagnostic to map your real baseline. Tell me a bit about yourself: what do you do, and what brings you here today?"
};

function buildReturningWelcome(progress: UserProgress): Message {
  const theme = progress.diagnostic?.firstSessionRecommendedTheme;
  const weak = progress.weakPoints[0];
  const text = [
    `Welcome back! You're working at ${progress.cefrLevel} level, so let's pick up right where we left off.`,
    weak
      ? `${weak.count > 1 ? `"${weak.original}" has come up ${weak.count} times` : `Last time, "${weak.original}" came up`}—keep an ear out for "${weak.native}" today.`
      : '',
    theme ? `Today's focus: ${theme}. So, how's your day been so far?` : "So, how's your day been so far?"
  ].filter(Boolean).join(' ');
  return { id: 'welcome-back', sender: 'tutor', text, spokenText: text };
}

// crypto.randomUUID solo existe en contextos seguros (https/localhost); en http por IP hay que tener respaldo
function newSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [isSpeakingAudio, setIsSpeakingAudio] = useState(false);
  const [mode, setMode] = useState<Mode>('placement');
  const [testStep, setTestStep] = useState(1);
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult | null>(null);
  const [progress, setProgress] = useState<UserProgress | null>(null);
  const [activeEngine, setActiveEngine] = useState('Detectando...');
  const [engineWarning, setEngineWarning] = useState<string | null>(null);
  const [practiceSeconds, setPracticeSeconds] = useState(0);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef(newSessionId());
  const sessionTurnsRef = useRef(0);
  const practiceSecondsRef = useRef(0);
  practiceSecondsRef.current = practiceSeconds;

  // Timer para sesión diaria
  useEffect(() => {
    const timer = setInterval(() => {
      setPracticeSeconds(prev => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const loadProgress = async (): Promise<UserProgress | null> => {
    try {
      const res = await fetch('/api/user/progress');
      if (!res.ok) return null;
      const data: UserProgress = await res.json();
      setProgress(data);
      return data;
    } catch {
      return null;
    }
  };

  // Arranque: motor activo + progreso guardado (si ya hay nivel, no se repite el diagnóstico)
  useEffect(() => {
    fetch('/api/health')
      .then(res => res.json())
      .then((data: { activeEngine: string; engine?: EngineStatus }) => {
        setActiveEngine(data.activeEngine);
        setEngineWarning(data.engine?.warning ?? null);
      })
      .catch(() => {
        setActiveEngine('Offline');
        setEngineWarning("Can't reach Ethan's server. Make sure the backend is running (pnpm dev) and reload the page.");
      });

    loadProgress().then(saved => {
      if (saved?.cefrLevel && saved.diagnostic) {
        setDiagnostic(saved.diagnostic);
        setMode('daily_session');
        setMessages([buildReturningWelcome(saved)]);
      } else {
        setMessages([PLACEMENT_WELCOME]);
      }
      setBooting(false);
    });
  }, []);

  // Al cerrar/ocultar la pestaña se cierra la sesión con sendBeacon (sobrevive a la descarga de la página)
  useEffect(() => {
    const onPageHide = () => {
      if (sessionTurnsRef.current === 0) return;
      const payload = JSON.stringify({
        sessionId: sessionIdRef.current,
        durationMinutes: Math.round(practiceSecondsRef.current / 60)
      });
      // String → text/plain (CORS-safelisted); un Blob application/json puede ser rechazado por el navegador
      navigator.sendBeacon?.('/api/user/session/end', payload);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Hook Web Speech API
  const { isListening, transcript, toggleListening } = useSpeechRecognition((recognizedText) => {
    if (recognizedText) {
      handleSendMessage(recognizedText);
    }
  });

  // Respaldo si Edge TTS no está disponible: voz nativa del navegador (peor calidad, pero Ethan no se queda mudo)
  const speakWithBrowser = (text: string) => {
    if (!('speechSynthesis' in window)) {
      setIsSpeakingAudio(false);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.onend = () => setIsSpeakingAudio(false);
    utterance.onerror = () => setIsSpeakingAudio(false);
    window.speechSynthesis.cancel();
    setIsSpeakingAudio(true);
    window.speechSynthesis.speak(utterance);
  };

  // Sintetizar y reproducir audio
  const playAudio = (text: string) => {
    if (!text) return;
    if (audioRef.current) {
      audioRef.current.pause();
    }
    window.speechSynthesis?.cancel();
    const audioUrl = `/api/voice/synthesize?text=${encodeURIComponent(text)}`;
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    setIsSpeakingAudio(true);
    audio.onended = () => setIsSpeakingAudio(false);
    audio.onerror = () => {
      // Solo si este audio sigue siendo el actual (no uno que el usuario ya reemplazó)
      if (audioRef.current !== audio) return;
      console.warn('Edge TTS no disponible, usando la voz del navegador');
      speakWithBrowser(text);
    };
    audio.play().catch(e => {
      // NotAllowedError = autoplay bloqueado. Los fallos de la fuente (502) los maneja onerror con el fallback;
      // apagar aquí la animación la desincronizaría de la voz del navegador
      console.warn('Audio play blocked or error:', e);
      if (e?.name === 'NotAllowedError' && audioRef.current === audio) {
        setIsSpeakingAudio(false);
      }
    });
  };

  const stopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    window.speechSynthesis?.cancel();
    setIsSpeakingAudio(false);
  };

  const addSystemMessage = (text: string) => {
    setMessages(prev => [...prev, { id: `sys-${Date.now()}`, sender: 'system', text }]);
  };

  // Cierra la sesión actual en el backend y arranca una nueva (id nuevo + timer a cero)
  const rotateSession = async (): Promise<number | null> => {
    let savedMinutes: number | null = null;
    if (sessionTurnsRef.current > 0) {
      try {
        const res = await fetch('/api/user/session/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            durationMinutes: Math.round(practiceSecondsRef.current / 60)
          })
        });
        const data = await res.json();
        savedMinutes = data.session?.durationMinutes ?? null;
      } catch (err) {
        console.warn('No se pudo cerrar la sesión:', err);
      }
    }
    sessionIdRef.current = newSessionId();
    sessionTurnsRef.current = 0;
    setPracticeSeconds(0);
    return savedMinutes;
  };

  const handleEndSession = async () => {
    if (sessionTurnsRef.current === 0) {
      addSystemMessage('Nothing to save yet — say something to Ethan first!');
      return;
    }
    stopAudio();
    const minutes = await rotateSession();
    await loadProgress();
    addSystemMessage(`✅ Session saved${minutes !== null ? ` (${minutes} min)` : ''}. A new session starts now.`);
  };

  const restartPlacement = async (scope: 'level' | 'all') => {
    const question = scope === 'level'
      ? 'Retake the diagnostic test? Your session history and Native Upgrades will be kept.'
      : 'Delete ALL progress (level, sessions and Native Upgrades)? This cannot be undone.';
    if (!window.confirm(question)) return;

    stopAudio();
    await rotateSession();
    try {
      await fetch('/api/user/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope })
      });
    } catch (err) {
      console.error('Error reseteando progreso:', err);
    }
    setDiagnostic(null);
    setMode('placement');
    setTestStep(1);
    setMessages([PLACEMENT_WELCOME]);
    await loadProgress();
  };

  const handleSendMessage = async (textToSend?: string) => {
    const content = (textToSend || inputText).trim();
    if (!content || loading) return;

    setInputText('');
    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'user',
      text: content
    };

    setMessages(prev => [...prev, userMsg]);
    setLoading(true);
    const requestSessionId = sessionIdRef.current;

    try {
      const historyPayload = messages
        .filter(m => m.sender !== 'system')
        .map(m => ({
          role: m.sender === 'user' ? 'user' : 'assistant',
          content: m.text
        }));

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: content,
          history: historyPayload,
          mode,
          sessionId: requestSessionId,
          topic: mode === 'placement' ? 'Placement diagnostic' : diagnostic?.firstSessionRecommendedTheme || 'Free conversation',
          userContext: {
            cefrLevel: diagnostic?.assignedLevel,
            // Paso que Ethan debe ejecutar ahora (el 1 ya lo hizo la bienvenida)
            testStep: Math.min(testStep + 1, 4),
            sessionDurationMinutes: Math.round(practiceSeconds / 60)
          }
        })
      });

      const data = await res.json();
      // Si durante la espera se reinició el diagnóstico, esta respuesta pertenece a una conversación descartada
      if (requestSessionId !== sessionIdRef.current) return;
      if (!res.ok) {
        addSystemMessage(`⚠️ ${data.error || 'Ethan could not answer right now. Please try again.'}`);
        // El mensaje vuelve al input para reintentar sin reescribirlo
        setInputText(content);
        return;
      }
      sessionTurnsRef.current += 1;

      const tutorMsg: Message = {
        id: (Date.now() + 1).toString(),
        sender: 'tutor',
        text: data.rawResponse,
        spokenText: data.spokenText,
        upgrades: data.upgrades
      };

      setMessages(prev => [...prev, tutorMsg]);

      // Si hay voz, reproducir inmediatamente
      if (data.spokenText) {
        playAudio(data.spokenText);
      }

      // Si la prueba de nivel finalizó: el backend ya guardó el nivel; la práctica diaria es otra sesión
      if (data.diagnosticData?.testCompleted) {
        setDiagnostic(data.diagnosticData);
        setMode('daily_session');
        await rotateSession();
        await loadProgress();
      } else if (mode === 'placement') {
        setTestStep(prev => Math.min(prev + 1, 4));
      } else if (data.upgrades?.length) {
        loadProgress();
      }
    } catch (err) {
      console.error('Error enviando mensaje:', err);
      addSystemMessage('⚠️ Connection problem — check that the backend is running and try again.');
      setInputText(content);
    } finally {
      setLoading(false);
    }
  };

  const formatTimer = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand-section">
          <div className={`avatar-badge ${isSpeakingAudio ? 'speaking' : ''}`}>
            <span style={{ fontSize: '22px' }}>🎙️</span>
          </div>
          <div className="brand-title">
            <h1>Ethan • Native English Coach</h1>
            <p>Lexical Immersion & Active Recasting • Engine: {activeEngine}</p>
          </div>
        </div>

        <div className="session-metrics">
          <div className="metric-pill">
            <Clock size={15} color="var(--accent-primary)" />
            <span>Session: {formatTimer(practiceSeconds)}</span>
          </div>

          <div className="metric-pill level-tag">
            <Award size={15} />
            <span>Level: {diagnostic ? diagnostic.assignedLevel : 'Diagnostic'}</span>
          </div>

          <button className="metric-pill pill-button" onClick={handleEndSession} disabled={loading || booting} title="Save this session to your history">
            <Square size={13} />
            <span>End session</span>
          </button>
        </div>
      </header>

      {engineWarning && (
        <div className="engine-banner" role="status">
          <AlertTriangle size={16} />
          <span>{engineWarning}</span>
          <button onClick={() => setEngineWarning(null)} title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main Grid */}
      <div className="main-grid">
        {/* Stage & Chat Area */}
        <div className="stage-container">
          {/* Visualizer Wave */}
          <div className="voice-visualizer">
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <div className={`v-bar ${isSpeakingAudio ? 'active' : ''}`} />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '10px' }}>
              {isSpeakingAudio ? 'Ethan is speaking...' : isListening ? 'Listening to your microphone...' : 'Ready for conversation'}
            </span>
            {isSpeakingAudio && (
              <button
                onClick={stopAudio}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', marginLeft: 'auto', marginRight: '16px' }}
                title="Mute voice"
              >
                <VolumeX size={16} />
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="messages-viewport">
            {booting && (
              <div className="message-bubble assistant" style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>
                Loading your progress...
              </div>
            )}
            {messages.map(msg => msg.sender === 'system' ? (
              <div key={msg.id} className="system-notice">{msg.text}</div>
            ) : (
              <div key={msg.id} className={`message-bubble ${msg.sender === 'user' ? 'user' : 'assistant'}`}>
                <div className="bubble-header">
                  <span>{msg.sender === 'user' ? 'You' : 'Ethan (Coach)'}</span>
                  {msg.spokenText && (
                    <button
                      className="bubble-audio-btn"
                      onClick={() => playAudio(msg.spokenText!)}
                      title="Replay voice"
                    >
                      <Volume2 size={14} />
                    </button>
                  )}
                </div>

                {/* Texto conversacional */}
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.spokenText || msg.text.replace(/\[SPOKEN RESPONSE\]/i, '').replace(/\[NATIVE UPGRADE\][\s\S]*$/i, '').trim()}
                </div>

                {/* Active Recasting: The Native Upgrade */}
                {msg.upgrades?.map((upgrade, idx) => (
                  <div className="upgrade-card" key={idx}>
                    <div className="upgrade-row original">
                      <span>❌</span>
                      <span>{upgrade.original}</span>
                    </div>
                    <div className="upgrade-row native">
                      <span>⚡</span>
                      <span>{upgrade.native}</span>
                    </div>
                    {upgrade.tip && (
                      <div className="upgrade-tip">
                        💡 {upgrade.tip}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {loading && (
              <div className="message-bubble assistant" style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>
                Ethan is thinking like a native...
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Control Dock */}
          <div className="control-dock">
            <button
              className={`mic-button ${isListening ? 'recording' : ''}`}
              onClick={toggleListening}
              disabled={(loading || booting) && !isListening}
              title={isListening ? 'Stop listening' : 'Start speaking'}
            >
              {isListening ? <MicOff size={24} /> : <Mic size={24} />}
            </button>

            <div className="input-box-wrapper">
              <input
                type="text"
                className="chat-input"
                placeholder={isListening ? 'Listening...' : 'Speak with mic or type your response in English...'}
                value={transcript || inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                disabled={booting}
              />
              <button className="send-button" onClick={() => handleSendMessage()} disabled={booting || loading}>
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>

        {/* Sidebar Analytics & Diagnostic Flow */}
        <aside className="side-panel">
          {/* Placement Progress Card */}
          <div className="panel-card">
            <div className="panel-title">
              <Sparkles size={18} color="var(--accent-primary)" />
              <span>{diagnostic ? 'Your Diagnostic' : 'Initial Diagnostic Test'}</span>
            </div>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
              Adaptive test to calibrate your natural rhythm, collocations, and eliminate Spanish interference.
            </p>

            <div className="diagnostic-stepper">
              {[1, 2, 3, 4].map(step => (
                <div
                  key={step}
                  className={`step-indicator ${!diagnostic && step === testStep ? 'active' : step < testStep || diagnostic ? 'completed' : ''}`}
                >
                  <div className="step-circle">
                    {step < testStep || diagnostic ? <CheckCircle2 size={16} /> : step}
                  </div>
                  <span>Step {step}</span>
                </div>
              ))}
            </div>

            {diagnostic && (
              <div className="diagnostic-report">
                <span className="report-badge">CEFR Level: {diagnostic.assignedLevel}</span>
                <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)', marginTop: '4px' }}>
                  Top Priority Focus Areas:
                </p>
                <ul className="priority-list">
                  {diagnostic.priorityAreas.map((area, idx) => (
                    <li key={idx}>{area}</li>
                  ))}
                </ul>
                <button className="ghost-button" disabled={loading} onClick={() => restartPlacement('level')}>
                  <RotateCcw size={14} />
                  <span>Retake diagnostic</span>
                </button>
              </div>
            )}
          </div>

          {/* Persistent Progress Card */}
          {progress && (
            <div className="panel-card">
              <div className="panel-title">
                <TrendingUp size={18} color="var(--color-native)" />
                <span>Your Progress</span>
              </div>
              <div className="stats-row">
                <div className="stat">
                  <strong>{progress.stats.totalSessions}</strong>
                  <span>sessions</span>
                </div>
                <div className="stat">
                  <strong>{progress.stats.totalMinutes}</strong>
                  <span>minutes</span>
                </div>
                <div className="stat">
                  <strong>{progress.stats.totalUpgrades}</strong>
                  <span>upgrades</span>
                </div>
              </div>

              {progress.weakPoints.length > 0 && (
                <>
                  <p style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-main)' }}>
                    Recurring weak points Ethan remembers:
                  </p>
                  <ul className="weak-list">
                    {progress.weakPoints.slice(0, 5).map((w, idx) => (
                      <li key={idx}>
                        <span className="weak-original">{w.original}</span>
                        <span className="weak-native">→ {w.native}</span>
                        {w.count > 1 && <span className="weak-count">×{w.count}</span>}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {(progress.stats.totalSessions > 0 || progress.stats.totalUpgrades > 0 || progress.cefrLevel) && (
                <button className="ghost-button danger" disabled={loading} onClick={() => restartPlacement('all')}>
                  <Trash2 size={14} />
                  <span>Reset all progress</span>
                </button>
              )}
            </div>
          )}

          {/* Pedagogy Method Card */}
          <div className="panel-card">
            <div className="panel-title">
              <Zap size={18} color="var(--color-native)" />
              <span>The Lexical Protocol</span>
            </div>
            <ul className="priority-list" style={{ marginTop: '0' }}>
              <li><strong>Zero dry grammar tables:</strong> Learn full chunks & collocations.</li>
              <li><strong>Active Recasting:</strong> Instant upgrade to sound like an authentic native.</li>
              <li><strong>Target:</strong> 15-30 mins of daily high-intensity speaking.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
export default App;
