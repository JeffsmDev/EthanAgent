// Tipos compartidos entre App y los componentes (reflejan las respuestas del backend)

export interface NativeUpgrade {
  original: string;
  native: string;
  tip: string;
  pronunciation?: string;
  explanationEs?: string;
}

export interface SkillScores {
  fluency: number;
  vocabulary: number;
  grammar: number;
}

export interface DiagnosticResult {
  testCompleted?: boolean;
  source?: 'test' | 'manual' | 'level-up';
  assignedLevel: string;
  strengths: string[];
  priorityAreas: string[];
  firstSessionRecommendedTheme: string;
}

export interface LevelProgress {
  level: string;
  nextLevel: string | null;
  percent: number;
  evaluatedAnswers: number;
  requiredAnswers: number;
  targetAverage: number;
  averages: SkillScores | null;
  overallAverage: number | null;
  correctionsPerAnswer: number | null;
  readyToLevelUp: boolean;
}

export interface WeakPoint extends NativeUpgrade {
  count: number;
}

export interface UserProgress {
  cefrLevel: string | null;
  diagnostic: DiagnosticResult | null;
  stats: { totalSessions: number; totalMinutes: number; totalUpgrades: number };
  sessions: { id: string; topic: string; startedAt: string; durationMinutes: number }[];
  weakPoints: WeakPoint[];
  levelProgress: LevelProgress | null;
}

export interface SessionRecapData {
  minutes: number;
  turns: number;
  corrections: NativeUpgrade[];
}

export interface Message {
  id: string;
  sender: 'user' | 'tutor' | 'system' | 'recap';
  text: string;
  spokenText?: string;
  spanish?: string;
  upgrades?: NativeUpgrade[];
  recap?: SessionRecapData;
}

export const CEFR_INFO: Record<string, { name: string; es: string }> = {
  A1: { name: 'Beginner', es: 'Principiante: frases básicas, presentarte y necesidades inmediatas.' },
  A2: { name: 'Elementary', es: 'Elemental: conversaciones sencillas sobre temas cotidianos.' },
  B1: { name: 'Intermediate', es: 'Intermedio: entiendes lo esencial y te defiendes, pero hablas con pausas y vocabulario limitado.' },
  B2: { name: 'Upper Intermediate', es: 'Intermedio alto: hablas con fluidez y espontaneidad con nativos, con errores ocasionales.' },
  C1: { name: 'Advanced', es: 'Avanzado: te expresas con fluidez, precisión y matices, casi sin esfuerzo.' }
};

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];
