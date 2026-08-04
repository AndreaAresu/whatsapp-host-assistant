// brain.js — l'unica chiamata a Claude che decide tutto.
// L'API è finta (nessuna chiamata di rete, nessun costo): quello che si
// verifica è COME viene costruita la richiesta e COME viene letta la risposta.
// Il test più importante è quello sull'escalation di sicurezza: se il modello
// non consegna una decisione strutturata, il bot non deve inventarsi nulla.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cartellaTemporanea } from './helpers.js';

const dir = cartellaTemporanea('brain');
process.env.LEARNED_PATH = join(dir, 'learned.json'); // FAQ vuote: prompt prevedibile

// --- SDK Anthropic finto ---------------------------------------------------
const chiamate = []; // parametri di ogni messages.create()
let risposte = []; // coda di risposte finte, una per chiamata

class FakeAnthropic {
  constructor(opts) {
    FakeAnthropic.opts = opts;
    this.messages = {
      create: async (params) => {
        chiamate.push(params);
        if (!risposte.length) throw new Error('Il test non ha preparato altre risposte finte.');
        return risposte.shift();
      },
    };
  }
}

mock.module('@anthropic-ai/sdk', { defaultExport: FakeAnthropic });

const { think, evaluateForLearning, isSupportedImageType } = await import('../src/brain.js');

// --- Risposte finte pronte all'uso ---
const DECISIONE = {
  category: 'regole_casa',
  action: 'invia',
  language: 'it',
  draft: 'Il check-out è alle 10.',
  reason: 'Informazione presente nella guida casa.',
};

const conDecisione = (input = DECISIONE) => ({
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 20 },
  content: [
    { type: 'text', text: 'Cerco nella guida...' },
    { type: 'tool_use', id: 'tu_1', name: 'submit_response', input },
  ],
});

const risultatoRicerca = (risultati) => ({
  type: 'web_search_tool_result',
  content: risultati.map((r) => ({ type: 'web_search_result', ...r })),
});

beforeEach(() => {
  chiamate.length = 0;
  risposte = [];
});

// --- Lettura della decisione ----------------------------------------------

test('restituisce la decisione consegnata dal modello', async () => {
  risposte = [conDecisione()];

  const d = await think('A che ora è il check-out?');

  assert.equal(d.category, 'regole_casa');
  assert.equal(d.action, 'invia');
  assert.equal(d.language, 'it');
  assert.equal(d.draft, 'Il check-out è alle 10.');
  assert.deepEqual(d.sources, []);
  assert.deepEqual(d.usage, { input_tokens: 100, output_tokens: 20 });
});

test('SICUREZZA: senza decisione strutturata si escala, non si inventa', async () => {
  // Se il modello finisce con del testo libero invece di chiamare
  // submit_response, la bozza NON deve partire da sola in nessun caso.
  risposte = [
    { stop_reason: 'end_turn', usage: {}, content: [{ type: 'text', text: 'Direi le 10, credo.' }] },
  ];

  const d = await think('A che ora è il check-out?');

  assert.equal(d.action, 'escala');
  assert.equal(d.category, 'sensibile');
  assert.equal(d.draft, '', 'niente bozza inventata dal testo libero');
  assert.match(d.reason, /escalation per sicurezza/);
});

test('SICUREZZA: un tool diverso da submit_response non vale come decisione', async () => {
  risposte = [
    {
      stop_reason: 'tool_use',
      usage: {},
      content: [{ type: 'tool_use', name: 'web_search', input: { query: 'farmacia' } }],
    },
  ];

  const d = await think('Dov’è la farmacia?');

  assert.equal(d.action, 'escala');
});

// --- Costruzione della richiesta ------------------------------------------

test('la richiesta porta i due strumenti e il modello configurato', async () => {
  risposte = [conDecisione()];
  await think('Ciao');

  const [params] = chiamate;
  assert.deepEqual(params.tools.map((t) => t.name), ['web_search', 'submit_response']);
  assert.equal(params.tools[0].type, 'web_search_20250305');
  assert.equal(params.tools[0].user_location.city, 'Costa Rei');
  assert.ok(params.model, 'il modello deve essere impostato');
});

test('la base di conoscenza è un blocco a parte, con la cache attiva', async () => {
  risposte = [conDecisione()];
  await think('Ciao');

  const { system } = chiamate[0];
  assert.equal(system.length, 2);
  assert.equal(system[0].cache_control, undefined, 'le istruzioni non sono cachate');
  assert.deepEqual(system[1].cache_control, { type: 'ephemeral' });
  assert.match(system[1].text, /BASE DI CONOSCENZA/);
  assert.match(system[1].text, /# GUIDA CASA/);
});

test('il messaggio del cliente arriva come unico turno utente', async () => {
  risposte = [conDecisione()];
  await think('A che ora è il check-out?');

  assert.deepEqual(chiamate[0].messages, [
    { role: 'user', content: 'A che ora è il check-out?' },
  ]);
});

test('i messaggi di fila dello stesso ruolo vengono uniti (l’API vuole l’alternanza)', async () => {
  risposte = [conDecisione()];

  await think('E il parcheggio?', [
    { role: 'user', content: 'Ciao' },
    { role: 'user', content: 'Senti una cosa' },
    { role: 'assistant', content: 'Dimmi!' },
  ]);

  assert.deepEqual(chiamate[0].messages, [
    { role: 'user', content: 'Ciao\nSenti una cosa' },
    { role: 'assistant', content: 'Dimmi!' },
    { role: 'user', content: 'E il parcheggio?' },
  ]);
});

test('uno storico che inizia con l’assistente viene tagliato in testa', async () => {
  risposte = [conDecisione()];

  await think('Grazie!', [
    { role: 'assistant', content: 'Benvenuto!' }, // es. un messaggio di benvenuto dell'host
    { role: 'user', content: 'Ciao' },
    { role: 'assistant', content: 'Dimmi' },
  ]);

  assert.equal(chiamate[0].messages[0].role, 'user');
  assert.deepEqual(chiamate[0].messages.map((m) => m.content), ['Ciao', 'Dimmi', 'Grazie!']);
});

// --- Foto ------------------------------------------------------------------

test('con una foto il turno diventa multimodale, con l’immagine per prima', async () => {
  risposte = [conDecisione()];

  await think('Guarda che disastro', [], {
    image: { data: 'AAAA', mediaType: 'image/jpeg' },
  });

  assert.deepEqual(chiamate[0].messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    { type: 'text', text: 'Guarda che disastro' },
  ]);
});

