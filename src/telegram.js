import { randomUUID } from 'node:crypto';
import { Bot, InlineKeyboard } from 'grammy';
import { config } from './config.js';
import { addNumber, removeNumber, listNumbers } from './allowlist.js';

// Al primo avvio TELEGRAM_CHAT_ID è ancora vuoto, e l'unico modo per scoprirlo
// è chiederlo al bot con /start. Finché non è configurato lasciamo passare quel
// solo comando, altrimenti la configurazione iniziale sarebbe impossibile: il
// bot bloccherebbe anche la richiesta che serve a sbloccarlo.
const COMANDO_START = /^\/start(?:@\w+)?(?:\s|$)/;

// Telegram rifiuta i messaggi oltre i 4096 caratteri. Una bozza lunga (o la
// trascrizione di un vocale lungo) supererebbe il limite e l'invio
// fallirebbe: meglio troncare e consegnare comunque qualcosa all'host.
const TELEGRAM_MAX_CHARS = 4096;

export const troncaPerTelegram = (text) =>
  text.length <= TELEGRAM_MAX_CHARS
    ? text
    : text.slice(0, TELEGRAM_MAX_CHARS - 20) + '\n… (troncato)';

// Le voci pendenti (bozze, FAQ da confermare, numeri sconosciuti) vivono in
// memoria: un riavvio le perde comunque. Senza una scadenza però si accumulano
// finché il processo vive — e su un bot che gira per mesi su un VPS è una
// perdita di memoria lenta, fatta di bozze che l'host non toccherà mai più.
export const SCADENZA_PENDENTI_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PENDENTI = 500;

/**
 * Una Map che dimentica: le voci scadono dopo `scadenzaMs` e comunque non
 * superano `max` (le più vecchie escono per prime).
 *
 * `onScadenza` serve a chi tiene un indice inverso — pendingUnknown è indicizzato
 * anche per JID — che altrimenti resterebbe pieno di riferimenti a voci sparite,
 * impedendo per sempre di rinotificare quel numero.
 *
 * Esportata perché è pura e quindi verificabile senza una connessione a Telegram.
 */
export class MappaConScadenza {
  constructor({ scadenzaMs = SCADENZA_PENDENTI_MS, max = MAX_PENDENTI, ora = Date.now } = {}) {
    this.scadenzaMs = scadenzaMs;
    this.max = max;
    this.ora = ora;
    this.onScadenza = null;
    this.voci = new Map(); // id -> { valore, ts }
  }

  set(id, valore) {
    this.pulisci();
    this.voci.set(id, { valore, ts: this.ora() });
    // Tetto di sicurezza: Map conserva l'ordine di inserimento, quindi la prima
    // chiave è la più vecchia.
    while (this.voci.size > this.max) {
      const piuVecchia = this.voci.keys().next().value;
      this.scarta(piuVecchia);
    }
    return this;
  }

  get(id) {
    const voce = this.voci.get(id);
    if (!voce) return undefined;
    if (this.ora() - voce.ts > this.scadenzaMs) {
      this.scarta(id);
      return undefined;
    }
    return voce.valore;
  }

  delete(id) {
    return this.voci.delete(id);
  }

  get size() {
    return this.voci.size;
  }

  /** Rimuove le voci scadute. Chiamata a ogni inserimento. */
  pulisci() {
    const adesso = this.ora();
    for (const [id, voce] of this.voci) {
      if (adesso - voce.ts > this.scadenzaMs) this.scarta(id);
    }
  }

  scarta(id) {
    const voce = this.voci.get(id);
    this.voci.delete(id);
    if (voce && this.onScadenza) this.onScadenza(id, voce.valore);
  }
}

/**
 * Decide se un update Telegram può passare al resto del bot. È la guardia di
 * privacy: il bot è privato e i comandi (/lista) esporrebbero i numeri dei
 * clienti. Esportata perché è pura, e quindi verificabile dai test senza una
 * connessione a Telegram.
 *
 * Attenzione a NON fare String(undefined): darebbe la stringa "undefined", che
 * non combacia con nessun chat id reale e bloccherebbe anche l'host.
 */
