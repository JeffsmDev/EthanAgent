import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticData, NativeUpgrade, SkillScores } from '../agents/responseParser.js';
import { JsonFile } from './jsonFile.js';

// Persistencia ligera por usuario en JSON con escritura atómica (tmp + rename)

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];
export type SessionMode = 'placement' | 'daily_session';
export type ResetScope = 'level' | 'all';

export interface DiagnosticRecord {
  // test = diagnóstico con Ethan; manual = el alumno fijó su nivel; level-up = subió tras demostrar progreso
  source?: 'test' | 'manual' | 'level-up';
  assignedLevel: CefrLevel;
  strengths: string[];
  priorityAreas: string[];
  firstSessionRecommendedTheme: string;
  assessedAt: string;
}

export interface SessionRecord {
  id: string;
  mode: SessionMode;
  topic: string;
  startedAt: string;
  lastActivityAt: string;
  durationMinutes: number;
  turns: number;
  ended: boolean;
}

export interface NativeUpgradeRecord extends NativeUpgrade {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SkillScoreRecord extends SkillScores {
  at: string;
  level: CefrLevel;
  corrections: number;
}

export interface LevelProgress {
  level: CefrLevel;
  nextLevel: CefrLevel | null;
  percent: number;
  evaluatedAnswers: number;
  requiredAnswers: number;
  targetAverage: number;
  averages: SkillScores | null;
  overallAverage: number | null;
  correctionsPerAnswer: number | null;
  readyToLevelUp: boolean;
}

export interface UserProgress {
  version: 1;
  cefrLevel: CefrLevel | null;
  diagnostic: DiagnosticRecord | null;
  sessions: SessionRecord[];
  nativeUpgrades: NativeUpgradeRecord[];
  skillHistory: SkillScoreRecord[];
  updatedAt: string;
}

// Regla para subir de nivel: media ≥ 4,3/5 en las últimas 30 respuestas evaluadas en el nivel actual
const LEVEL_UP_WINDOW = 30;
const LEVEL_UP_TARGET = 4.3;
const MAX_SKILL_HISTORY = 1000;

const MAX_SESSIONS = 500;
const MAX_UPGRADES = 300;
const MAX_SESSION_MINUTES = 240;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function emptyProgress(): UserProgress {
  return {
    version: 1,
    cefrLevel: null,
    diagnostic: null,
    sessions: [],
    nativeUpgrades: [],
    skillHistory: [],
    updatedAt: new Date().toISOString()
  };
}

// Acepta "B1", "b1", "B1+", "Level B2 (Upper)" → nivel CEFR válido o null
export function normalizeCefrLevel(value: unknown): CefrLevel | null {
  if (typeof value !== 'string') return null;
  const match = value.toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)/);
  if (!match) return null;
  return match[1] === 'C2' ? 'C1' : (match[1] as CefrLevel);
}

export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

function upgradeKey(u: NativeUpgrade): string {
  return u.original.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, '').replace(/\s+/g, ' ').trim();
}

function minutesBetween(fromIso: string, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - new Date(fromIso).getTime()) / 60000));
}

export class ProgressStore {
  private readonly file: JsonFile<UserProgress>;
  private data: UserProgress;

  constructor(dataDir: string) {
    this.file = new JsonFile<UserProgress>(path.join(dataDir, 'progress.json'));
    this.data = this.load();
  }

  private load(): UserProgress {
    const parsed = this.file.read() as Partial<UserProgress> | null;
    if (!parsed || typeof parsed !== 'object') return emptyProgress();
    return {
      ...emptyProgress(),
      ...parsed,
      cefrLevel: normalizeCefrLevel(parsed.cefrLevel),
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      nativeUpgrades: Array.isArray(parsed.nativeUpgrades) ? parsed.nativeUpgrades : [],
      skillHistory: Array.isArray(parsed.skillHistory) ? parsed.skillHistory : []
    };
  }

