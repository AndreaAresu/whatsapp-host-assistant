// storage.js — scrittura atomica e lettura tollerante degli archivi JSON.
// Sono i file più preziosi del bot (numeri dei clienti, FAQ approvate a mano):
// qui verifichiamo che una scrittura interrotta non li tronchi e che un file
// rovinato venga messo da parte invece che sovrascritto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic, readJsonArray } from '../src/storage.js';
import { cartellaTemporanea, silenziaErrori } from './helpers.js';

const dir = cartellaTemporanea('storage');
const file = (nome) => join(dir, nome);

test('writeJsonAtomic scrive un JSON rileggibile e indentato', () => {
  const path = file('scrittura.json');
  writeJsonAtomic(path, [{ a: 1 }]);

  const raw = readFileSync(path, 'utf8');
  assert.deepEqual(JSON.parse(raw), [{ a: 1 }]);
  assert.match(raw, /\n  /, 'deve essere indentato, per poterlo correggere a mano');
});

test('writeJsonAtomic non lascia in giro il file temporaneo', () => {
  const path = file('senza-tmp.json');
  writeJsonAtomic(path, ['x']);

  assert.equal(existsSync(`${path}.tmp`), false);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    []
  );
});

test('writeJsonAtomic sovrascrive il contenuto precedente', () => {
  const path = file('sovrascrittura.json');
  writeJsonAtomic(path, ['vecchio']);
  writeJsonAtomic(path, ['nuovo']);

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), ['nuovo']);
});

test('writeJsonAtomic lascia intatto il file vecchio se la scrittura fallisce', () => {
  const path = file('inservibile.json');
  writeJsonAtomic(path, ['dati-preziosi']);

  // Un valore non serializzabile fa fallire JSON.stringify a metà strada.
  const ciclico = {};
  ciclico.se = ciclico;
  assert.throws(() => writeJsonAtomic(path, ciclico));

  assert.deepEqual(
    JSON.parse(readFileSync(path, 'utf8')),
    ['dati-preziosi'],
    'il file definitivo non deve essere stato toccato'
  );
  assert.equal(existsSync(`${path}.tmp`), false, 'il temporaneo va ripulito');
});

test('readJsonArray restituisce un elenco vuoto se il file non esiste', () => {
  assert.deepEqual(readJsonArray(file('mai-creato.json'), 'Prova'), []);
});

test('readJsonArray rilegge quello che writeJsonAtomic ha scritto', () => {
  const path = file('andata-e-ritorno.json');
  const dati = [{ id: '1', domanda: 'Wi-Fi?' }];
  writeJsonAtomic(path, dati);

  assert.deepEqual(readJsonArray(path, 'Prova'), dati);
});

test('readJsonArray mette in quarantena un file non JSON invece di ignorarlo', (t) => {
  silenziaErrori(t);
  const path = file('troncato.json');
  writeFileSync(path, '[{"domanda": "a moz'); // scrittura interrotta a metà

  assert.deepEqual(readJsonArray(path, 'Le FAQ imparate'), []);
  assert.equal(existsSync(path), false, 'il file rovinato non deve restare al suo posto');

  const quarantena = readdirSync(dir).filter((f) => f.startsWith('troncato.json.corrotto-'));
  assert.equal(quarantena.length, 1, 'deve esistere una copia recuperabile a mano');
  assert.equal(
    readFileSync(join(dir, quarantena[0]), 'utf8'),
    '[{"domanda": "a moz',
    'il contenuto originale deve restare integro nella copia'
  );
});

test('readJsonArray mette in quarantena anche un JSON valido che non è un elenco', (t) => {
  silenziaErrori(t);
  const path = file('oggetto.json');
  writeFileSync(path, '{"non": "un elenco"}');

  assert.deepEqual(readJsonArray(path, 'La lista dei numeri autorizzati'), []);
  assert.equal(existsSync(path), false);
  assert.equal(
    readdirSync(dir).filter((f) => f.startsWith('oggetto.json.corrotto-')).length,
    1
  );
});

test('readJsonArray non lancia mai: il bot deve poter partire comunque', (t) => {
  silenziaErrori(t);
  const path = file('cartella-non-file');
  // Una cartella al posto del file: readFileSync fallisce con EISDIR.
  writeJsonAtomic(join(dir, 'segnaposto.json'), []);
  assert.doesNotThrow(() => readJsonArray(dir, 'Percorso sbagliato'));
  assert.deepEqual(readJsonArray(path, 'Prova'), []);
});
