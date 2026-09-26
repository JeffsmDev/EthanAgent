import fs from 'node:fs';
import path from 'node:path';
import type { DiagnosticData, NativeUpgrade } from '../agents/responseParser.js';

// Persistencia ligera mono-usuario en JSON con escritura atómica (tmp + rename)

export const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];
export type SessionMode = 'placement' | 'daily_session';
export type ResetScope = 'level' | 'all';

export interface DiagnosticRecord {
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

export interface UserProgress {
  version: 1;
  cefrLevel: CefrLevel | null;
  diagnostic: DiagnosticRecord | null;
  sessions: SessionRecord[];
  nativeUpgrades: NativeUpgradeRecord[];
  updatedAt: string;
}

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
  private readonly filePath: string;
  private data: UserProgress;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'progress.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.load();
  }

  private load(): UserProgress {
    if (!fs.existsSync(this.filePath)) return emptyProgress();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return {
        ...emptyProgress(),
        ...parsed,
        cefrLevel: normalizeCefrLevel(parsed.cefrLevel),
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        nativeUpgrades: Array.isArray(parsed.nativeUpgrades) ? parsed.nativeUpgrades : []
      };
    } catch (error) {
      // Archivo corrupto: se aparta para inspección y se arranca limpio en vez de crashear
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      console.error(`⚠️ progress.json corrupto, respaldado en ${backup}:`, error);
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        /* si no se puede mover, se sobrescribirá en la siguiente escritura */
      }
      return emptyProgress();
    }
  }

  // Escrituras serializadas: nunca dos writeFile/rename concurrentes sobre el mismo archivo
  private persist(): Promise<void> {
    this.data.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeQueue = this.writeQueue
      .then(async () => {
        const tmp = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tmp, snapshot, 'utf8');
        await fs.promises.rename(tmp, this.filePath);
      })
      .catch(error => {
        console.error('❌ Error guardando progreso:', error);
      });
    return this.writeQueue;
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
      assignedLevel: level,
      strengths: diagnostic.strengths.slice(0, 10),
      priorityAreas: diagnostic.priorityAreas.slice(0, 10),
      firstSessionRecommendedTheme: diagnostic.firstSessionRecommendedTheme,
      assessedAt: new Date().toISOString()
    };
    await this.persist();
    return level;
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
