import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonArray, writeJsonAtomic } from './storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEARNED_PATH = join(__dirname, '..', 'knowledge', 'learned.json');

// Le info sulla zona "scadono": un ristorante può chiudere, un orario cambiare.
// Le regole della casa invece non scadono.
const EXPIRY_DAYS = { info_zona: 90 };

export function loadLearned() {
  return readJsonArray(LEARNED_PATH, 'Le FAQ imparate');
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
  writeJsonAtomic(LEARNED_PATH, list);
  return entry;
}
