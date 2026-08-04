import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import P from 'pino';
import { jidToNumber } from './allowlist.js';

// Interop robusto: a seconda della build, makeWASocket è il default export.
const makeWASocket = baileys.default ?? baileys.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = baileys;

const logger = P({ level: 'silent' });

// Tetto allo scaricamento dei media: evita che un file enorme (o malevolo)
// occupi memoria e finisca in una chiamata API costosa. I media di un cliente
// sono foto e vocali brevi, ben sotto questa soglia.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Avvia la connessione a WhatsApp via Baileys (come dispositivo collegato).
 * - onMessage({ jid, number, name, text }): messaggio in arrivo da un cliente.
 *   `jid` è la chat (per rispondere), `number` è il numero di telefono vero.
 * - onHostReply({ jid, number, text }): risposta scritta a mano dall'host dal
 *   telefono (serve per imparare). Esclude gli invii fatti dal bot stesso.
 * - onAlert(text): notifica di sistema per l'host (logout/disconnessione/ritorno
 *   online). Opzionale e disaccoppiato: qui non sappiamo nulla di Telegram.
 * - onMedia({ jid, number, name, kind, mimetype, download }): media in arrivo da
 *   un cliente (foto, vocale, ecc.) senza testo utile. `download()` è una
 *   funzione PIGRA che restituisce una Promise<Buffer> col contenuto decifrato:
 *   va invocata solo se il media serve davvero, così i media dei numeri non in
 *   lista non vengono mai scaricati. Opzionale.
 * Restituisce { sendToClient }.
 */
export async function startWhatsApp({ onMessage, onHostReply, onAlert, onMedia }) {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  let sock;

  // Per distinguere i messaggi inviati DAL BOT da quelli scritti a mano dall'host.
  const botSentIds = new Set();
  let botSentTexts = []; // { text, ts } come rete di sicurezza contro le gare temporali

  // Backoff per le riconnessioni: senza, su un errore persistente si riconnette
  // a raffica, sprecando risorse e aumentando il rischio di ban da WhatsApp.
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 60000; // 60s
  const RECONNECT_ALERT_THRESHOLD = 5; // dopo N fallimenti consecutivi avvisa l'host
  let alertedDown = false; // true se abbiamo già avvisato di una disconnessione in corso

  // Invia un alert all'host senza mai lanciare (onAlert è fornito dall'esterno).
  function safeAlert(text) {
    try {
      onAlert?.(text);
    } catch (err) {
      console.error("Errore nell'invio dell'alert all'host:", err);
    }
  }

  function scheduleReconnect() {
    const wait = Math.min(5000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    console.log(`⏳ Riconnessione tra ${Math.round(wait / 1000)}s (tentativo ${reconnectAttempts})...`);
    // Notifica UNA sola volta al superamento soglia: reconnectAttempts viene
    // azzerato su 'open', quindi il confronto col valore esatto evita lo spam.
    if (reconnectAttempts === RECONNECT_ALERT_THRESHOLD) {
      alertedDown = true;
      safeAlert(
        `⚠️ WhatsApp disconnesso da un po' e non riesco a riconnettermi (tentativo ${reconnectAttempts}). Controlla il server.`
      );
    }
    setTimeout(connect, wait);
  }

  function connect() {
    sock = makeWASocket({ auth: state, logger });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('\n📱 Scansiona questo QR con WhatsApp → Dispositivi collegati:\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') {
        console.log('✅ WhatsApp connesso.');
        reconnectAttempts = 0; // connessione riuscita: azzera il backoff
        // Se avevamo avvisato di una disconnessione, segnala il ritorno online.
        if (alertedDown) {
          alertedDown = false;
          safeAlert('✅ WhatsApp è tornato online.');
        }
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          console.log(
            '⚠️  Disconnesso da WhatsApp. Elimina la cartella auth_info/ e riavvia per riscansionare il QR.'
          );
          safeAlert(
            '⚠️ Sessione WhatsApp scaduta: devi riscansionare il QR sul server (elimina auth_info/ e riavvia il bot). Il bot è OFFLINE finché non lo fai.'
          );
        } else {
          console.log(`⚠️  Connessione chiusa (code ${code ?? '?'}).`);
          scheduleReconnect();
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        const jid = msg.key.remoteJid; // JID della chat (per rispondere); può essere un @lid
        // ignora status e gruppi
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue;

        const text = extractText(msg.message);
        if (!text) {
          // Nessun testo utile: è un media. Lo segnaliamo a chi ci usa, che
          // decide se scaricarlo (foto e vocali) o limitarsi ad avvisare l'host.
          const media = describeMedia(msg.message);
          if (media && !msg.key.fromMe) {
            const number = await resolvePhoneNumber(sock, msg.key);
            const name = msg.pushName || number || jid.split('@')[0];
            try {
              await onMedia?.({
                jid,
                number,
                name,
                kind: media.kind,
                mimetype: media.mimetype,
                // Scaricamento PIGRO: chi chiama lo invoca solo se serve
                // davvero. Così un media da un numero non in lista non viene
                // mai scaricato (niente banda né dati non richiesti).
                download: () => downloadMedia(msg),
              });
            } catch (err) {
              console.error('Errore nella gestione del media:', err);
            }
          }
          // I media inviati da noi (fromMe) restano ignorati come prima.
          continue;
        }

        // Numero di telefono vero (in Baileys 7 il remoteJid può essere un LID).
        const number = await resolvePhoneNumber(sock, msg.key);

        if (msg.key.fromMe) {
          // Messaggio inviato dal nostro account: o è il bot, o è l'host a mano.
          if (!onHostReply) continue;
          if (msg.key.id && botSentIds.has(msg.key.id)) continue; // invio del bot
          const now = Date.now();
          if (botSentTexts.some((s) => s.text === text && now - s.ts < 60000)) continue;
          try {
            await onHostReply({ jid, number, text }); // risposta manuale dell'host
          } catch (err) {
            console.error('Errore nella gestione della risposta manuale:', err);
          }
          continue;
        }

        const name = msg.pushName || number || jid.split('@')[0];
        try {
          await onMessage({ jid, number, name, text });
        } catch (err) {
          console.error('Errore nella gestione del messaggio:', err);
        }
      }
    });
  }

  connect();

  async function sendToClient(jid, text) {
    // piccolo tocco "umano": mostra "sta scrivendo" e una breve pausa
    try {
      await sock.sendPresenceUpdate('composing', jid);
      await delay(800 + Math.min(text.length * 20, 2500));
    } catch {
      /* la presenza non è critica */
    }
    const sent = await sock.sendMessage(jid, { text });

    // Ricorda che questo messaggio l'ha mandato il bot (per non "impararlo").
    if (sent?.key?.id) {
      botSentIds.add(sent.key.id);
      if (botSentIds.size > 300) botSentIds.delete(botSentIds.values().next().value);
    }
    const now = Date.now();
    botSentTexts.push({ text, ts: now });
    botSentTexts = botSentTexts.filter((s) => now - s.ts < 60000);

    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch {
      /* idem */
    }
  }

  return { sendToClient };
}

