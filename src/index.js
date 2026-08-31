import { randomUUID } from 'node:crypto';
import { startWhatsApp } from './whatsapp.js';
import { createControlBot } from './telegram.js';
import { handleClientMessage } from './engine.js';
import { evaluateForLearning, isSupportedImageType } from './brain.js';
import { transcribeAudio, isTranscriptionEnabled } from './audio.js';
import { addLearned } from './learned.js';
import { isAllowedNumber, addNumber } from './allowlist.js';
import * as memory from './memory.js';
import { config } from './config.js';

// --- Controlli preliminari ---
if (!config.anthropicApiKey) {
  console.error('❌ Manca ANTHROPIC_API_KEY nel file .env.');
  process.exit(1);
}
if (!config.telegramToken || !config.telegramChatId) {
  console.error('❌ Mancano TELEGRAM_BOT_TOKEN e/o TELEGRAM_CHAT_ID nel file .env.');
  process.exit(1);
}

// Categorie di cui ha senso salvare una FAQ riutilizzabile.
const LEARNABLE = new Set(['info_zona', 'regole_casa']);

let wa; // assegnato dopo l'avvio di WhatsApp

// Invia al cliente (via WhatsApp) e registra la risposta nella memoria.
//
// La guardia su `wa` non è teorica: il bot Telegram viene avviato PRIMA della
// connessione a WhatsApp (così è pronto a ricevere bozze), quindi nei primi
// secondi dopo un riavvio l'host può premere «Invia» su una bozza vecchia
// mentre `wa` è ancora undefined. Senza la guardia sarebbe un
// "Cannot read properties of undefined", cioè un messaggio incomprensibile;
// così l'host legge cosa è successo e il pulsante resta riprovabile.
async function sendToClient(jid, text) {
  if (!wa) {
    throw new Error(
      'WhatsApp non è ancora connesso (il bot è appena stato avviato). Riprova fra qualche secondo.'
    );
  }
  await wa.sendToClient(jid, text);
  memory.appendAssistant(jid, text);
}

// --- Canale di controllo Telegram (prima, così è pronto a ricevere bozze) ---
const { bot, requestApproval, requestSaveConfirmation, requestUnknownApproval, notifyHost } =
  createControlBot({
  // L'host approva/modifica una bozza: la inviamo e, se è informazione nuova
  // (era in escalation), gli CHIEDIAMO se salvarla come FAQ. Niente salvataggi
  // automatici: si salva solo quando l'host tocca "Salva".
  onApprove: async (item, finalText) => {
    await sendToClient(item.conversationId, finalText);
    const { category, action } = item.decision;
    if (action === 'escala' && LEARNABLE.has(category)) {
      await requestSaveConfirmation({
        saveId: randomUUID(),
        domanda: item.question,
        risposta: finalText,
        categoria: category,
        origine: 'telegram',
      });
    }
  },
  // L'host conferma il salvataggio di una FAQ imparata (toccando "Salva").
  onSaveConfirmed: async (item) => {
    addLearned({
      domanda: item.domanda,
      risposta: item.risposta,
      categoria: item.categoria,
      origine: item.origine || 'manuale',
    });
  },
  // L'host tocca "Aggiungi e rispondi" su un numero sconosciuto: lo aggiunge
  // alla lista e processa il messaggio originale come un cliente normale.
  onAddAndReply: async ({ jid, number, name, text }) => {
    addNumber(number);
    await processClientMessage({ jid, number, name, text });
  },
  });
await bot.init();
bot.start();
console.log(`🤖 Bot di controllo Telegram attivo (@${bot.botInfo.username}).`);

// Notifica l'host quando la pipeline di risposta a un cliente fallisce per un
// errore tecnico (es. API Claude in rate limit/overload/timeout): il messaggio
// resterebbe senza risposta, quindi avvisiamo così l'host risponde a mano.
async function notifyClientFailure({ name, number, text }, err) {
  console.error(`Errore nella pipeline di risposta a ${name} (${number}):`, err);
  await notifyHost(
    `⚠️ Non sono riuscito a rispondere a ${name} (${number}) per un errore tecnico. ` +
      `Rispondi a mano su WhatsApp.\n\nMessaggio del cliente:\n"${text}"`
  );
}

