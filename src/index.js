import { randomUUID } from 'node:crypto';
import { startWhatsApp } from './whatsapp.js';
import { createControlBot } from './telegram.js';
import { handleClientMessage } from './engine.js';
import { evaluateForLearning } from './brain.js';
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
async function sendToClient(jid, text) {
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
    const history = memory.getHistory(jid);
    memory.appendUser(jid, text);
    try {
      await handleClientMessage({
        conversationId: jid,
        clientName: name,
        text,
        history,
        sendToClient,
        requestApproval,
      });
    } catch (err) {
      // Errore tecnico (es. API Claude): avvisa l'host così risponde a mano.
      await notifyClientFailure({ name, number, text }, err);
    }
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

// --- Connessione WhatsApp ---
wa = await startWhatsApp({
  onMessage: async ({ jid, number, name, text }) => {
    if (!isAllowedNumber(number)) {
      // numero non in lista: niente chiamata a Claude, avviso solo l'host
      await requestUnknownApproval({ jid, number, name, text });
      return;
    }
    const history = memory.getHistory(jid); // contesto precedente
    memory.appendUser(jid, text); // registra il messaggio del cliente
    try {
      await handleClientMessage({
        conversationId: jid,
        clientName: name,
        text,
        history,
        sendToClient,
        requestApproval,
      });
    } catch (err) {
      // La risposta non è partita per un errore tecnico (es. API Claude in
      // rate limit/overload). NON rilanciamo: avvisiamo l'host qui, dove
      // abbiamo il contesto cliente, così può rispondere a mano.
      await notifyClientFailure({ name, number, text }, err);
    }
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

  // Media in arrivo (foto/audio/documento/...): il bot non li gestisce, ma
  // avvisa l'host perché risponda a mano. Nessuna chiamata a Claude.
  onMedia: async ({ number, name, kind }) => {
    const puoEssereDocumento = kind === 'foto' || kind === 'documento';
    if (!isAllowedNumber(number)) {
      // Numero NON in lista: avviso e basta, senza aggiungerlo automaticamente.
      await notifyHost(
        `📎 Media da un numero NON in lista (${name} · ${number}): ${kind}.\n` +
          'Il bot non gestisce i media: se vuoi rispondere, fallo a mano su WhatsApp.'
      );
      return;
    }
    let text =
      `📎 ${name} (${number}) ti ha mandato un media: ${kind}. ` +
      'Il bot non gestisce i media: rispondi a mano su WhatsApp.';
    if (puoEssereDocumento) {
      text += '\nSe è la foto di un documento, ricordati della registrazione su alloggiatiweb.';
    }
    await notifyHost(text);
  },

  // Alert di sistema (logout/disconnessione WhatsApp): li inoltriamo all'host.
  onAlert: notifyHost,
});

console.log(`Modalità rodaggio (rivedi tutto): ${config.reviewEverything ? 'ON' : 'OFF'}`);
console.log('In attesa di messaggi WhatsApp...');