// Le funzioni qui sotto sono pure (nessuna connessione, nessuno stato) ed è per
// questo che sono esportate: servono ai test in test/whatsapp.test.js. Fuori di
// lì usa startWhatsApp.

// In Baileys 7 una chat 1:1 può avere remoteJid = LID (@lid) e remoteJidAlt =
// numero (@s.whatsapp.net). Qui ricaviamo il numero di telefono vero.
export async function resolvePhoneNumber(sock, key) {
  for (const j of [key.remoteJid, key.remoteJidAlt]) {
    if (j && j.endsWith('@s.whatsapp.net')) return jidToNumber(j);
  }
  const lid = [key.remoteJid, key.remoteJidAlt].find((j) => j && j.endsWith('@lid'));
  if (lid) {
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
      if (pn) return jidToNumber(pn);
    } catch {
      /* mapping non disponibile: si usa il fallback */
    }
  }
  return jidToNumber(key.remoteJid);
}

// "Spacchetta" i wrapper (messaggi effimeri / view-once): spesso il contenuto
// reale è annidato lì. Se non c'è wrapper, restituisce il messaggio così com'è.
export function unwrapMessage(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message?.viewOnceMessageV2Extension?.message ||
    message
  );
}

export function extractText(message) {
  const m = unwrapMessage(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim();
}

// Classifica il media: tipo leggibile + mimetype dichiarato da WhatsApp.
// Restituisce null se il messaggio non contiene un media.
export function describeMedia(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  if (m.imageMessage) return { kind: 'foto', mimetype: m.imageMessage.mimetype };
  if (m.audioMessage) {
    return {
      kind: m.audioMessage.ptt ? 'nota vocale' : 'audio',
      mimetype: m.audioMessage.mimetype,
    };
  }
  if (m.videoMessage) return { kind: 'video', mimetype: m.videoMessage.mimetype };
  if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
    return { kind: 'documento', mimetype: doc?.mimetype };
  }
  if (m.stickerMessage) return { kind: 'sticker', mimetype: m.stickerMessage.mimetype };
  if (m.contactMessage || m.contactsArrayMessage) return { kind: 'contatto', mimetype: null };
  if (m.locationMessage || m.liveLocationMessage) return { kind: 'posizione', mimetype: null };
  return null;
}

// Dimensione dichiarata dal mittente nel protocollo, se presente.
// È un valore che arriva dall'esterno, quindi non ci si può fidare: serve solo
// a scartare in anticipo i file palesemente enormi, prima di scaricarli.
export function declaredFileLength(message) {
  const m = unwrapMessage(message);
  const media =
    m?.imageMessage || m?.audioMessage || m?.videoMessage || m?.documentMessage ||
    m?.documentWithCaptionMessage?.message?.documentMessage || m?.stickerMessage;
  const len = Number(media?.fileLength ?? 0);
  return Number.isFinite(len) ? len : 0;
}

/**
 * Scarica e decifra il contenuto di un media. Restituisce un Buffer.
 * Lancia se il download fallisce o se il file supera MAX_MEDIA_BYTES.
 *
 * Il controllo è DOPPIO e l'ordine conta: prima sulla dimensione dichiarata,
 * per non bufferizzare in memoria un file enorme, e poi su quella reale, perché
 * la dichiarata è controllata dal mittente e potrebbe mentire.
 */
async function downloadMedia(msg) {
  const declared = declaredFileLength(msg.message);
  if (declared > MAX_MEDIA_BYTES) {
    throw new Error(`Media troppo grande (${Math.round(declared / 1048576)} MB dichiarati).`);
  }

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger });
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    throw new Error('Download del media vuoto o non valido.');
  }
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(`Media troppo grande (${Math.round(buffer.length / 1048576)} MB).`);
  }
  return buffer;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
