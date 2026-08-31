// knowledge.js — il testo che finisce nel system prompt: guida casa + FAQ.
// Il dettaglio che conta è la marcatura «SCADUTA»: senza, il modello si
// fiderebbe di un'informazione di zona vecchia di mesi.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cartellaTemporanea, GUIDA_FINTA } from './helpers.js';

// La guida casa la mette cartellaTemporanea() nella cartella usa-e-getta e
// CASA_PATH ci punta: il file vero è un file di runtime, fuori dal repo.
const dir = cartellaTemporanea('knowledge');
const PATH = join(dir, 'learned.json');
process.env.LEARNED_PATH = PATH;

const { loadKnowledge } = await import('../src/knowledge.js');

const scriviFaq = (faq) => writeFileSync(PATH, JSON.stringify(faq, null, 2));

beforeEach(() => rmSync(PATH, { force: true }));

test('la base di conoscenza contiene la guida casa indicata da CASA_PATH', () => {
  const { text, casa } = loadKnowledge();

  assert.equal(casa, GUIDA_FINTA);
  assert.match(text, /# GUIDA CASA/);
  assert.ok(text.includes(casa), 'la guida casa deve finire nel prompt per intero');
});

test('senza FAQ imparate lo dice esplicitamente', () => {
  const { text, learned } = loadKnowledge();

  assert.deepEqual(learned, []);
  assert.match(text, /\(nessuna FAQ imparata finora\)/);
});

test('una FAQ valida entra nel prompt con domanda, risposta e data', () => {
  scriviFaq([
    {
      id: '1',
      domanda: 'Dove si parcheggia?',
      risposta: 'Nel posto auto davanti al cancello.',
      categoria: 'regole_casa',
      data: '2026-01-15',
      scadenza: null,
    },
  ]);

  const { text } = loadKnowledge();

  assert.match(text, /\[regole_casa\] D: Dove si parcheggia\?/);
  assert.match(text, /R: Nel posto auto davanti al cancello\. \(approvata il 2026-01-15\)/);
  assert.doesNotMatch(text, /SCADUTA/);
});

test('una FAQ scaduta viene marcata «SCADUTA» nel prompt', () => {
  scriviFaq([
    {
      id: '1',
      domanda: 'Orari del supermercato?',
      risposta: 'Aperto fino alle 20.',
      categoria: 'info_zona',
      data: '2025-01-01',
      scadenza: '2025-04-01', // già passata
    },
  ]);

  const { text } = loadKnowledge();

  assert.match(text, /⚠️ SCADUTA \(da riverificare, non fidarti\)/);
});

test('FAQ valide e scadute convivono, marcate solo le seconde', () => {
  scriviFaq([
    { id: '1', domanda: 'Valida', risposta: 'Sì', categoria: 'regole_casa', data: '2026-01-01', scadenza: null },
    { id: '2', domanda: 'Vecchia', risposta: 'Forse', categoria: 'info_zona', data: '2025-01-01', scadenza: '2025-04-01' },
  ]);

  const { text, learned } = loadKnowledge();
  // Ogni FAQ occupa due righe: «- [categoria] D: ...» e «  R: ... (stato)».
  const righe = text.split('\n');
  const vocePer = (domanda) => {
    const i = righe.findIndex((r) => r.includes(`D: ${domanda}`));
    assert.notEqual(i, -1, `voce "${domanda}" assente dal prompt`);
    return righe.slice(i, i + 2).join('\n');
  };

  assert.equal(learned.length, 2);
  assert.doesNotMatch(vocePer('Valida'), /SCADUTA/);
  assert.match(vocePer('Vecchia'), /SCADUTA/);
});

test('un archivio FAQ rovinato non impedisce di costruire il prompt', (t) => {
  t.mock.method(console, 'error', () => {});
  writeFileSync(PATH, '{ questo non è un elenco }');

  const { text, learned } = loadKnowledge();

  assert.deepEqual(learned, []);
  assert.match(text, /# GUIDA CASA/);
});
