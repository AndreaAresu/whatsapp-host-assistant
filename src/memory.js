// Memoria conversazioni per contatto, persistente su SQLite (sopravvive ai
// riavvii). Stessa API di prima (getHistory / appendUser / appendAssistant).
import db from './db.js';

const RESET_MS = 6 * 60 * 60 * 1000; // dopo 6h di silenzio la conversazione si azzera
const MAX_MESSAGES = 20; // teniamo solo gli ultimi messaggi nel contesto

const insertStmt = db.prepare(
  'INSERT INTO messages (conv_id, role, content, ts) VALUES (?, ?, ?, ?)'
);
const lastTsStmt = db.prepare('SELECT MAX(ts) AS maxTs FROM messages WHERE conv_id = ?');
const recentStmt = db.prepare(
  'SELECT role, content FROM messages WHERE conv_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
);
const deleteConvStmt = db.prepare('DELETE FROM messages WHERE conv_id = ?');

// La "scadenza" è basata sul tempo dall'ULTIMO messaggio (finestra a scorrimento):
// se l'ultimo messaggio è più vecchio di 6h, la conversazione è considerata chiusa.
function isExpired(convId) {
  const { maxTs } = lastTsStmt.get(convId) ?? {};
  return maxTs ? Date.now() - maxTs > RESET_MS : false;
}

/** Restituisce lo storico (alternanza user/assistant) della conversazione attiva. */
export function getHistory(convId) {
  if (isExpired(convId)) {
    deleteConvStmt.run(convId); // conversazione scaduta: pulizia
    return [];
  }
  const rows = recentStmt.all(convId, MAX_MESSAGES);
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

function append(convId, role, content) {
  if (isExpired(convId)) deleteConvStmt.run(convId); // riparti pulito se era scaduta
  insertStmt.run(convId, role, content, Date.now());
}

export const appendUser = (convId, text) => append(convId, 'user', text);
export const appendAssistant = (convId, text) => append(convId, 'assistant', text);
