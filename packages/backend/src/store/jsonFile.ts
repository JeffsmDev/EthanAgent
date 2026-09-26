import fs from 'node:fs';
import path from 'node:path';

// Archivo JSON con lectura tolerante (si está corrupto se aparta y se arranca limpio) y escritura
// atómica (tmp + rename) serializada: nunca dos writeFile/rename concurrentes sobre el mismo archivo
export class JsonFile<T> {
  readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  // null = no existe o estaba corrupto (quien llama decide el valor inicial)
  read(): unknown | null {
    if (!fs.existsSync(this.filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      console.error(`⚠️ ${path.basename(this.filePath)} corrupto, respaldado en ${backup}:`, error);
      try {
        fs.renameSync(this.filePath, backup);
      } catch {
        /* si no se puede mover, se sobrescribirá en la siguiente escritura */
      }
      return null;
    }
  }

  // Rechaza si la escritura falla (quien llama decide si es crítico); la cola sigue viva para las siguientes
  write(data: T): Promise<void> {
    const snapshot = JSON.stringify(data, null, 2);
    const attempt = this.writeQueue.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.promises.writeFile(tmp, snapshot, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    });
    this.writeQueue = attempt.catch(error => {
      console.error(`❌ Error guardando ${path.basename(this.filePath)}:`, error);
    });
    return attempt;
  }
}
