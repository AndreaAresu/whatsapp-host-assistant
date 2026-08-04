// learned.js — le FAQ imparate dalle risposte approvate dall'host.
// Il punto delicato è la scadenza: le info sulla zona invecchiano (un
// ristorante chiude), le regole della casa no.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { cartellaTemporanea } from './helpers.js';

const dir = cartellaTemporanea('learned');
const PATH = join(dir, 'learned.json');
process.env.LEARNED_PATH = PATH;

const { loadLearned, addLearned, isExpired } = await import('../src/learned.js');

const oggi = () => new Date().toISOString().slice(0, 10);
const traGiorni = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeEach(() => rmSync(PATH, { force: true }));

test('senza file le FAQ imparate sono un elenco vuoto', () => {
  assert.deepEqual(loadLearned(), []);
});

test('addLearned salva la FAQ con id, data e origine', () => {
  const entry = addLearned({
    domanda: 'Come funziona la raccolta differenziata?',
    risposta: 'Il martedì la plastica.',
    categoria: 'regole_casa',
    origine: 'telegram',
  });

  assert.match(entry.id, /^[0-9a-f-]{36}$/);
  assert.equal(entry.domanda, 'Come funziona la raccolta differenziata?');
  assert.equal(entry.risposta, 'Il martedì la plastica.');
  assert.equal(entry.categoria, 'regole_casa');
  assert.equal(entry.origine, 'telegram');
  assert.equal(entry.data, oggi());
  assert.deepEqual(loadLearned(), [entry], 'deve essere finita su disco');
});

test('le regole della casa non scadono', () => {
  const entry = addLearned({
    domanda: 'A che ora è il check-out?',
    risposta: 'Alle 10.',
    categoria: 'regole_casa',
    origine: 'telegram',
  });

  assert.equal(entry.scadenza, null);
  assert.equal(isExpired(entry), false);
});

test('le info sulla zona scadono dopo 90 giorni', () => {
  const entry = addLearned({
    domanda: 'Dov’è la farmacia più vicina?',
    risposta: 'In centro a Costa Rei.',
    categoria: 'info_zona',
    origine: 'manuale',
  });

  assert.equal(entry.scadenza, traGiorni(90));
  assert.equal(isExpired(entry), false, 'appena salvata non è scaduta');
  assert.equal(
    isExpired(entry, new Date(Date.now() + 89 * 86400000)),
    false,
    'a 89 giorni è ancora valida'
  );
  assert.equal(
    isExpired(entry, new Date(Date.now() + 91 * 86400000)),
    true,
    'a 91 giorni è scaduta'
  );
});

test('isExpired non considera scaduto ciò che non ha scadenza', () => {
  assert.equal(isExpired({ scadenza: null }), false);
  assert.equal(isExpired({}), false);
});

test('le FAQ si accumulano senza perdere le precedenti', () => {
  addLearned({ domanda: 'D1', risposta: 'R1', categoria: 'regole_casa', origine: 'telegram' });
  addLearned({ domanda: 'D2', risposta: 'R2', categoria: 'info_zona', origine: 'manuale' });

  const list = loadLearned();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((f) => f.domanda), ['D1', 'D2']);
  assert.notEqual(list[0].id, list[1].id, 'ogni FAQ ha un id suo');
});
