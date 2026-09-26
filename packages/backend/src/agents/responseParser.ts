// Parseo único de la respuesta cruda del tutor (formato definido en tutorPrompt.ts)

export interface NativeUpgrade {
  original: string;
  native: string;
  tip: string;
}

export interface DiagnosticData {
  testCompleted: boolean;
  assignedLevel: string;
  strengths: string[];
  priorityAreas: string[];
  firstSessionRecommendedTheme: string;
}

export interface ParsedTutorResponse {
  spokenText: string;
  upgrades: NativeUpgrade[];
  diagnosticData: DiagnosticData | null;
}

// Extrae únicamente la parte que el agente debe leer en voz alta
export function extractSpokenText(raw: string): string {
  const spokenMatch = raw.match(/\[SPOKEN RESPONSE\]([\s\S]*?)(?:\[NATIVE UPGRADE\]|```json|$)/i);
  const spoken = spokenMatch?.[1]
    ? spokenMatch[1]
    // Si no tiene la etiqueta, limpiamos el bloque de corrección y el código
    : raw.replace(/\[NATIVE UPGRADE\][\s\S]*$/i, '').replace(/```[\s\S]*?```/g, '');
  // Los LLM a veces envuelven las etiquetas en negritas (**[NATIVE UPGRADE]**): nada de markdown al TTS
  return spoken.replace(/[*_#`]+/g, '').trim();
}

// Un bloque [NATIVE UPGRADE] puede traer una o varias correcciones
export function extractUpgrades(raw: string): NativeUpgrade[] {
  const blockMatch = raw.match(/\[NATIVE UPGRADE\]([\s\S]*?)(?:```json|$)/i);
  if (!blockMatch) return [];

  const upgrades: NativeUpgrade[] = [];
  // Tolera *You said:*, **You said:**, You said: y comillas rectas o tipográficas.
  // El takeaway solo se busca en la línea siguiente, para no robar el de otra corrección
  const pattern = /You said:?\**\s*["“](.+?)["”][\s\S]*?Native way:?\**\s*["“](.+?)["”](?:[^\S\n]*\n[^\n]*?Key takeaway:?\**\s*(.*?)(?:\n|$))?/gi;
  for (const match of blockMatch[1].matchAll(pattern)) {
    const original = match[1].trim();
    const native = match[2].trim();
    if (original && native) {
      upgrades.push({ original, native, tip: (match[3] || '').replace(/[*_]+/g, '').trim() });
    }
  }
  return upgrades;
}

export function extractDiagnostic(raw: string): DiagnosticData | null {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch?.[1]) return null;
  try {
    const data = JSON.parse(jsonMatch[1]);
    if (!data || typeof data !== 'object' || typeof data.assignedLevel !== 'string') return null;
    return {
      testCompleted: data.testCompleted === true,
      assignedLevel: data.assignedLevel,
      strengths: Array.isArray(data.strengths) ? data.strengths.map(String) : [],
      priorityAreas: Array.isArray(data.priorityAreas) ? data.priorityAreas.map(String) : [],
      firstSessionRecommendedTheme: String(data.firstSessionRecommendedTheme || '')
    };
  } catch {
    console.warn('No se pudo parsear el bloque JSON diagnóstico');
    return null;
  }
}

export function parseTutorResponse(raw: string): ParsedTutorResponse {
  return {
    spokenText: extractSpokenText(raw),
    upgrades: extractUpgrades(raw),
    diagnosticData: extractDiagnostic(raw)
  };
}
