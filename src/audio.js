// Trascrizione dei messaggi vocali.
//
// PERCHÉ GOOGLE E NON CLAUDE: l'API di Claude non accetta audio in ingresso —
// esistono solo i content block `text`, `image` e `document`. Per i vocali
// serve per forza un altro provider. Qui Gemini fa SOLO da trascrittore
// (audio → testo): il testo poi rientra nella pipeline normale di brain.js,
// così il "cervello" del bot resta uno solo e le regole di casa non vanno
// duplicate su due provider.
import { spawn } from 'node:child_process';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';

// Oltre questa soglia non trascriviamo: un vocale di un cliente è breve, un
// file enorme è quasi sempre un errore (e costerebbe in proporzione).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TRANSCRIPT_CHARS = 4000; // il testo poi va nel prompt: teniamolo limitato

const PROMPT =
  'Trascrivi letteralmente questo messaggio vocale, nella lingua in cui è parlato. ' +
  'Rispondi SOLO con la trascrizione, senza virgolette, commenti, timestamp o preamboli. ' +
  "Se l'audio è vuoto, silenzioso o del tutto incomprensibile, rispondi esattamente: [INCOMPRENSIBILE]";

let client; // creato pigramente: senza chiave la trascrizione è disattivata

/** true se la trascrizione è configurata (serve GEMINI_API_KEY). */
export function isTranscriptionEnabled() {
  return Boolean(config.geminiApiKey);
}

function getClient() {
  if (!client) client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  return client;
}

/**
 * Transcodifica l'audio in WAV mono 16 kHz con ffmpeg, se disponibile.
 * Serve come rete di sicurezza: i vocali WhatsApp sono Opus in container Ogg,
 * mentre Gemini documenta "OGG Vorbis". Nella pratica l'invio diretto di
 * solito funziona, quindi ci proviamo prima e transcodifichiamo solo se
 * l'API rifiuta il formato. Se ffmpeg non c'è, restituisce null.
 */
function transcodeToWav(buffer) {
  return new Promise((resolve) => {
    let ff;
    try {
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-f', 'wav', '-ar', '16000', '-ac', '1', 'pipe:1']);
    } catch {
      return resolve(null); // ffmpeg non installato
    }

    const chunks = [];
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // Se ffmpeg si impianta non blocchiamo il bot all'infinito.
    const timer = setTimeout(() => {
      ff.kill('SIGKILL');
      done(null);
    }, 30000);

    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => {
      clearTimeout(timer);
      done(null); // eseguibile assente o non avviabile
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && chunks.length ? Buffer.concat(chunks) : null);
    });

    // Senza questo handler un EPIPE (ffmpeg che muore presto) diventa un
    // 'error' non gestito che butterebbe giù il processo.
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
  });
}

async function callGemini(buffer, mimeType) {
  const response = await getClient().models.generateContent({
    model: config.geminiModel,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: buffer.toString('base64'), mimeType } },
          { text: PROMPT },
        ],
      },
    ],
  });
  return (response.text ?? '').trim();
}

/**
 * Trascrive un messaggio vocale. Restituisce il testo, oppure null se non c'è
 * nulla di utilizzabile (audio incomprensibile o vuoto).
 * Lancia se la trascrizione non è configurata o se la chiamata fallisce: chi
 * chiama deve gestire l'errore avvisando l'host.
 */
export async function transcribeAudio(buffer, mimetype) {
  if (!isTranscriptionEnabled()) {
    throw new Error('Trascrizione non configurata (manca GEMINI_API_KEY).');
  }
  if (!buffer?.length) throw new Error('Audio vuoto.');
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio troppo lungo (${Math.round(buffer.length / 1048576)} MB).`);
  }

  // WhatsApp manda mimetype tipo "audio/ogg; codecs=opus": Gemini vuole il
  // MIME puro, senza parametri.
  const baseMime = String(mimetype || 'audio/ogg').split(';')[0].trim();

  let text;
  try {
    text = await callGemini(buffer, baseMime);
  } catch (err) {
    // Probabile formato rifiutato: riprova transcodificando, se ffmpeg c'è.
    const wav = await transcodeToWav(buffer);
    if (!wav) throw err; // niente ffmpeg: propaga l'errore originale
    console.log('ℹ️  Formato audio rifiutato da Gemini: riprovo dopo transcodifica in WAV.');
    text = await callGemini(wav, 'audio/wav');
  }

  if (!text || text.includes('[INCOMPRENSIBILE]')) return null;
  return text.slice(0, MAX_TRANSCRIPT_CHARS);
}
