// telegram.js — il bot di controllo per intero, ma senza rete: le chiamate
// all'API Telegram sono intercettate da un "transformer" di grammy e
// registrate, e gli update arrivano a mano con bot.handleUpdate().
//
// Qui si verifica quello che i test sulle funzioni pure non vedono: che la
// guardia di privacy sia davvero collegata, e che i pulsanti non perdano
// niente quando l'invio o il salvataggio falliscono.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cartellaTemporanea } from './helpers.js';

// Prima di ogni import da src/: telegram.js importa allowlist.js, e i comandi
// /aggiungi e /rimuovi scrivono davvero. Senza questa riga un test (o un bug
// nella guardia di privacy) finirebbe per modificare la lista vera dell'host.
cartellaTemporanea('telegram-bot');

const { config } = await import('../src/config.js');
config.telegramToken = '111111:FINTO-PER-I-TEST';
config.telegramChatId = '12345678';

const { createControlBot } = await import('../src/telegram.js');

const HOST = 12345678;
const ESTRANEO = 99999999;

/** Crea il bot con le API finte e le spie sui callback. */
function creaBot() {
  const spie = { approvate: [], salvate: [], aggiunti: [] };
  const errori = { approva: null, salva: null, aggiungi: null };

  const { bot, ...api } = createControlBot({
    onApprove: async (item, finalText) => {
      if (errori.approva) throw errori.approva;
      spie.approvate.push({ item, finalText });
    },
    onSaveConfirmed: async (item) => {
      if (errori.salva) throw errori.salva;
      spie.salvate.push(item);
    },
    onAddAndReply: async (item) => {
      if (errori.aggiungi) throw errori.aggiungi;
      spie.aggiunti.push(item);
    },
  });

  bot.botInfo = { id: 1, is_bot: true, first_name: 'Costa Rei', username: 'CostaReiTestBot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business_account: false, has_main_web_app: false };

  const chiamate = [];
  bot.api.config.use(async (_prev, method, payload) => {
    chiamate.push({ method, payload });
    if (method === 'sendMessage' || method === 'editMessageText') {
      return { ok: true, result: { message_id: chiamate.length, date: 0,
        chat: { id: HOST, type: 'private' }, text: payload.text } };
    }
    return { ok: true, result: true };
  });

  return { bot, chiamate, spie, errori, ...api };
}

const messaggio = (testo, from = HOST) => ({
  update_id: Math.floor(Math.random() * 1e9),
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    date: 1,
    chat: { id: from, type: 'private' },
    from: { id: from, is_bot: false, first_name: 'Tizio' },
    text: testo,
    ...(testo.startsWith('/')
      ? { entities: [{ type: 'bot_command', offset: 0, length: testo.split(' ')[0].length }] }
      : {}),
  },
});

const pulsante = (data, from = HOST) => ({
  update_id: Math.floor(Math.random() * 1e9),
  callback_query: {
    id: `cb-${randomUUID()}`,
    chat_instance: 'x',
    from: { id: from, is_bot: false, first_name: 'Tizio' },
    data,
    message: {
      message_id: 10, date: 1, chat: { id: from, type: 'private' }, text: 'bozza',
    },
  },
});

const BOZZA = {
  draftId: 'draft-1',
  conversationId: '393331234567@s.whatsapp.net',
  clientName: 'Marco',
  question: 'Quanto costa la settimana di agosto?',
  decision: {
    category: 'sensibile', action: 'escala', language: 'it',
    draft: 'Ti confermo il prezzo a breve.', reason: 'Riguarda un prezzo.',
  },
};

const testiInviati = (chiamate) =>
  chiamate.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);
const callbackDelPrimoPulsante = (chiamata) =>
  chiamata.payload.reply_markup.inline_keyboard[0][0].callback_data;

let ctx;
beforeEach(() => { ctx = creaBot(); });

// --- Privacy: il bot è solo dell'host ---------------------------------------

test('un estraneo non ottiene nulla, nemmeno una risposta', async () => {
  await ctx.bot.handleUpdate(messaggio('/lista', ESTRANEO));
  await ctx.bot.handleUpdate(messaggio('/aggiungi 393331234567', ESTRANEO));
  await ctx.bot.handleUpdate(messaggio('ciao', ESTRANEO));

  assert.deepEqual(ctx.chiamate, [], 'nessuna chiamata a Telegram: silenzio totale');
});

