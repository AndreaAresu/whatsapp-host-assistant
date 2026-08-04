// allowlist.js — la lista dei numeri autorizzati.
// È il filtro che sta PRIMA di Claude: un numero fuori lista non deve mai
// generare una chiamata all'API. Qui contano soprattutto la normalizzazione
// (WhatsApp consegna JID, non numeri) e la persistenza su disco.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cartellaTemporanea } from './helpers.js';

const dir = cartellaTemporanea('allowlist');
const PATH = join(dir, 'allowlist.json');
process.env.ALLOWLIST_PATH = PATH; // prima dell'import: il modulo lo legge al caricamento

const {
  normalizeNumber, jidToNumber, isAllowed, isAllowedNumber,
  addNumber, removeNumber, listNumbers, loadAllowlist,
} = await import('../src/allowlist.js');

beforeEach(() => rmSync(PATH, { force: true }));

test('normalizeNumber tiene solo le cifre', () => {
  assert.equal(normalizeNumber('+39 333 12 34'), '393331234');
  assert.equal(normalizeNumber('39-333/1234'), '393331234');
  assert.equal(normalizeNumber(393331234), '393331234');
});

test('normalizeNumber non esplode su valori assenti o senza cifre', () => {
  assert.equal(normalizeNumber(null), '');
  assert.equal(normalizeNumber(undefined), '');
  assert.equal(normalizeNumber('pippo'), '');
});

test('jidToNumber estrae il numero dai JID di WhatsApp', () => {
  assert.equal(jidToNumber('393331234567@s.whatsapp.net'), '393331234567');
  assert.equal(jidToNumber('393331234567:12@s.whatsapp.net'), '393331234567'); // suffisso dispositivo
  assert.equal(jidToNumber('123456789012345@lid'), '123456789012345');
  assert.equal(jidToNumber(null), '');
});

test('la lista parte vuota se il file non esiste', () => {
  assert.deepEqual(loadAllowlist(), []);
  assert.deepEqual(listNumbers(), []);
});

test('un numero non in lista non è autorizzato', () => {
  addNumber('393331234567');
  assert.equal(isAllowedNumber('393339999999'), false);
  assert.equal(isAllowed('393339999999@s.whatsapp.net'), false);
});

test('un numero vuoto non è mai autorizzato', () => {
  addNumber('393331234567');
  assert.equal(isAllowedNumber(''), false);
  assert.equal(isAllowedNumber(null), false);
  assert.equal(isAllowed('@s.whatsapp.net'), false);
});

test('addNumber salva su disco e il numero risulta autorizzato', () => {
  const r = addNumber('+39 333 123 45 67');

  assert.deepEqual(r, { added: true, number: '393331234567' });
  assert.equal(isAllowedNumber('393331234567'), true);
  assert.equal(isAllowed('393331234567@s.whatsapp.net'), true);
  assert.equal(existsSync(PATH), true);
  assert.deepEqual(JSON.parse(readFileSync(PATH, 'utf8')), ['393331234567']);
});

test('addNumber accetta anche un JID intero', () => {
  const r = addNumber('393331234567:5@s.whatsapp.net');

  assert.deepEqual(r, { added: true, number: '393331234567' });
  assert.equal(isAllowedNumber('393331234567'), true);
});

test('addNumber non crea doppioni', () => {
  addNumber('393331234567');
  const r = addNumber('393 331 234 567');

  assert.equal(r.added, false);
  assert.equal(r.reason, 'già presente');
  assert.deepEqual(listNumbers(), ['393331234567']);
});

test('addNumber rifiuta un input senza cifre', () => {
  const r = addNumber('ciao');

  assert.equal(r.added, false);
  assert.equal(r.reason, 'numero non valido');
  assert.deepEqual(listNumbers(), []);
});

test('removeNumber toglie il numero e lo rende non autorizzato', () => {
  addNumber('393331234567');
  addNumber('393339999999');

  const r = removeNumber('+39 333 123 45 67');

  assert.deepEqual(r, { removed: true, number: '393331234567' });
  assert.equal(isAllowedNumber('393331234567'), false);
  assert.deepEqual(listNumbers(), ['393339999999'], 'gli altri numeri restano');
});

test('removeNumber su un numero assente non cambia nulla', () => {
  addNumber('393331234567');
  const r = removeNumber('393339999999');

  assert.deepEqual(r, { removed: false, number: '393339999999' });
  assert.deepEqual(listNumbers(), ['393331234567']);
});

test('la lista sopravvive a un riavvio (rilettura dal disco)', async () => {
  addNumber('393331234567');
  // Import fresco = come se il processo fosse ripartito.
  const modulo = await import(`../src/allowlist.js?riavvio=${Date.now()}`);
  assert.deepEqual(modulo.listNumbers(), ['393331234567']);
});
