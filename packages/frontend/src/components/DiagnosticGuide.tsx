import { CheckCircle2, RotateCcw, Sparkles } from 'lucide-react';

// Etapas del test de nivel, explicadas en español para que el alumno sepa qué se evalúa y cómo responder
const STAGES = [
  {
    title: 'About you',
    es: 'Sobre ti',
    evaluates: 'Fluidez básica, tiempos verbales y vocabulario cotidiano.',
    tip: 'Cuéntale a qué te dedicas, cómo es tu día y por qué quieres mejorar tu inglés. Apunta a 3-5 frases.'
  },
  {
    title: 'Your opinion',
    es: 'Tu opinión',
    evaluates: 'Conectores y cómo argumentas ideas más complejas.',
    tip: 'Elige una postura y da razones: "I think… because…", "On the other hand…", "Although…".'
  },
  {
    title: 'Real-life situation',
    es: 'Situación real',
    evaluates: 'Reacción espontánea y cómo resuelves un problema en inglés.',
    tip: 'Respóndele como si estuviera pasando de verdad: pide, negocia y explica qué necesitas.'
  },
  {
    title: 'Your result',
    es: 'Tu resultado',
    evaluates: 'Ethan te da tu nivel, tus fortalezas y en qué trabajar primero.',
    tip: 'Solo escucha el resultado. Después empiezan las sesiones de práctica a tu nivel.'
  }
];

interface Props {
  // Etapa que el alumno está respondiendo (1-3) o 4 = esperando el resultado
  stage: number;
  onRestart: () => void;
}

export function DiagnosticGuide({ stage, onRestart }: Props) {
  const current = STAGES[Math.min(stage, 4) - 1];
  return (
    <div className="panel-card">
      <div className="panel-title">
        <Sparkles size={18} color="var(--accent-primary)" />
        <span>Level test · Test de nivel</span>
      </div>

      <div className="diagnostic-stepper">
        {STAGES.map((s, idx) => {
          const n = idx + 1;
          const state = n < stage ? 'completed' : n === stage ? 'active' : '';
          return (
            <div key={n} className={`step-indicator ${state}`}>
              <div className="step-circle">{n < stage ? <CheckCircle2 size={16} /> : n}</div>
              <span>{s.es}</span>
            </div>
          );
        })}
      </div>

      <div className="stage-now">
        <span className="stage-label">Ahora · Etapa {Math.min(stage, 4)} de 4</span>
        <strong>{current.title} — {current.es}</strong>
        <p><b>Qué evalúa:</b> {current.evaluates}</p>
        <p><b>Cómo responder:</b> {current.tip}</p>
        <p className="stage-note">
          Si tu respuesta es muy corta o la grabación falla, Ethan te vuelve a preguntar y la etapa no cuenta. Sin presión.
        </p>
      </div>

      <button className="ghost-button" onClick={onRestart}>
        <RotateCcw size={14} />
        <span>Restart test</span>
      </button>
    </div>
  );
}