test('un estraneo non può premere i pulsanti delle bozze', async () => {
  await ctx.requestApproval(BOZZA);
  ctx.chiamate.length = 0;

  await ctx.bot.handleUpdate(pulsante('send:draft-1', ESTRANEO));

  assert.deepEqual(ctx.spie.approvate, [], 'niente deve partire al cliente');
  assert.deepEqual(ctx.chiamate, []);
});

test('l’host invece è servito', async () => {
  await ctx.bot.handleUpdate(messaggio('/lista'));

  assert.equal(ctx.chiamate.length, 1);
  assert.equal(ctx.chiamate[0].method, 'sendMessage');
});

// --- Comandi sulla lista dei numeri -----------------------------------------

test('/aggiungi, /lista e /rimuovi gestiscono la lista dall’host', async () => {
  await ctx.bot.handleUpdate(messaggio('/aggiungi +39 333 123 45 67'));
  assert.match(testiInviati(ctx.chiamate).at(-1), /✅ Aggiunto: 393331234567/);

  await ctx.bot.handleUpdate(messaggio('/lista'));
  assert.match(testiInviati(ctx.chiamate).at(-1), /Numeri autorizzati \(1\):\n• 393331234567/);

  await ctx.bot.handleUpdate(messaggio('/rimuovi 393331234567'));
  assert.match(testiInviati(ctx.chiamate).at(-1), /🗑 Rimosso: 393331234567/);

  await ctx.bot.handleUpdate(messaggio('/lista'));
  assert.match(testiInviati(ctx.chiamate).at(-1), /La lista è vuota/);
});

test('/aggiungi senza numero spiega come si usa invece di sbagliare', async () => {
  await ctx.bot.handleUpdate(messaggio('/aggiungi'));

  assert.match(testiInviati(ctx.chiamate).at(-1), /Uso: \/aggiungi <numero>/);
});

test('/rimuovi su un numero non in lista lo dice e basta', async () => {
  await ctx.bot.handleUpdate(messaggio('/rimuovi 393339999999'));

  assert.match(testiInviati(ctx.chiamate).at(-1), /Non era in lista: 393339999999/);
});

test('/start rivela il chat id, che serve per configurare il bot', async () => {
  await ctx.bot.handleUpdate(messaggio('/start'));

  assert.match(testiInviati(ctx.chiamate).at(-1), new RegExp(`Il tuo chat id è: ${HOST}`));
});

// --- Bozze: invia / modifica / ignora ---------------------------------------

test('la bozza arriva all’host con contesto e tre pulsanti', async () => {
  await ctx.requestApproval(BOZZA);

  const [{ method, payload }] = ctx.chiamate;
  assert.equal(method, 'sendMessage');
  assert.equal(String(payload.chat_id), String(HOST));
  assert.match(payload.text, /Marco/);
  assert.match(payload.text, /Quanto costa la settimana di agosto\?/);
  assert.match(payload.text, /Categoria: sensibile · Riguarda un prezzo\./);
  assert.match(payload.text, /Ti confermo il prezzo a breve\./);
  assert.deepEqual(
    payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ['send:draft-1', 'edit:draft-1', 'ignore:draft-1']
  );
});

test('le fonti web trovate vengono mostrate all’host', async () => {
  await ctx.requestApproval({
    ...BOZZA,
    decision: { ...BOZZA.decision, sources: [{ url: 'https://esempio.it', title: 'Esempio' }] },
  });

  assert.match(ctx.chiamate[0].payload.text, /Fonti:\n• https:\/\/esempio\.it/);
});

test('«Invia» manda la bozza al cliente e chiude il messaggio', async () => {
  await ctx.requestApproval(BOZZA);

  await ctx.bot.handleUpdate(pulsante('send:draft-1'));

  assert.equal(ctx.spie.approvate.length, 1);
  assert.equal(ctx.spie.approvate[0].finalText, 'Ti confermo il prezzo a breve.');
  assert.equal(ctx.spie.approvate[0].item.conversationId, BOZZA.conversationId);
  assert.ok(ctx.chiamate.some((c) => c.method === 'editMessageText' && /✅ Inviata a Marco/.test(c.payload.text)));
});