export function updateAutorizzato({ ownerId, fromId, chatId, testo }) {
  const owner = ownerId ? String(ownerId) : null;
  if (owner) return String(fromId ?? '') === owner || String(chatId ?? '') === owner;
  // Bot non ancora configurato: passa solo /start, che rivela a chi scrive il
  // suo stesso chat id e nient'altro. Nessun comando che tocchi i dati dei
  // clienti (/lista, /aggiungi, /rimuovi) o le bozze passa di qui.
  return COMANDO_START.test(String(testo ?? '').trim());
}

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
  // ogni update che non arriva dal chat id configurato: la regola vera sta in
  // updateAutorizzato() qui sopra.
  bot.use(async (ctx, next) => {
    const passa = updateAutorizzato({
      ownerId: config.telegramChatId,
      fromId: ctx.from?.id,
      chatId: ctx.chat?.id,
      testo: ctx.message?.text,
    });
    if (passa) return next();
    // Estraneo: ignora in silenzio (niente conferme che il bot esiste/funziona).
  });

  // Rete di sicurezza globale. Senza, un errore non gestito dentro un handler
  // finisce solo sullo stdout del server: l'host vede il messaggio su Telegram
  // restare identico, coi pulsanti ancora attivi, e non sa se sia successo
  // qualcosa. Qui almeno glielo diciamo, e sblocchiamo la rotella di attesa
  // del pulsante che altrimenti girerebbe fino al timeout.
  bot.catch(async ({ error, ctx }) => {
    console.error('Errore non gestito nel bot Telegram:', error);

    // Sblocca la rotella d'attesa, ma SOLO se l'errore veniva da un pulsante:
    // su un update diverso answerCallbackQuery lancia subito, e un try/catch
    // unico si mangerebbe anche l'avviso qui sotto lasciando l'host all'oscuro.
    if (ctx?.callbackQuery) {
      try {
        await ctx.answerCallbackQuery('Errore');
      } catch { /* già risposto, o scaduto */ }
    }

    try {
      await ctx?.reply?.(
        '⚠️ Errore imprevisto nel bot. Niente è stato inviato al cliente.\n' +
          'Controlla i log del server: journalctl -u costa-rei-bot -n 50'
      );
    } catch {
      // Anche Telegram è irraggiungibile: resta il log sopra, è quanto possiamo fare.
    }
  });

  /**
   * Esegue un'azione che può fallire davvero (invio su WhatsApp, scrittura su
   * disco) e ne riferisce l'esito all'host. Restituisce true solo se è andata
   * a buon fine, così chi chiama può rimuovere la voce pendente SOLO dopo il
   * successo: in caso di errore i pulsanti restano validi e si può riprovare.
   */
  async function provaConFeedback(ctx, azione, descrizione) {
    try {
      await azione();
      return true;
    } catch (err) {
      console.error(`${descrizione}: fallito.`, err);
      try {
        await ctx.reply(
          `⚠️ ${descrizione}: non è riuscito.\n${err.message}\n\n` +
            'Non ho perso niente: riprova col pulsante qui sopra, oppure fallo a mano su WhatsApp.'
        );
      } catch { /* se Telegram non risponde, resta il log */ }
      return false;
    }
  }

  const pending = new MappaConScadenza(); // bozze: draftId -> item
  const pendingSaves = new MappaConScadenza(); // FAQ da confermare: saveId -> item
  const awaitingEdit = new Map(); // host in modifica: chatId -> draftId (vita brevissima)
  const pendingUnknown = new MappaConScadenza(); // numeri sconosciuti: id -> { jid, name, text }
  const unknownByJid = new Map(); // jid -> id (per non notificare due volte lo stesso)

  // Quando un numero sconosciuto scade, va liberato anche l'indice per JID:
  // altrimenti quel numero non verrebbe mai più segnalato all'host.
  pendingUnknown.onScadenza = (_id, item) => unknownByJid.delete(item.jid);

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
      if (action === 'dropnum') {
        pendingUnknown.delete(id);
        unknownByJid.delete(item.jid);
        await ctx.editMessageText(`🚫 Ignorato il numero ${item.number}.`);
        await ctx.answerCallbackQuery('Ignorato');
        return;
      }
      // Rispondiamo SUBITO al pulsante: onAddAndReply fa una chiamata a Claude
      // e può superare i secondi entro cui Telegram si aspetta una risposta.
      await ctx.answerCallbackQuery('Aggiungo...');
      const aggiunto = await provaConFeedback(
        ctx,
        () => onAddAndReply(item), // aggiunge il numero e processa il messaggio
        `L'aggiunta di ${item.number} alla lista`
      );
      if (!aggiunto) return; // resta pendente: l'host può riprovare
      pendingUnknown.delete(id);
      unknownByJid.delete(item.jid);
      await ctx.editMessageText(
        troncaPerTelegram(`✅ Aggiunto ${item.number}. Il bot sta gestendo: "${item.text}"`)
      );
      return;
    }

    // --- Conferma salvataggio FAQ imparata ---
    if (action === 'keep' || action === 'drop') {
      const item = pendingSaves.get(id);
      if (!item) {
        await ctx.answerCallbackQuery('Non più disponibile.');
        return;
      }
      if (action === 'drop') {
        pendingSaves.delete(id);
        await ctx.editMessageText('🗑 Non salvata.');
        await ctx.answerCallbackQuery('Ignorata');
        return;
      }
      // La rimozione va DOPO il salvataggio riuscito: prima, un errore di
      // scrittura su disco faceva sparire la FAQ senza averla mai salvata.
      const salvata = await provaConFeedback(
        ctx,
        () => onSaveConfirmed(item),
        'Il salvataggio della FAQ'
      );
      if (!salvata) {
        await ctx.answerCallbackQuery('Errore');
        return; // resta pendente: l'host può riprovare
      }
      pendingSaves.delete(id);
      await ctx.editMessageText(
        troncaPerTelegram(`💾 Salvata nelle FAQ:\nD: ${item.domanda}\nR: ${item.risposta}`)
      );
      await ctx.answerCallbackQuery('Salvata');
      return;
    }

    // --- Decisione su una bozza ---
    const item = pending.get(id);
    if (!item) {
      await ctx.answerCallbackQuery('Questa bozza non è più disponibile.');
      return;
    }

    if (action === 'send') {
      // Non mandare mai un messaggio vuoto al cliente: la bozza resta pendente
      // e l'host può scriverla con «Modifica».
      if (!String(item.decision.draft ?? '').trim()) {
        await ctx.answerCallbackQuery('Bozza vuota');
        await ctx.reply(
          '⚠️ Non c’è nessuna bozza da inviare: il modello non l’ha proposta.\n' +
            'Usa «✏️ Modifica» per scrivere tu la risposta.'
        );
        return;
      }
      await ctx.answerCallbackQuery('Invio...');
      const inviata = await provaConFeedback(
        ctx,
        () => onApprove(item, item.decision.draft),
        `L'invio della risposta a ${item.clientName}`
      );
      // Se l'invio fallisce (es. WhatsApp disconnesso) la bozza resta in
      // `pending`: i pulsanti sopra continuano a funzionare e l'host può
      // ritentare senza doversi riscrivere la risposta.
      if (!inviata) return;
      pending.delete(id);
      await ctx.editMessageText(troncaPerTelegram(`✅ Inviata a ${item.clientName}:\n\n${item.decision.draft}`));
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
    const inviata = await provaConFeedback(
      ctx,
      () => onApprove(item, finalText),
      `L'invio della risposta a ${item.clientName}`
    );
    if (!inviata) {
      // Rimettiamo l'host in stato di modifica: la bozza è ancora pendente e
      // il testo che aveva appena scritto non deve andare perso in silenzio.
      awaitingEdit.set(ctx.chat.id, draftId);
      return;
    }
    pending.delete(draftId);
    await ctx.reply(troncaPerTelegram(`✅ Inviata a ${item.clientName}:\n\n${finalText}`));
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

    // Il modello a volte escala SENZA proporre una bozza (succede sui temi
    // sensibili). Senza questo, l'host leggerebbe "Bozza:" seguito dal nulla e
    // non capirebbe se è un guasto del bot: meglio dirglielo e indirizzarlo
    // subito sul pulsante giusto.
    const bozza = String(decision.draft ?? '').trim();
    const corpoBozza = bozza
      ? `Bozza:\n${bozza}`
      : 'Bozza: ⚠️ il modello non ne ha proposta una. Usa «✏️ Modifica» per scriverla tu.';

    const text =
      `💬 Nuovo messaggio da ${clientName}\n` +
      `"${question}"\n\n` +
      `Categoria: ${decision.category} · ${decision.reason}\n\n` +
      `${corpoBozza}${sourcesText}`;

    await bot.api.sendMessage(config.telegramChatId, troncaPerTelegram(text), { reply_markup: keyboard });
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
    await bot.api.sendMessage(config.telegramChatId, troncaPerTelegram(text), { reply_markup: keyboard });
  }

  /**
   * Invia un semplice messaggio di testo all'host (es. alert di sistema).
   * Robusta: non lancia mai, così un errore di notifica non butta giù il chiamante.
   */
  async function notifyHost(text) {
    try {
      await bot.api.sendMessage(config.telegramChatId, troncaPerTelegram(text));
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
    await bot.api.sendMessage(config.telegramChatId, troncaPerTelegram(text), { reply_markup: keyboard });
  }

  return { bot, requestApproval, requestSaveConfirmation, requestUnknownApproval, notifyHost };
}
