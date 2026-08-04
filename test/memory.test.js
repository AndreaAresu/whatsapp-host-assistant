// memory.js — lo storico delle conversazioni su SQLite.
// Due comportamenti da non perdere: la finestra a scorrimento (ultimi 20
// messaggi) e l'azzeramento dopo 6h di silenzio, che evita di riaprire una
// conversazione chiusa settimane prima.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cartellaTemporanea } from './helpers.js';

const dir = cartellaTemporanea('memory');
process.env.BOT_DB_PATH = join(dir, 'test.db'); // niente storico vero

const { getHistory, appendUser, appendAssistant } = await import('../src/memory.js');
const { default: db } = await import('../src/db.js');

const CHAT = '393331234567@s.whatsapp.net';
const ALTRA = '393339999999@s.whatsapp.net';

/** Sposta indietro nel tempo i messaggi di una chat (per simulare il silenzio). */
const invecchia = (convId, ore) =>
  db.prepare('UPDATE messages SET ts = ts - ? WHERE conv_id = ?').run(ore * 3600000, convId);

beforeEach(() => db.prepare('DELETE FROM messages').run());

test('una conversazione mai iniziata ha storico vuoto', () => {
  assert.deepEqual(getHistory(CHAT), []);
});

test('lo storico torna in ordine cronologico con i ruoli giusti', () => {
  appendUser(CHAT, 'Ciao!');
  appendAssistant(CHAT, 'Ciao, come posso aiutarti?');
  appendUser(CHAT, 'A che ora è il check-in?');

  assert.deepEqual(getHistory(CHAT), [
    { role: 'user', content: 'Ciao!' },
    { role: 'assistant', content: 'Ciao, come posso aiutarti?' },
    { role: 'user', content: 'A che ora è il check-in?' },
  ]);
});

test('le conversazioni di clienti diversi restano separate', () => {
  appendUser(CHAT, 'Sono il cliente A');
  appendUser(ALTRA, 'Sono il cliente B');

  assert.deepEqual(getHistory(CHAT), [{ role: 'user', content: 'Sono il cliente A' }]);
  assert.deepEqual(getHistory(ALTRA), [{ role: 'user', content: 'Sono il cliente B' }]);
});

test('si tengono solo gli ultimi 20 messaggi', () => {
  for (let i = 1; i <= 25; i++) appendUser(CHAT, `messaggio ${i}`);

  const storico = getHistory(CHAT);

  assert.equal(storico.length, 20);
  assert.equal(storico[0].content, 'messaggio 6', 'i più vecchi cadono fuori dalla finestra');
  assert.equal(storico[19].content, 'messaggio 25');
});

test('dopo 6h di silenzio la conversazione riparte da zero', () => {
  appendUser(CHAT, 'Messaggio di una settimana fa');
  appendAssistant(CHAT, 'Risposta di una settimana fa');
  invecchia(CHAT, 7);

  assert.deepEqual(getHistory(CHAT), []);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(CHAT).n,
    0,
    'i messaggi scaduti vengono cancellati, non solo nascosti'
  );
});

test('sotto le 6h la conversazione continua', () => {
  appendUser(CHAT, 'Messaggio di 5 ore fa');
  invecchia(CHAT, 5);

  assert.deepEqual(getHistory(CHAT), [{ role: 'user', content: 'Messaggio di 5 ore fa' }]);
});

test('scrivere dopo il silenzio non riporta il contesto vecchio', () => {
  appendUser(CHAT, 'Vacanza dell’anno scorso');
  invecchia(CHAT, 24);

  appendUser(CHAT, 'Nuova richiesta');

  assert.deepEqual(getHistory(CHAT), [{ role: 'user', content: 'Nuova richiesta' }]);
});

test('la finestra scorre sull’ultimo messaggio, non sul primo', () => {
  appendUser(CHAT, 'Primo');
  invecchia(CHAT, 5); // il primo messaggio ha 5 ore
  appendAssistant(CHAT, 'Secondo'); // ma la conversazione è viva adesso

  assert.deepEqual(getHistory(CHAT), [
    { role: 'user', content: 'Primo' },
    { role: 'assistant', content: 'Secondo' },
  ]);
});
