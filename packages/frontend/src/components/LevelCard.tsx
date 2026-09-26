import { useState } from 'react';
import { Award, ClipboardCheck, PartyPopper } from 'lucide-react';
import { CEFR_INFO, CEFR_LEVELS, type DiagnosticResult, type LevelProgress } from '../types';

interface Props {
  level: string | null;
  diagnostic: DiagnosticResult | null;
  levelProgress: LevelProgress | null;
  inPlacement: boolean;
  busy: boolean;
  onSetLevel: (level: string) => void;
  onTakeTest: () => void;
  onLevelUp: (level: string) => void;
}

const SKILLS: { key: 'fluency' | 'vocabulary' | 'grammar'; label: string }[] = [
  { key: 'fluency', label: 'Fluidez' },
  { key: 'vocabulary', label: 'Vocabulario' },
  { key: 'grammar', label: 'Gramática' }
];

const SOURCE_LABEL: Record<string, string> = {
  test: 'según tu test de nivel',
  manual: 'elegido por ti',
  'level-up': '¡subiste de nivel!'
};

// Tu nivel: elegirlo a mano o por test, y cuánto te falta para el siguiente
export function LevelCard({ level, diagnostic, levelProgress, inPlacement, busy, onSetLevel, onTakeTest, onLevelUp }: Props) {
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState(level || 'B1');
  const lp = levelProgress;

  return (
    <div className="panel-card">
      <div className="panel-title">
        <Award size={18} color="var(--color-native)" />
        <span>Your level · Tu nivel</span>
      </div>

      {level ? (
        <div className="level-current">
          <span className="report-badge">{level} · {CEFR_INFO[level]?.name}</span>
          <p className="level-desc">{CEFR_INFO[level]?.es}</p>
          {diagnostic?.source && <p className="level-source">Nivel {SOURCE_LABEL[diagnostic.source]}</p>}
        </div>
      ) : (
        <p className="level-desc">
          {inPlacement
            ? 'Haz el test con Ethan o, si ya conoces tu nivel, elígelo tú y empieza a practicar.'
            : 'Aún no tienes nivel asignado.'}
        </p>
      )}

      {/* Progreso hacia el siguiente nivel */}
      {lp && lp.nextLevel && (
        <div className="level-progress">
          <div className="level-progress-head">
            <span>Hacia {lp.nextLevel}</span>
            <strong>{lp.percent}%</strong>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${lp.percent}%` }} />
          </div>

          {lp.averages ? (
            <div className="skill-bars">
              {SKILLS.map(s => (
                <div key={s.key} className="skill-row">
                  <span>{s.label}</span>
                  <div className="progress-track small">
                    <div className="progress-fill" style={{ width: `${(lp.averages![s.key] / 5) * 100}%` }} />
                  </div>
                  <em>{lp.averages![s.key].toFixed(1)}/5</em>
                </div>
              ))}
            </div>
          ) : null}

          <p className="level-explain">
            {lp.evaluatedAnswers === 0
              ? `Practica con Ethan: cada respuesta tuya se puntúa de 1 a 5 (3 = ${lp.level} sólido, 5 = ya hablas como ${lp.nextLevel}).`
              : `Basado en ${lp.evaluatedAnswers === 1 ? 'tu última respuesta' : `tus últimas ${lp.evaluatedAnswers} respuestas`} (media ${lp.overallAverage}/5${lp.correctionsPerAnswer !== null ? `, ${lp.correctionsPerAnswer} ${lp.correctionsPerAnswer === 1 ? 'corrección' : 'correcciones'} por respuesta` : ''}). Para subir necesitas ${lp.requiredAnswers} respuestas con media ≥ ${lp.targetAverage}.`}
          </p>

          {lp.readyToLevelUp && (
            <button className="level-up-button" disabled={busy} onClick={() => onLevelUp(lp.nextLevel!)}>
              <PartyPopper size={16} />
              <span>¡Listo para subir a {lp.nextLevel}!</span>
            </button>
          )}
        </div>
      )}
      {lp && !lp.nextLevel && <p className="level-explain">Estás en el nivel máximo del programa. ¡A pulir detalles!</p>}

      {/* Elegir nivel a mano o hacer el test */}
      {choosing ? (
        <div className="level-picker">
          {CEFR_LEVELS.map(l => (
            <label key={l} className={`level-option ${choice === l ? 'selected' : ''}`}>
              <input type="radio" name="level" value={l} checked={choice === l} onChange={() => setChoice(l)} />
              <strong>{l}</strong>
              <span>{CEFR_INFO[l].es}</span>
            </label>
          ))}
          <div className="level-picker-actions">
            <button className="start-button compact" disabled={busy} onClick={() => { onSetLevel(choice); setChoosing(false); }}>
              Usar {choice}
            </button>
            <button className="ghost-button" onClick={() => setChoosing(false)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <div className="level-actions">
          <button className="ghost-button" disabled={busy} onClick={() => { setChoice(level || 'B1'); setChoosing(true); }}>
            <Award size={14} />
            <span>{level ? 'Cambiar mi nivel' : 'Ya sé mi nivel'}</span>
          </button>
          {!inPlacement && (
            <button className="ghost-button" disabled={busy} onClick={onTakeTest}>
              <ClipboardCheck size={14} />
              <span>Hacer el test</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