  private persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    return this.file.write(this.data);
  }

  getProgress(): UserProgress {
    return structuredClone(this.data);
  }

  // Puntos débiles recurrentes: los errores más repetidos y recientes primero
  getWeakPoints(limit = 8): NativeUpgradeRecord[] {
    return [...this.data.nativeUpgrades]
      .sort((a, b) => b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, limit);
  }

  async saveDiagnostic(diagnostic: DiagnosticData): Promise<CefrLevel | null> {
    const level = normalizeCefrLevel(diagnostic.assignedLevel);
    if (!level) {
      console.warn(`Nivel CEFR inválido ignorado: "${diagnostic.assignedLevel}"`);
      return null;
    }
    this.data.cefrLevel = level;
    this.data.diagnostic = {
      source: 'test',
      assignedLevel: level,
      strengths: diagnostic.strengths.slice(0, 10),
      priorityAreas: diagnostic.priorityAreas.slice(0, 10),
      firstSessionRecommendedTheme: diagnostic.firstSessionRecommendedTheme,
      assessedAt: new Date().toISOString()
    };
    await this.persist();
    return level;
  }

  // Nivel fijado por el alumno (o subida de nivel). Conserva fortalezas/prioridades del diagnóstico si existía
  async setLevel(value: unknown, source: 'manual' | 'level-up'): Promise<CefrLevel | null> {
    const level = normalizeCefrLevel(value);
    if (!level) return null;
    const previous = this.data.diagnostic;
    this.data.cefrLevel = level;
    this.data.diagnostic = {
      source,
      assignedLevel: level,
      strengths: previous?.strengths ?? [],
      priorityAreas: previous?.priorityAreas ?? [],
      firstSessionRecommendedTheme: previous?.firstSessionRecommendedTheme ?? '',
      assessedAt: new Date().toISOString()
    };
    await this.persist();
    return level;
  }

  async recordScores(scores: SkillScores, corrections: number): Promise<void> {
    if (!this.data.cefrLevel) return;
    this.data.skillHistory.push({ ...scores, corrections, level: this.data.cefrLevel, at: new Date().toISOString() });
    if (this.data.skillHistory.length > MAX_SKILL_HISTORY) {
      this.data.skillHistory = this.data.skillHistory.slice(-MAX_SKILL_HISTORY);
    }
    await this.persist();
  }

  // Progreso hacia el siguiente nivel con las últimas respuestas evaluadas EN el nivel actual.
  // percent combina rendimiento (media 2 → 0 %, media 4,3 → 100 %) y cantidad de práctica (30 respuestas)
  getLevelProgress(): LevelProgress | null {
    const level = this.data.cefrLevel;
    if (!level) return null;
    const index = CEFR_LEVELS.indexOf(level);
    const nextLevel = index < CEFR_LEVELS.length - 1 ? CEFR_LEVELS[index + 1] : null;
    const recent = this.data.skillHistory.filter(r => r.level === level).slice(-LEVEL_UP_WINDOW);
    const n = recent.length;
    const avg = (key: keyof SkillScores) => recent.reduce((sum, r) => sum + r[key], 0) / Math.max(1, n);
    const averages = n ? { fluency: avg('fluency'), vocabulary: avg('vocabulary'), grammar: avg('grammar') } : null;
    const overall = averages ? (averages.fluency + averages.vocabulary + averages.grammar) / 3 : null;
    const performance = overall === null ? 0 : Math.min(1, Math.max(0, (overall - 2) / (LEVEL_UP_TARGET - 2)));
    const practice = Math.min(1, n / LEVEL_UP_WINDOW);
    const round1 = (v: number) => Math.round(v * 10) / 10;
    return {
      level,
      nextLevel,
      percent: nextLevel ? Math.round(performance * practice * 100) : 100,
      evaluatedAnswers: n,
      requiredAnswers: LEVEL_UP_WINDOW,
      targetAverage: LEVEL_UP_TARGET,
      averages: averages && { fluency: round1(averages.fluency), vocabulary: round1(averages.vocabulary), grammar: round1(averages.grammar) },
      overallAverage: overall === null ? null : round1(overall),
      correctionsPerAnswer: n ? round1(recent.reduce((sum, r) => sum + r.corrections, 0) / n) : null,
      readyToLevelUp: !!nextLevel && n >= LEVEL_UP_WINDOW && (overall ?? 0) >= LEVEL_UP_TARGET
    };
  }

  async addUpgrades(upgrades: NativeUpgrade[]): Promise<void> {
    if (upgrades.length === 0) return;
    const now = new Date().toISOString();
    for (const upgrade of upgrades) {
      const key = upgradeKey(upgrade);
      if (!key) continue;
      const existing = this.data.nativeUpgrades.find(u => upgradeKey(u) === key);
      if (existing) {
        existing.count += 1;
        existing.lastSeenAt = now;
        existing.native = upgrade.native;
        existing.tip = upgrade.tip || existing.tip;
        existing.pronunciation = upgrade.pronunciation || existing.pronunciation;
        existing.explanationEs = upgrade.explanationEs || existing.explanationEs;
      } else {
        this.data.nativeUpgrades.push({ ...upgrade, count: 1, firstSeenAt: now, lastSeenAt: now });
      }
    }
    if (this.data.nativeUpgrades.length > MAX_UPGRADES) {
      this.data.nativeUpgrades = this.getWeakPoints(MAX_UPGRADES);
    }
    await this.persist();
  }

  // Upsert de la sesión en cada turno: la duración queda registrada aunque se cierre la pestaña
  async recordTurn(sessionId: string, mode: SessionMode, topic: string): Promise<void> {
    const now = new Date();
    let session = this.data.sessions.find(s => s.id === sessionId);
    if (!session) {
      session = {
        id: sessionId,
        mode,
        topic: topic.slice(0, 120) || 'Free conversation',
        startedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        durationMinutes: 0,
        turns: 0,
        ended: false
      };
      this.data.sessions.push(session);
      if (this.data.sessions.length > MAX_SESSIONS) {
        this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
      }
    }
    session.turns += 1;
    session.lastActivityAt = now.toISOString();
    session.durationMinutes = Math.min(MAX_SESSION_MINUTES, Math.max(session.durationMinutes, minutesBetween(session.startedAt, now)));
    await this.persist();
  }

  // Cierre explícito (botón o sendBeacon). Solo cierra sesiones que tuvieron al menos un turno
  async endSession(sessionId: string, clientDurationMinutes?: number): Promise<SessionRecord | null> {
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (!session) return null;
    const clientMinutes = Number.isFinite(clientDurationMinutes) ? Math.round(clientDurationMinutes as number) : 0;
    const serverMinutes = minutesBetween(session.startedAt, new Date());
    // El cliente no puede declarar más tiempo del que realmente pasó desde el inicio
    session.durationMinutes = Math.min(MAX_SESSION_MINUTES, Math.max(session.durationMinutes, Math.min(clientMinutes, serverMinutes)));
    session.ended = true;
    await this.persist();
    return structuredClone(session);
  }

  async reset(scope: ResetScope): Promise<void> {
    if (scope === 'level') {
      // Repetir el diagnóstico: se conserva historial y upgrades
      this.data.cefrLevel = null;
      this.data.diagnostic = null;
    } else {
      this.data = emptyProgress();
    }
    await this.persist();
  }
}

// Un progreso por usuario en data/users/<id>/progress.json (cada uno con su propia cola de escritura)
export class UserProgressStores {
  private readonly stores = new Map<string, ProgressStore>();

  constructor(private readonly dataDir: string, legacyOwnerId: string | null) {
    // Migración: el progress.json de la época mono-usuario pasa al administrador (el primer usuario)
    const legacy = path.join(dataDir, 'progress.json');
    if (legacyOwnerId && fs.existsSync(legacy)) {
      const target = path.join(this.userDir(legacyOwnerId), 'progress.json');
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(legacy, target);
        console.log(`📦 progress.json migrado al usuario "${legacyOwnerId}"`);
      }
    }
  }

  private userDir(userId: string): string {
    return path.join(this.dataDir, 'users', userId);
  }

  // userId ya validado por AuthService (solo [a-z0-9_-])
  forUser(userId: string): ProgressStore {
    let store = this.stores.get(userId);
    if (!store) {
      store = new ProgressStore(this.userDir(userId));
      this.stores.set(userId, store);
    }
    return store;
  }
}