/**
 * Percorso unico per ogni messaggio di un cliente già autorizzato, qualunque
 * sia la sua origine: testo, foto, vocale trascritto o messaggio recuperato
 * dopo un "Aggiungi e rispondi".
 *
 * `memoryText` è ciò che finisce nello storico al posto del testo: per le foto
 * salviamo un segnaposto, perché i byte dell'immagine non devono entrare nel
 * database (peserebbero e verrebbero rispediti a ogni turno).
 */
async function processClientMessage({ jid, number, name, text, image, memoryText }) {
  const history = memory.getHistory(jid); // contesto precedente
  memory.appendUser(jid, memoryText ?? text); // registra il messaggio del cliente
  try {
    return await handleClientMessage({
      conversationId: jid,
      clientName: name,
      text,
      history,
      image,
      sendToClient,
      requestApproval,
    });
  } catch (err) {
    // La risposta non è partita per un errore tecnico (es. API Claude in
    // rate limit/overload). NON rilanciamo: avvisiamo l'host qui, dove
    // abbiamo il contesto cliente, così può rispondere a mano.
    await notifyClientFailure({ name, number, text }, err);
    return null;
  }
}

/**
 * Foto di un cliente: la facciamo guardare a Claude nella stessa chiamata che
 * già classifica e decide, così una foto vale quanto un messaggio di testo.
 *
 * Nello storico salviamo solo un segnaposto: i byte dell'immagine non entrano
 * mai nel database. Se la foto è un documento d'identità, brain.js la
 * classifica "documento_identita" senza estrarne alcun dato, e qui ci
 * limitiamo a ricordare all'host la registrazione su alloggiatiweb.
 */
async function handlePhoto({ jid, number, name, mimetype, text, download }) {
  let buffer;
  try {
    buffer = await download();
  } catch (err) {
    console.error(`Errore nello scaricamento della foto di ${name} (${number}):`, err);
    await notifyHost(
      `📎 ${name} (${number}) ti ha mandato una foto, ma non sono riuscito a scaricarla. ` +
        'Guardala e rispondi a mano su WhatsApp.'
    );
    return;
  }

  // La didascalia, se c'è, È il messaggio del cliente ("si è rotto questo"):
  // vale più della frase generica di prima.
  const didascalia = String(text || '').trim();

  const result = await processClientMessage({
    jid,
    number,
    name,
    text: didascalia || 'Il cliente ha inviato questa foto.',
    image: { data: buffer.toString('base64'), mediaType: mimetype.split(';')[0].trim() },
    // Nello storico va il segnaposto, mai i byte dell'immagine. La didascalia
    // invece è testo e va conservata: è contesto per i turni successivi.
    memoryText: didascalia
      ? `[il cliente ha inviato una foto] ${didascalia}`
      : '[il cliente ha inviato una foto]',
  });

  if (result?.decision?.category === 'documento_identita') {
    await notifyHost(
      `🪪 La foto di ${name} (${number}) sembra un documento d'identità: non ne ho letto ` +
        'né salvato il contenuto. Ricordati della registrazione su alloggiatiweb.'
    );
  }
}

/**
 * Vocale di un cliente: lo facciamo trascrivere da Gemini (Claude non accetta
 * audio in ingresso) e poi trattiamo la trascrizione come un normale messaggio
 * di testo. Se la trascrizione non è configurata o fallisce, degradiamo al
 * comportamento di prima: avvisiamo l'host, che risponde a mano.
 */
async function handleVoiceNote({ jid, number, name, kind, mimetype, download }) {
  const avvisaHost = (motivo) =>
    notifyHost(
      `🎤 ${name} (${number}) ti ha mandato un ${kind}, ma non sono riuscito a trascriverlo ` +
        `(${motivo}). Ascoltalo e rispondi a mano su WhatsApp.`
    );

  if (!isTranscriptionEnabled()) {
    await notifyHost(
      `🎤 ${name} (${number}) ti ha mandato un ${kind}. La trascrizione non è configurata ` +
        '(manca GEMINI_API_KEY nel .env): ascoltalo e rispondi a mano su WhatsApp.'
    );
    return;
  }

  let transcript;
  try {
    transcript = await transcribeAudio(await download(), mimetype);
  } catch (err) {
    console.error(`Errore nella trascrizione del vocale di ${name} (${number}):`, err);
    await avvisaHost('errore tecnico');
    return;
  }

  if (!transcript) {
    await avvisaHost('audio incomprensibile o silenzioso');
    return;
  }

  console.log(`🎤 Vocale di ${name} trascritto (${transcript.length} caratteri).`);
  await processClientMessage({
    jid,
    number,
    // Il marcatore è solo per l'host su Telegram: clientName non arriva mai a
    // Claude, quindi non inquina il prompt. Serve perché l'host sappia che sta
    // leggendo una trascrizione, che può contenere errori.
    name: `${name} 🎤 (vocale trascritto)`,
    text: transcript,
  });
}

