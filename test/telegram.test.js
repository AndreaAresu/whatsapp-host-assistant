// telegram.js — la guardia di privacy del bot di controllo.
// Il bot è privato: /lista mostrerebbe i numeri dei clienti a chiunque
// trovasse lo username. Questi test coprono l'unica eccezione prevista
// (il /start iniziale) e il caso in cui TELEGRAM_CHAT_ID non è configurato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartellaTemporanea } from './helpers.js';

cartellaTemporanea('telegram'); // telegram.js importa allowlist.js: teniamola isolata

const { updateAutorizzato, troncaPerTelegram } = await import('../src/telegram.js');

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