test('«Ignora» non manda niente al cliente', async () => {
  await ctx.requestApproval(BOZZA);

  await ctx.bot.handleUpdate(pulsante('ignore:draft-1'));

  assert.deepEqual(ctx.spie.approvate, []);
  assert.ok(ctx.chiamate.some((c) => c.method === 'editMessageText' && /🚫 Ignorata/.test(c.payload.text)));
});

test('una bozza già decisa non si può rigiocare', async () => {
  await ctx.requestApproval(BOZZA);
  await ctx.bot.handleUpdate(pulsante('send:draft-1'));

  await ctx.bot.handleUpdate(pulsante('send:draft-1'));

  assert.equal(ctx.spie.approvate.length, 1, 'il cliente non deve ricevere due volte');
});

test('«Modifica»: il testo scritto dall’host sostituisce la bozza', async () => {
  await ctx.requestApproval(BOZZA);

  await ctx.bot.handleUpdate(pulsante('edit:draft-1'));
  await ctx.bot.handleUpdate(messaggio('Sono 800€ a settimana, tutto incluso.'));

  assert.equal(ctx.spie.approvate.length, 1);
  assert.equal(ctx.spie.approvate[0].finalText, 'Sono 800€ a settimana, tutto incluso.');
});

test('un messaggio dell’host fuori dalla modifica non viene inviato a nessuno', async () => {
  await ctx.requestApproval(BOZZA);

  await ctx.bot.handleUpdate(messaggio('appunto per me'));

  assert.deepEqual(ctx.spie.approvate, []);
});

test('dopo una modifica il bot non resta in ascolto della successiva', async () => {
  await ctx.requestApproval(BOZZA);
  await ctx.bot.handleUpdate(pulsante('edit:draft-1'));
  await ctx.bot.handleUpdate(messaggio('Testo corretto'));

  await ctx.bot.handleUpdate(messaggio('un pensiero a voce alta'));

  assert.equal(ctx.spie.approvate.length, 1);
});

test('se l’invio al cliente fallisce la bozza resta pendente e riprovabile', async () => {
  // Caso reale: WhatsApp disconnesso. L'host non deve riscriversi la risposta.
  await ctx.requestApproval(BOZZA);
  ctx.errori.approva = new Error('WhatsApp disconnesso');

  await ctx.bot.handleUpdate(pulsante('send:draft-1'));

  assert.deepEqual(ctx.spie.approvate, []);
  assert.ok(testiInviati(ctx.chiamate).some((t) => /non è riuscito/.test(t)), 'l’host deve saperlo');

  ctx.errori.approva = null;
  await ctx.bot.handleUpdate(pulsante('send:draft-1'));
  assert.equal(ctx.spie.approvate.length, 1, 'il secondo tentativo deve funzionare');
});

test('se fallisce l’invio del testo corretto, l’host resta in modifica', async () => {
  await ctx.requestApproval(BOZZA);
  await ctx.bot.handleUpdate(pulsante('edit:draft-1'));
  ctx.errori.approva = new Error('WhatsApp disconnesso');
  await ctx.bot.handleUpdate(messaggio('Primo tentativo'));

  ctx.errori.approva = null;
  await ctx.bot.handleUpdate(messaggio('Secondo tentativo'));

  assert.equal(ctx.spie.approvate.length, 1);
  assert.equal(ctx.spie.approvate[0].finalText, 'Secondo tentativo');
});

// --- FAQ imparate: si salva solo su conferma dell'host ----------------------

const DA_SALVARE = {
  saveId: 'save-1',
  domanda: 'Dov’è la farmacia?',
  risposta: 'In centro, vicino alla piazza.',
  categoria: 'info_zona',
  origine: 'telegram',
};

test('la conferma di salvataggio arriva con i due pulsanti', async () => {
  await ctx.requestSaveConfirmation(DA_SALVARE);

  const [{ payload }] = ctx.chiamate;
  assert.match(payload.text, /Vuoi salvare questa come FAQ riutilizzabile\?/);
  assert.deepEqual(
    payload.reply_markup.inline_keyboard[0].map((b) => b.callback_data),
    ['keep:save-1', 'drop:save-1']
  );
});

