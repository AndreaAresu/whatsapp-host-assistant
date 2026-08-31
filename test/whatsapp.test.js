// whatsapp.js — le funzioni pure che leggono i messaggi Baileys.
// Qui non c'è nessuna connessione: si verifica solo come vengono interpretati
// i messaggi in arrivo (testo, media, JID), che è la parte che sbaglia in
// silenzio quando WhatsApp cambia formato.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartellaTemporanea } from './helpers.js';

cartellaTemporanea('whatsapp'); // whatsapp.js importa allowlist.js: teniamola isolata

const {
  extractText, describeMedia, unwrapMessage, declaredFileLength, resolvePhoneNumber,
  classificaMessaggio,
} = await import('../src/whatsapp.js');

// Costruisce un messaggio Baileys minimo attorno a un contenuto.
const messaggio = (message, { jid = '39333111@s.whatsapp.net', fromMe = false } = {}) => ({
  key: { remoteJid: jid, fromMe, id: 'ABC' },
  message,
});

// --- Testo ---

test('estrae il testo di un messaggio semplice', () => {
  assert.equal(extractText({ conversation: '  Ciao!  ' }), 'Ciao!');
});

test('estrae il testo di un messaggio con citazione o link', () => {
  assert.equal(extractText({ extendedTextMessage: { text: 'Guarda qui' } }), 'Guarda qui');
});

test('la didascalia di una foto vale come testo del messaggio', () => {
  assert.equal(
    extractText({ imageMessage: { caption: 'Il rubinetto perde', mimetype: 'image/jpeg' } }),
    'Il rubinetto perde'
  );
});

test('senza testo utile restituisce stringa vuota', () => {
  assert.equal(extractText({ imageMessage: { mimetype: 'image/jpeg' } }), '');
  assert.equal(extractText({ audioMessage: { ptt: true } }), '');
  assert.equal(extractText({}), '');
});

test('i messaggi effimeri e view-once vengono spacchettati', () => {
  assert.equal(extractText({ ephemeralMessage: { message: { conversation: 'Effimero' } } }), 'Effimero');
  assert.equal(extractText({ viewOnceMessageV2: { message: { conversation: 'Una volta sola' } } }), 'Una volta sola');
  assert.deepEqual(unwrapMessage({ conversation: 'Nudo' }), { conversation: 'Nudo' });
});

test('la didascalia di un documento inviato come file viene letta', () => {
  const msg = {
    documentWithCaptionMessage: {
      message: { documentMessage: { caption: 'Ecco la ricevuta', mimetype: 'application/pdf' } },
    },
  };
  assert.equal(extractText(msg), 'Ecco la ricevuta');
});

// --- Classificazione dei media ---

test('riconosce una foto', () => {
  assert.deepEqual(
    describeMedia({ imageMessage: { mimetype: 'image/jpeg' } }),
    { kind: 'foto', mimetype: 'image/jpeg' }
  );
});

test('distingue la nota vocale dall’audio inviato come file', () => {
  assert.deepEqual(
    describeMedia({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } }),
    { kind: 'nota vocale', mimetype: 'audio/ogg; codecs=opus' }
  );
  assert.deepEqual(
    describeMedia({ audioMessage: { ptt: false, mimetype: 'audio/mpeg' } }),
    { kind: 'audio', mimetype: 'audio/mpeg' }
  );
});

test('riconosce i media che il bot non gestisce', () => {
  assert.equal(describeMedia({ videoMessage: { mimetype: 'video/mp4' } }).kind, 'video');
  assert.equal(describeMedia({ stickerMessage: { mimetype: 'image/webp' } }).kind, 'sticker');
  assert.equal(describeMedia({ contactMessage: {} }).kind, 'contatto');
  assert.equal(describeMedia({ locationMessage: {} }).kind, 'posizione');
  assert.equal(describeMedia({ liveLocationMessage: {} }).kind, 'posizione');
});

test('riconosce un documento anche quando è annidato con didascalia', () => {
  assert.deepEqual(
    describeMedia({ documentMessage: { mimetype: 'application/pdf' } }),
    { kind: 'documento', mimetype: 'application/pdf' }
  );
  assert.deepEqual(
    describeMedia({
      documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'image/jpeg' } } },
    }),
    { kind: 'documento', mimetype: 'image/jpeg' }
  );
});

test('un messaggio di solo testo non è un media', () => {
  assert.equal(describeMedia({ conversation: 'Ciao' }), null);
  assert.equal(describeMedia({}), null);
});

test('anche i media dentro un view-once vengono riconosciuti', () => {
  const msg = { viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } } };
  assert.deepEqual(describeMedia(msg), { kind: 'foto', mimetype: 'image/jpeg' });
});

// --- Dimensione dichiarata (usata per scartare i file enormi prima di scaricarli) ---

test('legge la dimensione dichiarata dal mittente', () => {
  assert.equal(declaredFileLength({ imageMessage: { fileLength: 123456 } }), 123456);
  assert.equal(declaredFileLength({ audioMessage: { fileLength: '2048' } }), 2048);
});

test('una dimensione assente o illeggibile vale zero, non NaN', () => {
  // Baileys può consegnare un oggetto Long: Number() darebbe NaN, e un NaN
  // passerebbe il confronto "> MAX" facendo scaricare comunque il file.
  assert.equal(declaredFileLength({ imageMessage: { fileLength: { low: 5, high: 0 } } }), 0);
  assert.equal(declaredFileLength({ imageMessage: {} }), 0);
  assert.equal(declaredFileLength({ conversation: 'testo' }), 0);
  assert.equal(declaredFileLength({}), 0);
});

