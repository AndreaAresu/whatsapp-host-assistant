// telegram.js — la guardia di privacy del bot di controllo.
// Il bot è privato: /lista mostrerebbe i numeri dei clienti a chiunque
// trovasse lo username. Questi test coprono l'unica eccezione prevista
// (il /start iniziale) e il caso in cui TELEGRAM_CHAT_ID non è configurato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartellaTemporanea } from './helpers.js';

cartellaTemporanea('telegram'); // telegram.js importa allowlist.js: teniamola isolata

const { updateAutorizzato, troncaPerTelegram, MappaConScadenza } =
  await import('../src/telegram.js');

const HOST = '12345678';
const ESTRANEO = '99999999';

test('l’host passa, sia per from che per chat', () => {
  assert.equal(updateAutorizzato({ ownerId: HOST, fromId: HOST, chatId: HOST, testo: '/lista' }), true);
  assert.equal(updateAutorizzato({ ownerId: HOST, fromId: ESTRANEO, chatId: HOST, testo: '/lista' }), true);
  assert.equal(updateAutorizzato({ ownerId: HOST, fromId: HOST, chatId: ESTRANEO, testo: '/lista' }), true);
});

test('l’host passa anche se il chat id è un numero e non una stringa', () => {
  assert.equal(updateAutorizzato({ ownerId: 12345678, fromId: 12345678, chatId: 12345678 }), true);
});

test('un estraneo viene scartato', () => {
  assert.equal(updateAutorizzato({ ownerId: HOST, fromId: ESTRANEO, chatId: ESTRANEO, testo: '/lista' }), false);
});

test('a bot configurato nemmeno /start passa da un estraneo', () => {
  assert.equal(updateAutorizzato({ ownerId: HOST, fromId: ESTRANEO, chatId: ESTRANEO, testo: '/start' }), false);
});

test('un update senza mittente né chat viene scartato', () => {
  assert.equal(updateAutorizzato({ ownerId: HOST }), false);
});

test('finché TELEGRAM_CHAT_ID non è configurato passa solo /start', () => {
  // È l'unico modo per scoprire il proprio chat id: senza questa eccezione la
  // configurazione iniziale sarebbe impossibile.
  assert.equal(updateAutorizzato({ ownerId: undefined, fromId: ESTRANEO, testo: '/start' }), true);
  assert.equal(updateAutorizzato({ ownerId: '', fromId: ESTRANEO, testo: '/start@CostaReiBot' }), true);
  assert.equal(updateAutorizzato({ ownerId: undefined, fromId: ESTRANEO, testo: '  /start  ' }), true);
});

test('l’eccezione non si allarga ai comandi che toccano i dati dei clienti', () => {
  for (const testo of ['/lista', '/aggiungi 393331234567', '/rimuovi 393331234567', 'ciao']) {
    assert.equal(
      updateAutorizzato({ ownerId: undefined, fromId: ESTRANEO, testo }),
      false,
      `${testo} non deve passare a bot non configurato`
    );
  }
});

test('l’eccezione /start non si lascia aggirare da comandi che iniziano uguale', () => {
  assert.equal(updateAutorizzato({ ownerId: null, fromId: ESTRANEO, testo: '/startare' }), false);
  assert.equal(updateAutorizzato({ ownerId: null, fromId: ESTRANEO, testo: 'x /start' }), false);
});

test('senza chat id configurato un update senza testo (es. un pulsante) non passa', () => {
  assert.equal(updateAutorizzato({ ownerId: undefined, fromId: ESTRANEO, testo: undefined }), false);
});

test('un chat id non configurato non diventa mai la stringa "undefined"', () => {
  // Il rischio è String(undefined): bloccherebbe anche l'host, che non
  // combacerebbe con nessun id.
  assert.equal(updateAutorizzato({ ownerId: undefined, fromId: 'undefined', chatId: 'undefined', testo: '/lista' }), false);
});

// --- Troncamento: Telegram rifiuta i messaggi oltre i 4096 caratteri ---

test('un messaggio corto non viene toccato', () => {
  assert.equal(troncaPerTelegram('Bozza breve'), 'Bozza breve');
});

test('un messaggio al limite esatto non viene toccato', () => {
  const testo = 'a'.repeat(4096);
  assert.equal(troncaPerTelegram(testo), testo);
});

test('un messaggio troppo lungo viene troncato e segnalato', () => {
  const troncato = troncaPerTelegram('a'.repeat(5000));

  assert.ok(troncato.length <= 4096, `lunghezza ${troncato.length}`);
  assert.ok(troncato.endsWith('… (troncato)'));
});

// --- Voci pendenti che scadono (MappaConScadenza) --------------------------
//
// Le bozze non approvate restavano in memoria finché il processo viveva: su un
// VPS che gira per mesi è una perdita di memoria lenta. Un orologio finto
// permette di verificare la scadenza senza aspettare 24 ore.

const conOrologio = (opts = {}) => {
  let adesso = 0;
  const m = new MappaConScadenza({ ora: () => adesso, ...opts });
  return { m, avanza: (ms) => { adesso += ms; } };
};

test('una voce si legge normalmente prima della scadenza', () => {
  const { m, avanza } = conOrologio({ scadenzaMs: 1000 });
  m.set('a', { bozza: 'ciao' });
  avanza(999);
  assert.deepEqual(m.get('a'), { bozza: 'ciao' });
});

test('dopo la scadenza la voce sparisce', () => {
  const { m, avanza } = conOrologio({ scadenzaMs: 1000 });
  m.set('a', { bozza: 'ciao' });
  avanza(1001);
  assert.equal(m.get('a'), undefined, 'l’host vedrà «non più disponibile», non un errore');
  assert.equal(m.size, 0, 'e la voce non occupa più memoria');
});

test('un nuovo inserimento ripulisce le voci già scadute', () => {
  const { m, avanza } = conOrologio({ scadenzaMs: 1000 });
  m.set('vecchia', 1);
  avanza(2000);
  m.set('nuova', 2);
  assert.equal(m.size, 1);
  assert.equal(m.get('nuova'), 2);
});

test('oltre il tetto massimo escono per prime le voci più vecchie', () => {
  const { m } = conOrologio({ scadenzaMs: 10_000, max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) m.set(id, id);
  assert.equal(m.size, 3);
  assert.equal(m.get('a'), undefined, 'la più vecchia è uscita');
  assert.equal(m.get('d'), 'd');
});

test('onScadenza avvisa chi tiene un indice inverso', () => {
  // pendingUnknown è indicizzato anche per JID: senza questa richiamata quel
  // numero non verrebbe mai più segnalato all’host.
  const scartati = [];
  const { m, avanza } = conOrologio({ scadenzaMs: 1000 });
  m.onScadenza = (id, valore) => scartati.push([id, valore.jid]);
  m.set('x', { jid: '39333@s.whatsapp.net' });
  avanza(1001);
  m.get('x');
  assert.deepEqual(scartati, [['x', '39333@s.whatsapp.net']]);
});

test('delete rimuove subito, senza aspettare la scadenza', () => {
  const { m } = conOrologio({ scadenzaMs: 1000 });
  m.set('a', 1);
  m.delete('a');
  assert.equal(m.get('a'), undefined);
  assert.equal(m.size, 0);
});
