import { Snail, Volume2 } from 'lucide-react';
import type { NativeUpgrade } from '../types';

interface Props {
  upgrade: NativeUpgrade;
  showSpanish: boolean;
  onListen: (text: string, slow: boolean) => void;
}

// Tarjeta "Native Upgrade": lo que dijiste → cómo lo dice un nativo, cómo se pronuncia y por qué (en español)
export function UpgradeCard({ upgrade, showSpanish, onListen }: Props) {
  return (
    <div className="upgrade-card">
      <div className="upgrade-row original">
        <span>❌</span>
        <span>{upgrade.original}</span>
      </div>
      <div className="upgrade-row native">
        <span>⚡</span>
        <span>{upgrade.native}</span>
        <span className="upgrade-listen">
          <button onClick={() => onListen(upgrade.native, false)} title="Listen">
            <Volume2 size={14} />
          </button>
          <button onClick={() => onListen(upgrade.native, true)} title="Listen slowly">
            <Snail size={14} />
          </button>
        </span>
      </div>
      {upgrade.pronunciation && (
        <div className="upgrade-pronunciation" title="Stressed syllables in CAPS">
          🗣️ <span>{upgrade.pronunciation}</span>
        </div>
      )}
      {upgrade.tip && <div className="upgrade-tip">💡 {upgrade.tip}</div>}
      {showSpanish && upgrade.explanationEs && <div className="upgrade-es">🇪🇸 {upgrade.explanationEs}</div>}
    </div>
  );
}