test('«Salva» è l’unica strada per finire nelle FAQ', async () => {
  await ctx.requestSaveConfirmation(DA_SALVARE);

  await ctx.bot.handleUpdate(pulsante('keep:save-1'));

  assert.deepEqual(ctx.spie.salvate, [DA_SALVARE]);
});

test('«No» non salva niente', async () => {
  await ctx.requestSaveConfirmation(DA_SALVARE);

  await ctx.bot.handleUpdate(pulsante('drop:save-1'));

  assert.deepEqual(ctx.spie.salvate, []);
});

test('se il salvataggio su disco fallisce, la FAQ resta riprovabile', async () => {
  await ctx.requestSaveConfirmation(DA_SALVARE);
  ctx.errori.salva = new Error('disco pieno');

  await ctx.bot.handleUpdate(pulsante('keep:save-1'));
  assert.deepEqual(ctx.spie.salvate, []);

  ctx.errori.salva = null;
  await ctx.bot.handleUpdate(pulsante('keep:save-1'));
  assert.equal(ctx.spie.salvate.length, 1, 'la FAQ non deve essere andata persa');
});

// --- Numeri sconosciuti -----------------------------------------------------

const SCONOSCIUTO = {
  jid: '393339999999@s.whatsapp.net',
  number: '393339999999',
  name: 'Numero nuovo',
  text: 'Ciao, avete disponibilità?',
};

test('un numero fuori lista viene segnalato con la scelta', async () => {
  await ctx.requestUnknownApproval(SCONOSCIUTO);

  const [{ payload }] = ctx.chiamate;
  assert.match(payload.text, /NON in lista/);
  assert.match(payload.text, /393339999999/);
  assert.match(payload.text, /Ciao, avete disponibilità\?/);
});

test('lo stesso sconosciuto non viene segnalato due volte', async () => {
  await ctx.requestUnknownApproval(SCONOSCIUTO);
  await ctx.requestUnknownApproval({ ...SCONOSCIUTO, text: 'C’è nessuno?' });

  assert.equal(ctx.chiamate.length, 1, 'niente raffiche di notifiche per lo stesso numero');
});

test('«Aggiungi e rispondi» passa il messaggio originale alla pipeline', async () => {
  await ctx.requestUnknownApproval(SCONOSCIUTO);
  const dati = callbackDelPrimoPulsante(ctx.chiamate[0]);

  await ctx.bot.handleUpdate(pulsante(dati));

  assert.deepEqual(ctx.spie.aggiunti, [SCONOSCIUTO]);
});

test('«Ignora» su uno sconosciuto non lo aggiunge', async () => {
  await ctx.requestUnknownApproval(SCONOSCIUTO);
  const dati = callbackDelPrimoPulsante(ctx.chiamate[0]).replace('addnum:', 'dropnum:');

  await ctx.bot.handleUpdate(pulsante(dati));

  assert.deepEqual(ctx.spie.aggiunti, []);
});

// --- Robustezza -------------------------------------------------------------

test('notifyHost non lancia mai, nemmeno se Telegram è irraggiungibile', async (t) => {
  t.mock.method(console, 'error', () => {});
  const rotto = creaBot();
  rotto.bot.api.config.use(async () => { throw new Error('rete assente'); });

  await assert.doesNotReject(() => rotto.notifyHost('avviso'));
});

test('i messaggi lunghi vengono troncati prima di partire', async () => {
  await ctx.notifyHost('a'.repeat(6000));

  const [{ payload }] = ctx.chiamate;
  assert.ok(payload.text.length <= 4096, `lunghezza ${payload.text.length}`);
  assert.ok(payload.text.endsWith('… (troncato)'));
});

test('un pulsante di una bozza scomparsa non fa saltare il bot', async () => {
  await assert.doesNotReject(() => ctx.bot.handleUpdate(pulsante('send:mai-esistita')));
  await assert.doesNotReject(() => ctx.bot.handleUpdate(pulsante('keep:mai-esistita')));
  await assert.doesNotReject(() => ctx.bot.handleUpdate(pulsante('addnum:mai-esistito')));
  assert.deepEqual(ctx.spie.approvate, []);
});
