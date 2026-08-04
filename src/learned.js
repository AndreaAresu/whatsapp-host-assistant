import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNED_PATH = join(__dirname, '..', 'knowledge', 'learned.json');

// Le info sulla zona "scadono": un ristorante può chiudere, un orario cambiare.
// Le regole della casa invece non scadono.
const EXPIRY_DAYS = { info_zona: 90 };

export function loadLearned() {
  if (!existsSync(LEARNED_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LEARNED_PATH, 'utf8'));
  } catch {
    return [];
  }
}

export function isExpired(entry, now = new Date()) {
  return entry.scadenza ? now > new Date(entry.scadenza) : false;
}

/**
 * Salva una nuova FAQ imparata (la risposta approvata/scritta dall'host).
 * origine: "telegram" (approvata dai pulsanti) o "manuale" (scritta dal telefono).
 */
export function addLearned({ domanda, risposta, categoria, origine }) {
  const list = loadLearned();
  const today = new Date();
  const days = EXPIRY_DAYS[categoria];
  const scadenza = days
    ? new Date(today.getTime() + days * 86400000).toISOString().slice(0, 10)
    : null;

  const entry = {
    id: randomUUID(),
    domanda,
    risposta,
    categoria,
    origine,
    data: today.toISOString().slice(0, 10),
    scadenza,
  };

  list.push(entry);
  writeFileSync(LEARNED_PATH, JSON.stringify(list, null, 2));
  return entry;
}
