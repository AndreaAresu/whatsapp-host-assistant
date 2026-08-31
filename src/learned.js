import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonArray, writeJsonAtomic } from './storage.js';

// NB: la costante NON si chiama `__dirname`. Il bundler ESM di Netlify
// aggiunge un proprio shim con quel nome DOPO il bundling, quindi esbuild non
// sa di doverlo rinominare: due dichiarazioni omonime nello stesso modulo
// finale sono un SyntaxError, e la funzione non carica affatto (502).
const QUI = dirname(fileURLToPath(import.meta.url));
// Come per l'allowlist: la variabile d'ambiente serve solo ai test, per non
// scrivere sulle FAQ vere.
const LEARNED_PATH =
  process.env.LEARNED_PATH || join(QUI, '..', 'knowledge', 'learned.json');

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
