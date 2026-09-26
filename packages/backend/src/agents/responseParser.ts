// Parseo único de la respuesta cruda del tutor (formato definido en tutorPrompt.ts):
// [SPOKEN RESPONSE] → [SPANISH] → [NATIVE UPGRADE] → [STEP_STATUS] (+ bloque ```json al cerrar el diagnóstico)

export interface NativeUpgrade {
  original: string;
  native: string;
  tip: string;
  pronunciation?: string;
  explanationEs?: string;
}

export interface DiagnosticData {
  testCompleted: boolean;
  assignedLevel: string;
  strengths: string[];
  priorityAreas: string[];
  firstSessionRecommendedTheme: string;
}

export type StepStatus = 'advance' | 'repeat' | null;

export interface SkillScores {
  fluency: number;
  vocabulary: number;
  grammar: number;
}

export interface ParsedTutorResponse {
  spokenText: string;
  spanishText: string;
  upgrades: NativeUpgrade[];
  diagnosticData: DiagnosticData | null;
  stepStatus: StepStatus;
  scores: SkillScores | null;
}

// Cualquier etiqueta de sección (también envuelta en negritas) o el bloque JSON cierra la sección anterior
const SECTION_END = String.raw`(?=\**\[(?:SPANISH|NATIVE UPGRADE|STEP_STATUS|SCORES)\]|` + '```json|$)';

const stripMarkdown = (text: string) => text.replace(/[*_#`]+/g, '').trim();

function section(raw: string, tag: string): string | null {
  const match = raw.match(new RegExp(String.raw`\[${tag}\]\**([\s\S]*?)${SECTION_END}`, 'i'));
  return match ? match[1] : null;
}

// Extrae únicamente la parte que el agente debe leer en voz alta (nunca el español ni las correcciones)
export function extractSpokenText(raw: string): string {
  const spoken = section(raw, 'SPOKEN RESPONSE')
    // Sin etiqueta: todo lo anterior a la primera sección, sin bloques de código
    ?? raw.split(/\**\[(?:SPANISH|NATIVE UPGRADE|STEP_STATUS|SCORES)\]/i)[0].replace(/```[\s\S]*?```/g, '');
  // Los LLM a veces envuelven las etiquetas en negritas (**[NATIVE UPGRADE]**): nada de markdown al TTS
  return stripMarkdown(spoken);
}

export function extractSpanish(raw: string): string {
  const spanish = section(raw, 'SPANISH');
  return spanish ? stripMarkdown(spanish) : '';
}

// Campo "Etiqueta: valor" de una corrección; las comillas del valor son opcionales
function field(chunk: string, label: string): string {
  const match = chunk.match(new RegExp(String.raw`${label}:?\**\s*(.+)`, 'i'));
  if (!match) return '';
  // Solo se quitan las comillas si envuelven TODO el valor ("I'm 25"); una explicación que empieza citando
  // una palabra ("Agree" ya es verbo…) debe quedar intacta
  const value = stripMarkdown(match[1]);
  const wrapped = value.match(/^["“]([^"“”]*)["”]$/);
  return (wrapped ? wrapped[1] : value).trim();
}

// Un bloque [NATIVE UPGRADE] puede traer varias correcciones: se separan por cada "You said"
export function extractUpgrades(raw: string): NativeUpgrade[] {
  const block = section(raw, 'NATIVE UPGRADE');
  if (!block) return [];
  return block
    .split(/(?=^[^\n]*You said)/im)
    .map(chunk => {
      const original = field(chunk, 'You said');
      const native = field(chunk, 'Native way');
      if (!original || !native) return null;
      const upgrade: NativeUpgrade = { original, native, tip: field(chunk, 'Key takeaway') };
      const pronunciation = field(chunk, 'Pronunciation');
      const explanationEs = field(chunk, 'Explicaci[oó]n');
      if (pronunciation) upgrade.pronunciation = pronunciation;
      if (explanationEs) upgrade.explanationEs = explanationEs;
      return upgrade;
    })
    .filter((u): u is NativeUpgrade => u !== null);
}

export function extractStepStatus(raw: string): StepStatus {
  const match = raw.match(/\[STEP_STATUS\]\**\s*(advance|repeat)/i);
  return match ? (match[1].toLowerCase() as StepStatus) : null;
}

// "[SCORES] fluency=3 vocabulary=4 grammar=2" → puntuaciones 1-5; "skip" o formato inválido → null
export function extractScores(raw: string): SkillScores | null {
  const line = raw.match(/\[SCORES\]\**([^\n]*)/i)?.[1];
  if (!line || /skip/i.test(line)) return null;
  const read = (name: string) => {
    const value = Number(line.match(new RegExp(`${name}\\s*[=:]\\s*([1-5](?:\\.\\d)?)`, 'i'))?.[1]);
    return value >= 1 && value <= 5 ? value : null;
  };
  const fluency = read('fluency');
  const vocabulary = read('vocabulary');
  const grammar = read('grammar');
  return fluency && vocabulary && grammar ? { fluency, vocabulary, grammar } : null;
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
    spanishText: extractSpanish(raw),
    upgrades: extractUpgrades(raw),
    diagnosticData: extractDiagnostic(raw),
    stepStatus: extractStepStatus(raw),
    scores: extractScores(raw)
  };
}
