import path from 'node:path';
import type { CostSource, EngineUsage, ProviderName } from '../engines/aiProvider.js';
import { JsonFile } from './jsonFile.js';

// Historial de consumo por turno para comparar motores (coste, latencia, fiabilidad)

export interface UsageRecord {
  at: string;
  provider: ProviderName;
  model: string;
  sessionId: string | null;
  userId?: string | null;
  latencyMs: number;
  ok: boolean;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costSource: CostSource | null;
}

export interface EngineUsageSummary {
  provider: ProviderName;
  model: string;
  turns: number;
  errors: number;
  sessions: number;
  totalCostUsd: number;
  avgCostPerTurnUsd: number;
  avgCostPerSessionUsd: number;
  avgLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costSource: CostSource | null;
  firstAt: string;
  lastAt: string;
}

interface UsageFile {
  version: 1;
  records: UsageRecord[];
}

const MAX_RECORDS = 10000;

const round = (value: number, decimals: number) => Number(value.toFixed(decimals));

export class UsageStore {
  private readonly file: JsonFile<UsageFile>;
  private data: UsageFile;

  constructor(dataDir: string) {
    this.file = new JsonFile<UsageFile>(path.join(dataDir, 'usage.json'));
    const parsed = this.file.read() as Partial<UsageFile> | null;
    this.data = { version: 1, records: Array.isArray(parsed?.records) ? parsed.records : [] };
  }

  async record(entry: {
    provider: ProviderName;
    model: string;
    sessionId?: string | null;
    userId?: string | null;
    latencyMs: number;
    usage?: EngineUsage | null;
    errorCode?: string | null;
  }): Promise<void> {
    this.data.records.push({
      at: new Date().toISOString(),
      provider: entry.provider,
      model: entry.model,
      sessionId: entry.sessionId ?? null,
      userId: entry.userId ?? null,
      latencyMs: Math.round(entry.latencyMs),
      ok: !entry.errorCode,
      errorCode: entry.errorCode ?? null,
      inputTokens: entry.usage?.inputTokens ?? 0,
      outputTokens: entry.usage?.outputTokens ?? 0,
      cacheReadTokens: entry.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: entry.usage?.cacheWriteTokens ?? 0,
      costUsd: entry.usage?.costUsd ?? 0,
      costSource: entry.usage?.costSource ?? null
    });
    if (this.data.records.length > MAX_RECORDS) {
      this.data.records = this.data.records.slice(-MAX_RECORDS);
    }
    await this.file.write(this.data);
  }

  // Resumen por motor+modelo. Las medias de coste y latencia solo cuentan turnos exitosos
  summary(sinceIso?: string): EngineUsageSummary[] {
    const groups = new Map<string, UsageRecord[]>();
    for (const r of this.data.records) {
      if (sinceIso && r.at < sinceIso) continue;
      const key = `${r.provider}|${r.model}`;
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
    return [...groups.values()].map(list => {
      const ok = list.filter(r => r.ok);
      const totalCost = ok.reduce((sum, r) => sum + r.costUsd, 0);
      const sessions = new Set(ok.map(r => r.sessionId).filter(Boolean)).size;
      return {
        provider: list[0].provider,
        model: list[0].model,
        turns: ok.length,
        errors: list.length - ok.length,
        sessions,
        totalCostUsd: round(totalCost, 6),
        avgCostPerTurnUsd: ok.length ? round(totalCost / ok.length, 6) : 0,
        avgCostPerSessionUsd: sessions ? round(totalCost / sessions, 6) : 0,
        avgLatencyMs: ok.length ? Math.round(ok.reduce((sum, r) => sum + r.latencyMs, 0) / ok.length) : 0,
        totalInputTokens: ok.reduce((sum, r) => sum + r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, 0),
        totalOutputTokens: ok.reduce((sum, r) => sum + r.outputTokens, 0),
        costSource: ok.at(-1)?.costSource ?? null,
        firstAt: list[0].at,
        lastAt: list.at(-1)!.at
      };
    }).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  // Coste acumulado de una sesión de práctica (para mostrarlo en vivo en la UI)
  sessionCost(sessionId: string): { turns: number; costUsd: number } {
    const list = this.data.records.filter(r => r.ok && r.sessionId === sessionId);
    return { turns: list.length, costUsd: round(list.reduce((sum, r) => sum + r.costUsd, 0), 6) };
  }

  recent(limit = 50): UsageRecord[] {
    return this.data.records.slice(-limit).reverse();
  }

  async reset(): Promise<void> {
    this.data = { version: 1, records: [] };
    await this.file.write(this.data);
  }
}