// --- Connessione WhatsApp ---
wa = await startWhatsApp({
  onMessage: async ({ jid, number, name, text }) => {
    if (!isAllowedNumber(number)) {
      // numero non in lista: niente chiamata a Claude, avviso solo l'host
      await requestUnknownApproval({ jid, number, name, text });
      return;
    }
    await processClientMessage({ jid, number, name, text });
  },

  // L'host ha risposto a mano dal telefono: teniamo il contesto allineato e,
  // se è una risposta riutilizzabile, chiediamo se salvarla come FAQ.
  onHostReply: async ({ jid, number, text }) => {
    if (!isAllowedNumber(number)) return; // non imparare dalle risposte a numeri non in lista
    const history = memory.getHistory(jid);
    memory.appendAssistant(jid, text);

    const lastQuestion = [...history].reverse().find((m) => m.role === 'user');
    if (!lastQuestion) return;

    // La valutazione per l'apprendimento può fallire (es. API Claude): non è
    // critica (l'host ha già risposto a mano), quindi loggiamo e basta senza
    // propagare l'errore né notificare il cliente.
    try {
      const evalRes = await evaluateForLearning(lastQuestion.content, text);
      if (evalRes.reusable && LEARNABLE.has(evalRes.categoria)) {
        await requestSaveConfirmation({
          saveId: randomUUID(),
          domanda: evalRes.domanda || lastQuestion.content,
          risposta: text,
          categoria: evalRes.categoria,
          origine: 'manuale',
        });
      }
    } catch (err) {
      console.error("Errore nella valutazione per l'apprendimento:", err);
    }
  },

  // Media in arrivo. Il bot gestisce da solo due casi — le foto (le guarda
  // con Claude) e i vocali (li fa trascrivere e li tratta come testo) — e per
  // tutto il resto si limita ad avvisare l'host, come prima.
  onMedia: async ({ jid, number, name, kind, mimetype, text, download }) => {
    if (!isAllowedNumber(number)) {
      // Numero NON in lista: avviso e basta. Il media non viene nemmeno
      // scaricato (download() non viene invocato): niente banda, nessun dato
      // di sconosciuti che entra nel sistema, nessuna chiamata alle API.
      await notifyHost(
        `📎 Media da un numero NON in lista (${name} · ${number}): ${kind}.\n` +
          'Il bot non gestisce i media dei numeri non autorizzati: se vuoi rispondere, fallo a mano su WhatsApp.'
      );
      return;
    }

    if (kind === 'foto' && isSupportedImageType(mimetype)) {
      await handlePhoto({ jid, number, name, mimetype, text, download });
      return;
    }
    if (kind === 'nota vocale' || kind === 'audio') {
      await handleVoiceNote({ jid, number, name, kind, mimetype, download });
      return;
    }

    // Video, sticker, documenti-file, contatti, posizioni: fuori portata.
    let avviso =
      `📎 ${name} (${number}) ti ha mandato un media che il bot non gestisce: ${kind}. ` +
      'Rispondi a mano su WhatsApp.';
    // Se il cliente ha scritto una didascalia, all'host serve leggerla: è
    // l'unica parte del messaggio che il bot può riferire.
    const didascalia = String(text || '').trim();
    if (didascalia) avviso += `\n\nDidascalia: "${didascalia}"`;
    if (kind === 'documento') {
      avviso += '\nSe è un documento d\'identità, ricordati della registrazione su alloggiatiweb.';
    }
    await notifyHost(avviso);
  },

  // Alert di sistema (logout/disconnessione WhatsApp): li inoltriamo all'host.
  onAlert: notifyHost,
});

console.log(`Modalità rodaggio (rivedi tutto): ${config.reviewEverything ? 'ON' : 'OFF'}`);
console.log('In attesa di messaggi WhatsApp...');
