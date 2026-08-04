import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { addNumber, removeNumber, listNumbers } from './allowlist.js';

/**
 * Crea il bot Telegram di controllo:
 * - invia le bozze all'host con i pulsanti Invia / Modifica / Ignora;
 * - chiede conferma prima di salvare una FAQ imparata (Salva / No).
 *
 * onApprove(item, finalText): l'host approva/modifica una bozza da inviare al
 *   cliente. Può restituire { saved: true } per segnalare che è stata salvata.
 * onSaveConfirmed(item): l'host conferma il salvataggio di una FAQ imparata.
 */
export function createControlBot({ onApprove, onSaveConfirmed, onAddAndReply }) {
  const bot = new Bot(config.telegramToken);

  // --- Autorizzazione: il bot è privato, risponde SOLO all'host (TELEGRAM_CHAT_ID).
  // Senza questo, chiunque trovi lo username potrebbe usare /lista (fuga dei
  // numeri dei clienti), /aggiungi, /rimuovi e i pulsanti. Scartiamo a monte
  // ogni update che non arriva dal chat id configurato.
  const OWNER_ID = String(config.telegramChatId);
  bot.use(async (ctx, next) => {
    const fromId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? '');
    if (fromId === OWNER_ID || chatId === OWNER_ID) return next();
    // Estraneo: ignora in silenzio (niente conferme che il bot esiste/funziona).
  });

  const pending = new Map(); // bozze: draftId -> item
  const pendingSaves = new Map(); // FAQ da confermare: saveId -> item
  const awaitingEdit = new Map(); // host in modifica: chatId -> draftId
  const pendingUnknown = new Map(); // numeri sconosciuti: id -> { jid, name, text }
  const unknownByJid = new Map(); // jid -> id (per non notificare due volte lo stesso)

  bot.command('start', (ctx) =>
    ctx.reply(
      'Ciao! Sono il bot di controllo della casa di Costa Rei.\n' +
        `Il tuo chat id è: ${ctx.chat.id}\n` +
        'Mettilo in TELEGRAM_CHAT_ID nel file .env.\n\n' +
        'Comandi lista numeri: /lista, /aggiungi <numero>, /rimuovi <numero>'
    )
  );

  // --- Gestione della lista dei numeri autorizzati ---
  bot.command('lista', (ctx) => {
    const nums = listNumbers();
    return ctx.reply(
      nums.length
        ? `Numeri autorizzati (${nums.length}):\n` + nums.map((n) => `• ${n}`).join('\n')
        : 'La lista è vuota: il bot non risponde automaticamente a nessuno (ti avviso e basta).'
    );
  });

  bot.command('aggiungi', (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg)
      return ctx.reply('Uso: /aggiungi <numero> — con prefisso internazionale, es. 39333xxxxxxx');
    const r = addNumber(arg);
    return ctx.reply(r.added ? `✅ Aggiunto: ${r.number}` : `Non aggiunto (${r.reason}).`);
  });

  bot.command('rimuovi', (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) return ctx.reply('Uso: /rimuovi <numero>');
    const r = removeNumber(arg);
    return ctx.reply(r.removed ? `🗑 Rimosso: ${r.number}` : `Non era in lista: ${r.number}`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const [action, id] = ctx.callbackQuery.data.split(':');

    // --- Numero sconosciuto: aggiungi e rispondi / ignora ---
    if (action === 'addnum' || action === 'dropnum') {
      const item = pendingUnknown.get(id);
      if (!item) {
        await ctx.answerCallbackQuery('Non più disponibile.');
        return;
      }
      pendingUnknown.delete(id);
      unknownByJid.delete(item.jid);
      if (action === 'addnum') {
        await onAddAndReply(item); // aggiunge il numero e processa il messaggio
        await ctx.editMessageText(`✅ Aggiunto ${item.number}. Il bot sta gestendo: "${item.text}"`);
        await ctx.answerCallbackQuery('Aggiunto');
      } else {
        await ctx.editMessageText(`🚫 Ignorato il numero ${item.number}.`);
        await ctx.answerCallbackQuery('Ignorato');
      }
      return;
    }

    // --- Conferma salvataggio FAQ imparata ---
    if (action === 'keep' || action === 'drop') {
      const item = pendingSaves.get(id);
      if (!item) {
        await ctx.answerCallbackQuery('Non più disponibile.');
        return;
      }
      pendingSaves.delete(id);
      if (action === 'keep') {
        await onSaveConfirmed(item);
        await ctx.editMessageText(`💾 Salvata nelle FAQ:\nD: ${item.domanda}\nR: ${item.risposta}`);
        await ctx.answerCallbackQuery('Salvata');
      } else {
        await ctx.editMessageText('🗑 Non salvata.');
        await ctx.answerCallbackQuery('Ignorata');
      }
      return;
    }

    // --- Decisione su una bozza ---
    const item = pending.get(id);
    if (!item) {
      await ctx.answerCallbackQuery('Questa bozza non è più disponibile.');
      return;
    }

    if (action === 'send') {
      await ctx.answerCallbackQuery('Invio...');
      await onApprove(item, item.decision.draft);
      pending.delete(id);
      await ctx.editMessageText(`✅ Inviata a ${item.clientName}:\n\n${item.decision.draft}`);
    } else if (action === 'edit') {
      awaitingEdit.set(ctx.chat.id, id);
      await ctx.answerCallbackQuery();
      await ctx.reply('✏️ Scrivi qui il testo corretto da inviare al cliente:');
    } else if (action === 'ignore') {
      pending.delete(id);
      await ctx.editMessageText(`🚫 Ignorata: niente inviato a ${item.clientName}.`);
      await ctx.answerCallbackQuery('Ignorata');
    }
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return; // i comandi sono gestiti a parte
    const draftId = awaitingEdit.get(ctx.chat.id);
    if (!draftId) return; // non stiamo aspettando una modifica
    awaitingEdit.delete(ctx.chat.id);

    const item = pending.get(draftId);
    if (!item) {
      await ctx.reply('Questa bozza non è più disponibile.');
      return;
    }
    const finalText = ctx.message.text;
    await onApprove(item, finalText);
    pending.delete(draftId);
    await ctx.reply(`✅ Inviata a ${item.clientName}:\n\n${finalText}`);
  });

  /** Invia una bozza all'host con i pulsanti di approvazione. */
  async function requestApproval(item) {
    pending.set(item.draftId, item);
    const { clientName, question, decision } = item;

    const keyboard = new InlineKeyboard()
      .text('✅ Invia', `send:${item.draftId}`)
      .text('✏️ Modifica', `edit:${item.draftId}`)
      .text('🚫 Ignora', `ignore:${item.draftId}`);

    const sourcesText = decision.sources?.length
      ? `\n\nFonti:\n${decision.sources.map((s) => `• ${s.url}`).join('\n')}`
      : '';

    const text =
      `💬 Nuovo messaggio da ${clientName}\n` +
      `"${question}"\n\n` +
      `Categoria: ${decision.category} · ${decision.reason}\n\n` +
      `Bozza:\n${decision.draft}${sourcesText}`;

    await bot.api.sendMessage(config.telegramChatId, text, { reply_markup: keyboard });
  }

  /** Chiede all'host se salvare una risposta (manuale) come FAQ imparata. */
  async function requestSaveConfirmation(item) {
    pendingSaves.set(item.saveId, item);
    const keyboard = new InlineKeyboard()
      .text('💾 Salva', `keep:${item.saveId}`)
      .text('🗑 No', `drop:${item.saveId}`);
    const text =
      '📝 Vuoi salvare questa come FAQ riutilizzabile?\n\n' +
      `D: ${item.domanda}\nR: ${item.risposta}\n\nCategoria: ${item.categoria}`;
    await bot.api.sendMessage(config.telegramChatId, text, { reply_markup: keyboard });
  }

  /**
   * Invia un semplice messaggio di testo all'host (es. alert di sistema).
   * Robusta: non lancia mai, così un errore di notifica non butta giù il chiamante.
   */
  async function notifyHost(text) {
    try {
      await bot.api.sendMessage(config.telegramChatId, text);
    } catch (err) {
      console.error("Errore nell'invio della notifica all'host:", err);
    }
  }

  /** Avvisa l'host di un messaggio da un numero NON in lista, con scelta. */
  async function requestUnknownApproval(item) {
    if (unknownByJid.has(item.jid)) return; // già notificato: evita doppioni
    const id = randomUUID();
    pendingUnknown.set(id, item);
    unknownByJid.set(item.jid, id);

    const keyboard = new InlineKeyboard()
      .text('➕ Aggiungi e rispondi', `addnum:${id}`)
      .text('🚫 Ignora', `dropnum:${id}`);
    const text =
      `📩 Messaggio da un numero NON in lista (${item.name} · ${item.number}):\n` +
      `"${item.text}"\n\n` +
      'Vuoi aggiungerlo alla lista e far rispondere il bot?';
    await bot.api.sendMessage(config.telegramChatId, text, { reply_markup: keyboard });
  }

  return { bot, requestApproval, requestSaveConfirmation, requestUnknownApproval, notifyHost };
}
