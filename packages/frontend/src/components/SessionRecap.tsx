import { BookOpen } from 'lucide-react';
import type { SessionRecapData } from '../types';

// Resumen al cerrar la sesión: qué practicaste y qué correcciones debes recordar
export function SessionRecap({ recap, showSpanish }: { recap: SessionRecapData; showSpanish: boolean }) {
  return (
    <div className="recap-card">
      <div className="recap-head">
        <BookOpen size={16} />
        <strong>Session recap · Resumen de la sesión</strong>
      </div>
      <p className="recap-stats">
        {recap.minutes} min · {recap.turns} {recap.turns === 1 ? 'respuesta' : 'respuestas'} · {recap.corrections.length}{' '}
        {recap.corrections.length === 1 ? 'corrección' : 'correcciones'}
      </p>
      {recap.corrections.length === 0 ? (
        <p className="recap-empty">Sin correcciones en esta sesión. ¡Muy bien! 🎉</p>
      ) : (
        <ul className="recap-list">
          {recap.corrections.map((c, idx) => (
            <li key={idx}>
              <span className="weak-original">{c.original}</span>
              <span className="weak-native">→ {c.native}</span>
              {showSpanish && c.explanationEs && <em>{c.explanationEs}</em>}
            </li>
          ))}
        </ul>
      )}
      <p className="recap-tip">Repite en voz alta cada frase correcta 3 veces. Ethan las recordará en tus próximas sesiones.</p>
    </div>
  );
}