test('una foto senza didascalia non lascia il testo vuoto', async () => {
  risposte = [conDecisione()];

  await think('', [], { image: { data: 'AAAA', mediaType: 'image/png' } });

  assert.equal(
    chiamate[0].messages[0].content[1].text,
    '(il cliente ha inviato una foto senza testo)'
  );
});

test('i formati immagine accettati dall’API sono filtrati a monte', () => {
  assert.equal(isSupportedImageType('image/jpeg'), true);
  assert.equal(isSupportedImageType('image/png'), true);
  assert.equal(isSupportedImageType('image/gif'), true);
  assert.equal(isSupportedImageType('image/webp'), true);
  assert.equal(isSupportedImageType('IMAGE/JPEG'), true);
  assert.equal(isSupportedImageType('image/jpeg; codecs=x'), true, 'i parametri vanno ignorati');
  assert.equal(isSupportedImageType('image/heic'), false, 'iPhone: non supportato dall’API');
  assert.equal(isSupportedImageType('application/pdf'), false);
  assert.equal(isSupportedImageType(undefined), false);
  assert.equal(isSupportedImageType(null), false);
});

// --- Ricerca web e pause_turn ---------------------------------------------

test('le fonti web finiscono nella decisione, senza doppioni', async () => {
  risposte = [
    {
      stop_reason: 'tool_use',
      usage: {},
      content: [
        risultatoRicerca([
          { url: 'https://a.it', title: 'A' },
          { url: 'https://b.it', title: 'B' },
          { url: 'https://a.it', title: 'A (doppione)' },
        ]),
        { type: 'tool_use', name: 'submit_response', input: { ...DECISIONE, category: 'info_zona', action: 'escala' } },
      ],
    },
  ];

  const d = await think('Dov’è la farmacia più vicina?');

  assert.deepEqual(d.sources, [
    { title: 'A', url: 'https://a.it' },
    { title: 'B', url: 'https://b.it' },
  ]);
});

test('con pause_turn la conversazione riprende da dove era rimasta', async () => {
  const contenutoPausa = [risultatoRicerca([{ url: 'https://a.it', title: 'A' }])];
  risposte = [
    { stop_reason: 'pause_turn', usage: {}, content: contenutoPausa },
    conDecisione({ ...DECISIONE, category: 'info_zona', action: 'escala' }),
  ];

  const d = await think('Dov’è la farmacia più vicina?');

  assert.equal(chiamate.length, 2, 'la ricerca va ripresa con una seconda chiamata');
  const ultimo = chiamate[1].messages.at(-1);
  assert.equal(ultimo.role, 'assistant');
  assert.deepEqual(ultimo.content, contenutoPausa, 'il turno interrotto va rimandato indietro');
  assert.equal(d.action, 'escala');
  assert.deepEqual(d.sources, [{ title: 'A', url: 'https://a.it' }], 'le fonti dei passi precedenti non si perdono');
});

test('il ciclo non gira all’infinito: dopo 5 passi si escala', async () => {
  risposte = Array.from({ length: 5 }, () => ({
    stop_reason: 'pause_turn',
    usage: {},
    content: [{ type: 'text', text: 'sto ancora cercando' }],
  }));

  const d = await think('Dov’è la farmacia più vicina?');

  assert.equal(chiamate.length, 5);
  assert.equal(d.action, 'escala');
});

// --- Valutazione per l'apprendimento ---------------------------------------

test('evaluateForLearning restituisce il giudizio del modello', async () => {
  risposte = [
    {
      content: [
        {
          type: 'tool_use',
          name: 'valuta_apprendimento',
          input: { reusable: true, categoria: 'info_zona', domanda: 'Dov’è la farmacia?' },
        },
      ],
    },
  ];

  const r = await evaluateForLearning('Scusa, dov’è la farmacia?', 'In centro, vicino alla piazza.');

  assert.deepEqual(r, { reusable: true, categoria: 'info_zona', domanda: 'Dov’è la farmacia?' });
  assert.deepEqual(chiamate[0].tool_choice, { type: 'tool', name: 'valuta_apprendimento' });
  assert.match(chiamate[0].messages[0].content, /In centro, vicino alla piazza\./);
});

test('se il modello non si esprime, non si impara niente', async () => {
  risposte = [{ content: [{ type: 'text', text: 'boh' }] }];

  const r = await evaluateForLearning('Domanda', 'Risposta');

  assert.equal(r.reusable, false, 'nel dubbio non si propone il salvataggio');
  assert.equal(r.domanda, 'Domanda');
});