// --- Numero di telefono (Baileys 7 usa i LID) ---

const sockSenzaMapping = {};

test('un JID normale dà direttamente il numero', async () => {
  const num = await resolvePhoneNumber(sockSenzaMapping, {
    remoteJid: '393331234567@s.whatsapp.net',
  });
  assert.equal(num, '393331234567');
});

test('con un LID si usa il remoteJidAlt se c’è', async () => {
  const num = await resolvePhoneNumber(sockSenzaMapping, {
    remoteJid: '123456789012345@lid',
    remoteJidAlt: '393331234567@s.whatsapp.net',
  });
  assert.equal(num, '393331234567');
});

test('con un LID senza alt si chiede la mappatura a Baileys', async () => {
  const sock = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          assert.equal(lid, '123456789012345@lid');
          return '393331234567@s.whatsapp.net';
        },
      },
    },
  };

  assert.equal(await resolvePhoneNumber(sock, { remoteJid: '123456789012345@lid' }), '393331234567');
});

test('se la mappatura LID fallisce si ripiega sulle cifre del LID', async () => {
  // Il numero risultante non sarà in allowlist: il messaggio finisce all'host
  // come "numero sconosciuto" invece di far crollare la gestione del messaggio.
  const sock = {
    signalRepository: {
      lidMapping: { getPNForLID: async () => { throw new Error('mapping non disponibile'); } },
    },
  };

  assert.equal(await resolvePhoneNumber(sock, { remoteJid: '123456789012345@lid' }), '123456789012345');
});

test('se la mappatura non esiste proprio non si esplode', async () => {
  assert.equal(
    await resolvePhoneNumber(sockSenzaMapping, { remoteJid: '123456789012345@lid' }),
    '123456789012345'
  );
});

// --- Instradamento (classificaMessaggio) ---
//
// REGRESSIONE: prima l'instradamento partiva da extractText(), che per una foto
// restituisce la DIDASCALIA. Una foto con didascalia finiva così sul ramo testo:
// l'immagine non veniva mai scaricata né mostrata a Claude. Questi test coprono
// la decisione che allora non era raggiungibile perché chiusa nella closure di
// startWhatsApp().

test('un messaggio di solo testo va sul ramo testo', () => {
  const r = classificaMessaggio(messaggio({ conversation: 'A che ora è il check-in?' }));
  assert.equal(r.rotta, 'testo');
  assert.equal(r.testo, 'A che ora è il check-in?');
});

test('REGRESSIONE: una foto CON didascalia va sul ramo media, non su quello testo', () => {
  const r = classificaMessaggio(
    messaggio({ imageMessage: { caption: 'Si è rotto questo', mimetype: 'image/jpeg' } })
  );
  assert.equal(r.rotta, 'media', 'la foto deve arrivare a Claude, non solo la didascalia');
  assert.equal(r.media.kind, 'foto');
  assert.equal(r.testo, 'Si è rotto questo', 'la didascalia va conservata, non buttata');
});

test('una foto SENZA didascalia va sul ramo media con testo vuoto', () => {
  const r = classificaMessaggio(messaggio({ imageMessage: { mimetype: 'image/jpeg' } }));
  assert.equal(r.rotta, 'media');
  assert.equal(r.testo, '');
});

test('un documento con didascalia resta un media e non perde la didascalia', () => {
  const r = classificaMessaggio(
    messaggio({ documentMessage: { caption: 'Ecco il documento', mimetype: 'application/pdf' } })
  );
  assert.equal(r.rotta, 'media');
  assert.equal(r.media.kind, 'documento');
  assert.equal(r.testo, 'Ecco il documento');
});

test('una nota vocale va sul ramo media', () => {
  const r = classificaMessaggio(
    messaggio({ audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus' } })
  );
  assert.equal(r.rotta, 'media');
  assert.equal(r.media.kind, 'nota vocale');
});

test('anche una foto dentro un view-once va sul ramo media', () => {
  const r = classificaMessaggio(
    messaggio({ viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } } })
  );
  assert.equal(r.rotta, 'media');
});

test('SICUREZZA: i gruppi vengono ignorati', () => {
  const r = classificaMessaggio(messaggio({ conversation: 'ciao' }, { jid: '123@g.us' }));
  assert.equal(r.rotta, 'ignora');
});

test('SICUREZZA: gli status vengono ignorati', () => {
  const r = classificaMessaggio(messaggio({ conversation: 'ciao' }, { jid: 'status@broadcast' }));
  assert.equal(r.rotta, 'ignora');
});

test('un media inviato da noi viene ignorato, non ri-processato', () => {
  const r = classificaMessaggio(
    messaggio({ imageMessage: { mimetype: 'image/jpeg' } }, { fromMe: true })
  );
  assert.equal(r.rotta, 'ignora');
});

test('il testo inviato da noi resta sul ramo testo (è la risposta manuale dell’host)', () => {
  const r = classificaMessaggio(messaggio({ conversation: 'Ti apro io' }, { fromMe: true }));
  assert.equal(r.rotta, 'testo', 'serve a onHostReply per l’apprendimento');
});

test('un messaggio senza contenuto o senza jid viene ignorato', () => {
  assert.equal(classificaMessaggio({ key: { remoteJid: 'x@s.whatsapp.net' } }).rotta, 'ignora');
  assert.equal(classificaMessaggio(undefined).rotta, 'ignora');
  assert.equal(classificaMessaggio(messaggio({ conversation: 'ciao' }, { jid: null })).rotta, 'ignora');
});

test('un messaggio senza testo e senza media viene ignorato', () => {
  assert.equal(classificaMessaggio(messaggio({ protocolMessage: {} })).rotta, 'ignora');
});
