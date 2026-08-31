// Validazione dell'input della demo web, tenuta in un modulo a parte perché è
// pura: nessuna dipendenza, nessuna chiamata di rete, quindi verificabile dalla
// suite di test come le altre funzioni pure del progetto.
//
// Perché serve: nel bot WhatsApp lo storico lo tiene il server (SQLite) e i
// media arrivano da numeri in allowlist. Qui è il BROWSER a mandare tutto, e
// chiunque può farlo. Ogni campo è input NON FIDATO:
//  · lo storico → si potrebbero iniettare turni arbitrari nel prompt
//  · immagini e audio → sono la voce di costo più alta e la più facile da
//    gonfiare (un'immagine enorme costa token; un audio lungo costa Gemini)

export const MAX_CARATTERI_MESSAGGIO = 500;
export const MAX_MESSAGGI_STORICO = 20; // come MAX_MESSAGES in src/memory.js
export const MAX_CARATTERI_STORICO = 2000;

// Formati immagine accettati dall'API di Claude (stessi di isSupportedImageType).
export const MIME_IMMAGINI = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Formati che MediaRecorder produce nei browser, più quelli che Gemini accetta.
// Verificati dal vivo: webm/opus (Chrome, Edge, Firefox), mp4 (Safari),
// ogg/opus (WhatsApp) e wav sono tutti trascritti correttamente.
export const MIME_AUDIO = new Set([
  'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg',
  'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a',
]);

// Il browser ridimensiona già le foto prima di mandarle: questi sono tetti di
// sicurezza contro un client che non lo fa (o che è ostile), non la norma.
export const MAX_BYTE_IMMAGINE = 1_500_000; // ~1,5 MB
export const MAX_BYTE_AUDIO = 2_000_000; // ~2 MB, circa 2 minuti di parlato

/** Byte reali rappresentati da una stringa base64, senza decodificarla. */
export function byteDaBase64(b64) {
  const n = b64.length;
  if (!n) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((n * 3) / 4) - padding;
}

const SOLO_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Valida un allegato { data, mediaType }. `data` può arrivare come data URL
 * ("data:image/jpeg;base64,…") o come base64 nudo: normalizziamo qui.
 */
// I messaggi d'errore sono in inglese come il resto della pagina: finiscono
// dritti in un chip nella chat, quindi sono interfaccia, non log.
function validaMedia(media, tipiAmmessi, maxByte, etichetta) {
  if (media == null) return { valore: undefined };
  if (typeof media !== 'object') return { errore: `${etichetta}: malformed.` };

  const mediaType = String(media.mediaType ?? '').split(';')[0].trim().toLowerCase();
  if (!tipiAmmessi.has(mediaType)) {
    return { errore: `${etichetta}: unsupported format (${mediaType || 'missing'}).` };
  }

  let data = typeof media.data === 'string' ? media.data : '';
  // Togli l'eventuale prefisso data URL e gli a capo che alcuni encoder mettono.
  data = data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!data) return { errore: `${etichetta}: empty.` };
  if (!SOLO_BASE64.test(data)) return { errore: `${etichetta}: invalid content.` };

  const byte = byteDaBase64(data);
  if (byte > maxByte) {
    return {
      errore: `${etichetta}: too large (${Math.round(byte / 1024)} KB, max ${Math.round(maxByte / 1024)} KB).`,
    };
  }

  return { valore: { data, mediaType, byte } };
}

export function validaRichiesta(body) {
  if (typeof body !== 'object' || body === null) {
    return { errore: 'Malformed request body.' };
  }

  const immagine = validaMedia(body.image, MIME_IMMAGINI, MAX_BYTE_IMMAGINE, 'Image');
  if (immagine.errore) return { errore: immagine.errore };

  const audio = validaMedia(body.audio, MIME_AUDIO, MAX_BYTE_AUDIO, 'Voice note');
  if (audio.errore) return { errore: audio.errore };

  // Uno solo per volta: la pipeline tratta la trascrizione del vocale COME il
  // testo del turno, quindi audio + immagine insieme sarebbero ambigui.
  if (immagine.valore && audio.valore) {
    return { errore: 'Send a photo or a voice note, not both.' };
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  // Con un allegato il testo è facoltativo: una foto senza didascalia o un
  // vocale sono messaggi completi.
  if (!text && !immagine.valore && !audio.valore) return { errore: 'Write a message first.' };
  if (text.length > MAX_CARATTERI_MESSAGGIO) {
    return { errore: `Message too long (max ${MAX_CARATTERI_MESSAGGIO} characters).` };
  }

  const grezzo = Array.isArray(body.history) ? body.history : [];
  const history = grezzo
    .filter(
      (m) =>
        m &&
        // SOLO user e assistant: un ruolo 'system' inviato dal client avrebbe
        // l'autorità di un'istruzione di sistema. Va scartato, non tradotto.
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim()
    )
    .slice(-MAX_MESSAGGI_STORICO)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARATTERI_STORICO) }));

  return { text, history, image: immagine.valore, audio: audio.valore };
}
