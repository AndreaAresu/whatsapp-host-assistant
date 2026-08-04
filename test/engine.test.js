// engine.js — la decisione "parte da sola o la vede prima l'host?".
// È la valvola di sicurezza principale del bot: qui il "cervello" è finto,
// perché quello che conta è solo l'instradamento della risposta.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cartellaTemporanea } from './helpers.js';

cartellaTemporanea('engine'); // rete di sicurezza: nessun archivio vero raggiungibile

// --- Cervello finto: restituisce la decisione preparata dal test ---
let decisione;
const chiamateThink = [];

mock.module(new URL('../src/brain.js', import.meta.url).href, {
  namedExports: {
    think: async (text, history, opts) => {
      chiamateThink.push({ text, history, opts });
      return decisione;
    },
  },
});

const { handleClientMessage } = await import('../src/engine.js');
const { config } = await import('../src/config.js');

const INVIABILE = {
  category: 'regole_casa',
  action: 'invia',
  language: 'it',
  draft: 'Il check-out è alle 10.',
  reason: 'Sta nella guida casa.',
};
const DA_ESCALARE = {
  category: 'sensibile',
  action: 'escala',
  language: 'it',
  draft: 'Ti confermo appena possibile.',
  reason: 'Riguarda un pagamento.',
};

/** Prepara la chiamata con due spie al posto dei canali reali. */
function scenario(decisioneModello, { rodaggio }) {
  decisione = decisioneModello;
  config.reviewEverything = rodaggio;
  const inviati = [];
  const approvazioni = [];
  return {
    inviati,
    approvazioni,
    esegui: (extra = {}) =>
      handleClientMessage({
        conversationId: '393331234567@s.whatsapp.net',
        clientName: 'Marco',
        text: 'A che ora è il check-out?',
        sendToClient: async (jid, testo) => inviati.push({ jid, testo }),
        requestApproval: async (item) => approvazioni.push(item),
        ...extra,
      }),
  };
}

const rodaggioIniziale = config.reviewEverything;
beforeEach(() => {
  chiamateThink.length = 0;
  config.reviewEverything = rodaggioIniziale;
});

test('fuori rodaggio una risposta sicura parte da sola', async () => {
  const s = scenario(INVIABILE, { rodaggio: false });

  const r = await s.esegui();

  assert.equal(r.routed, 'auto-sent');
  assert.deepEqual(s.inviati, [
    { jid: '393331234567@s.whatsapp.net', testo: 'Il check-out è alle 10.' },
  ]);
  assert.deepEqual(s.approvazioni, [], "l'host non viene disturbato");
});

test('in rodaggio anche la risposta sicura passa dall’host', async () => {
  // REVIEW_EVERYTHING è la valvola di sicurezza: se è attiva, niente esce da solo.
  const s = scenario(INVIABILE, { rodaggio: true });

  const r = await s.esegui();

  assert.equal(r.routed, 'escalated');
  assert.deepEqual(s.inviati, [], 'al cliente non deve arrivare niente');
  assert.equal(s.approvazioni.length, 1);
});

test('una domanda sensibile va all’host anche fuori rodaggio', async () => {
  const s = scenario(DA_ESCALARE, { rodaggio: false });

  const r = await s.esegui();

  assert.equal(r.routed, 'escalated');
  assert.deepEqual(s.inviati, []);
  assert.equal(s.approvazioni.length, 1);
});

test('la bozza inviata all’host porta tutto il contesto per decidere', async () => {
  const s = scenario(DA_ESCALARE, { rodaggio: false });

  await s.esegui();

  const [item] = s.approvazioni;
  assert.match(item.draftId, /^[0-9a-f-]{36}$/);
  assert.equal(item.conversationId, '393331234567@s.whatsapp.net');
  assert.equal(item.clientName, 'Marco');
  assert.equal(item.question, 'A che ora è il check-out?');
  assert.deepEqual(item.decision, DA_ESCALARE);
});

test('ogni bozza ha un identificativo diverso', async () => {
  const s = scenario(DA_ESCALARE, { rodaggio: false });

  await s.esegui();
  await s.esegui();

  assert.notEqual(s.approvazioni[0].draftId, s.approvazioni[1].draftId);
});

test('storico e foto arrivano al cervello così come sono', async () => {
  const s = scenario(INVIABILE, { rodaggio: false });
  const history = [{ role: 'user', content: 'Ciao' }];
  const image = { data: 'AAAA', mediaType: 'image/jpeg' };

  await s.esegui({ history, image });

  assert.equal(chiamateThink.length, 1);
  assert.equal(chiamateThink[0].text, 'A che ora è il check-out?');
  assert.deepEqual(chiamateThink[0].history, history);
  assert.deepEqual(chiamateThink[0].opts, { image });
});

test('senza storico il cervello riceve comunque un elenco vuoto', async () => {
  const s = scenario(INVIABILE, { rodaggio: false });

  await s.esegui();

  assert.deepEqual(chiamateThink[0].history, []);
});

test('se l’invio al cliente fallisce, l’errore non resta nascosto', async () => {
  // index.js conta su questo per avvisare l'host: se l'eccezione venisse
  // inghiottita qui, il cliente resterebbe senza risposta e nessuno lo saprebbe.
  const s = scenario(INVIABILE, { rodaggio: false });

  await assert.rejects(
    () => s.esegui({ sendToClient: async () => { throw new Error('WhatsApp disconnesso'); } }),
    /WhatsApp disconnesso/
  );
});
