// Endpoint della demo web pubblica: /api/chat
//
// Riusa lo STESSO cervello del bot WhatsApp (`src/brain.js`), senza duplicarne
// la logica. Le differenze rispetto al bot sono tre, tutte imposte dal fatto
// che qui chiunque può scrivere:
//
//  1. BASE DI CONOSCENZA FINTA. `knowledge/casa.demo.md` al posto di `casa.md`:
//     la guida vera contiene il codice della key-box e l'indirizzo di una casa
//     reale, e qui non c'è nessun host che approvi le bozze prima dell'invio.
//  2. NIENTE STATO SUL SERVER. Le Netlify Functions sono serverless: niente
//     SQLite, niente FAQ imparate. Lo storico arriva dal client a ogni richiesta
//     (e proprio per questo va validato, non solo troncato).
//  3. TETTI DI SPESA. L'allowlist qui non esiste, quindi il posto dell'allowlist
//     lo prendono il rate limiting per IP e il tetto giornaliero globale.
//
// La decisione «invia o escala» NON viene presa qui: come in `engine.js`, questo
// livello si limita a restituire la decisione del modello. È il frontend a fare
// da canale (inbox host), esattamente come fa telegram.js per il bot vero.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validaRichiesta } from './_valida.mjs';

// --- Percorsi, da impostare PRIMA di importare brain.js --------------------
// knowledge.js legge CASA_PATH una volta sola, al caricamento del modulo.

/**
 * Trova la base di conoscenza della demo dentro il bundle della funzione.
 * Il percorso di default di knowledge.js (relativo a src/) non sopravvive al
 * bundling di esbuild, quindi lo risolviamo qui provando le posizioni note in
 * cui Netlify deposita gli `included_files`.
 */
function trovaBaseConoscenza() {
  const candidati = [
    process.env.CASA_PATH,
    join(process.cwd(), 'knowledge', 'casa.demo.md'),
    process.env.LAMBDA_TASK_ROOT && join(process.env.LAMBDA_TASK_ROOT, 'knowledge', 'casa.demo.md'),
    join(process.cwd(), '..', '..', 'knowledge', 'casa.demo.md'),
  ].filter(Boolean);

  for (const p of candidati) {
    if (existsSync(p)) return p;
  }
  // Meglio fallire subito e forte che servire in silenzio la guida VERA.
  throw new Error(
    `Base di conoscenza della demo non trovata. Provati: ${candidati.join(' · ')}. ` +
      'Controlla `included_files` in netlify.toml.'
  );
}

process.env.CASA_PATH = trovaBaseConoscenza();
// Le FAQ imparate dai clienti veri non devono MAI finire nel prompt pubblico:
// puntiamo a un file che non esiste, loadLearned() restituirà [].
process.env.LEARNED_PATH = '/tmp/nessuna-faq-demo.json';

const { think, isSupportedImageType } = await import('../../src/brain.js');
// Gemini fa SOLO da trascrittore (audio → testo): l'API di Claude non accetta
// audio in ingresso. È lo stesso adattatore che usa il bot WhatsApp, non una
// seconda copia — così le regole di casa restano su un solo modello.
const { transcribeAudio, isTranscriptionEnabled } = await import('../../src/audio.js');

// --- Limiti ----------------------------------------------------------------
//
// LATENZA E TIMEOUT — il vincolo che decide questa configurazione.
// Le funzioni sincrone di Netlify hanno un tetto di ESECUZIONE TOTALE: 10s sul
// piano free, 26s su Pro. Lo streaming migliora l'attesa percepita ma NON
// allunga quel tetto. Misurato con Haiku 4.5:
//   · senza ricerca web  → 2,4-3,5 s   (ampiamente dentro)
//   · con ricerca web    → 6,0-10,3 s  (sfiora e a volte sfonda i 10s)
// Quindi: su piano free conviene DEMO_WEB_SEARCH=off, oppure Pro (26s).
// In ogni caso c'è una scadenza nostra, sotto quella di Netlify, così l'utente
// legge un messaggio sensato invece dell'errore grezzo della piattaforma.
const TIMEOUT_NETLIFY_MS = Number(process.env.TIMEOUT_FUNZIONE_MS) || 10_000;
const MARGINE_MS = 1_200; // per chiudere lo stream prima che Netlify tagli
const SCADENZA_MS = TIMEOUT_NETLIFY_MS - MARGINE_MS;

// `off` toglie del tutto lo strumento web_search: la demo perde le domande di
// zona ma la latenza resta sotto i 3,5s, garantita.
// Una risposta WhatsApp sta in poche righe. Il tetto basso serve alla latenza
// (la generazione è la parte lenta) e vale doppio sui vocali, che spendono già
// ~1,5s in trascrizione prima ancora di iniziare a ragionare.
const MAX_TOKEN_DEMO = Number(process.env.MAX_TOKEN_RISPOSTA) || 700;

const RICERCA_WEB_ATTIVA = process.env.DEMO_WEB_SEARCH !== 'off';
const MAX_RICERCHE_WEB_DEMO = RICERCA_WEB_ATTIVA ? 2 : 0;

// Tetto per visitatore. È la difesa principale contro chi spamma la demo:
// senza, un solo visitatore può bruciare i crediti di una giornata. La finestra
// è lunga apposta — 15 messaggi bastano per capire cosa fa il bot, e chi ne
// vuole di più sta giocando, non valutando.
// 15 erano pochi: chi prova la demo sul serio vuole vedere i due modi
// (rodaggio acceso e spento), una foto e un vocale, e li finisce prima di
// arrivare alla parte interessante. Il tetto di SPESA resta comunque
// LIMITE_GIORNALIERO, che non dipende da questo numero.
const LIMITE_IP = Number(process.env.LIMITE_MESSAGGI) || 25;
const FINESTRA_IP_MS = (Number(process.env.FINESTRA_MINUTI) || 60) * 60 * 1000;
const LIMITE_GIORNALIERO = Number(process.env.LIMITE_GIORNALIERO) || 300;

// --- Rate limiting (Netlify Blobs) -----------------------------------------
//
// Serverless = niente memoria condivisa fra istanze, quindi un contatore in RAM
// non limiterebbe niente. Blobs è il KV integrato di Netlify.
//
// NOTA: se Blobs non è disponibile sul piano in uso, questa funzione LASCIA
// PASSARE la richiesta e lo urla nei log. È una scelta: bloccare tutto
// renderebbe la demo morta a ogni problema infrastrutturale. La rete di
// sicurezza vera contro la spesa resta lo **spending limit sulla Console
// Anthropic**, che non dipende da questo codice.
async function controllaLimiti(ip) {
  let store;
  try {
    const { getStore } = await import('@netlify/blobs');
    store = getStore('rate-limit-assistant');
  } catch (err) {
    console.error('⚠️  Netlify Blobs non disponibile: rate limiting DISATTIVO.', err.message);
    return { ok: true, degradato: true, rimanenti: null, limite: LIMITE_IP };
  }

  const adesso = Date.now();
  const oggi = new Date().toISOString().slice(0, 10);

  try {
    // Tetto globale giornaliero: protegge il portafoglio, non il singolo utente.
    const chiaveGiorno = `giorno-${oggi}`;
    const giorno = (await store.get(chiaveGiorno, { type: 'json' })) ?? { n: 0 };
    if (giorno.n >= LIMITE_GIORNALIERO) {
      return {
        ok: false,
        stato: 429,
        messaggio:
          'The demo has hit its message limit for today. Come back tomorrow — ' +
          'this is a deliberate spending cap, not a fault.',
      };
    }

    // Tetto per IP: protegge dagli abusi di un singolo visitatore.
    const chiaveIp = `ip-${ip}`;
    const voce = (await store.get(chiaveIp, { type: 'json' })) ?? { n: 0, da: adesso };
    const finestraScaduta = adesso - voce.da > FINESTRA_IP_MS;
    const conteggio = finestraScaduta ? 0 : voce.n;

    if (conteggio >= LIMITE_IP) {
      const attesa = Math.ceil((FINESTRA_IP_MS - (adesso - voce.da)) / 60000);
      return {
        ok: false,
        stato: 429,
        messaggio:
          `You have used all ${LIMITE_IP} demo messages. ` +
          `They reset in about ${attesa} minutes. It's a deliberate spending cap.`,
      };
    }

    await store.setJSON(chiaveIp, {
      n: conteggio + 1,
      da: finestraScaduta ? adesso : voce.da,
    });
    await store.setJSON(chiaveGiorno, { n: giorno.n + 1 });
    const inizioFinestra = finestraScaduta ? adesso : voce.da;
    return {
      ok: true,
      rimanenti: LIMITE_IP - conteggio - 1, // quanti ne restano a QUESTO visitatore
      limite: LIMITE_IP,
      rimanentiOggi: LIMITE_GIORNALIERO - giorno.n - 1,
      // Minuti al reset: se finiscono i messaggi, un contatore fermo senza
      // dire quando riparte sembra un guasto e l'unica via è ricaricare.
      riparteFraMinuti: Math.max(1, Math.ceil((FINESTRA_IP_MS - (adesso - inizioFinestra)) / 60000)),
    };
  } catch (err) {
    console.error('⚠️  Errore nel rate limiting: lascio passare.', err.message);
    return { ok: true, degradato: true, rimanenti: null, limite: LIMITE_IP };
  }
}

// --- Handler ---------------------------------------------------------------
export default async (req, context) => {
  if (req.method !== 'POST') {
    return Response.json({ errore: 'Use POST.' }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ errore: 'Invalid JSON.' }, { status: 400 });
  }

  const { errore, text, history, image, audio } = validaRichiesta(body);
  if (errore) return Response.json({ errore }, { status: 400 });

  const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || 'sconosciuto';
  const limiti = await controllaLimiti(ip);
  if (!limiti.ok) return Response.json({ errore: limiti.messaggio }, { status: limiti.stato });

  // --- Risposta in streaming ------------------------------------------------
  //
  // NON è un vezzo: misurato in locale, una domanda sulla zona che attiva la
  // ricerca web impiega 6-10s, contro il timeout di 10s delle funzioni sincrone
  // di Netlify. Mandando subito i primi byte e un battito ogni 2s la connessione
  // resta viva, e intanto l'utente vede che il bot sta cercando invece di
  // fissare uno schermo fermo.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const invia = (oggetto) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(oggetto) + '\n'));
        } catch { /* client disconnesso */ }
      };

      const t0 = Date.now();
      const battito = setInterval(() => invia({ tipo: 'battito' }), 2000);

      try {
        // --- Vocale: prima la trascrizione, poi la pipeline normale -------
        //
        // È l'unico punto in cui interviene un secondo provider. Gemini NON
        // decide niente: traduce l'audio in testo e si toglie di mezzo. La
        // decisione resta di Claude, con le stesse regole di casa del testo.
        let testoFinale = text;
        let trascrizione = null;

        if (audio) {
          if (!isTranscriptionEnabled()) {
            clearInterval(battito);
            invia({
              tipo: 'errore',
              messaggio: 'Voice transcription is not configured on this deploy.',
            });
            return;
          }
          invia({ tipo: 'stato', valore: 'ascolto' });
          try {
            trascrizione = await transcribeAudio(Buffer.from(audio.data, 'base64'), audio.mediaType);
          } catch (err) {
            console.error('Trascrizione fallita:', err);
            clearInterval(battito);
            invia({
              tipo: 'errore',
              messaggio: 'I could not make out that voice note. Try again, or type it.',
            });
            return;
          }
          if (!trascrizione) {
            clearInterval(battito);
            invia({
              tipo: 'errore',
              messaggio: 'The voice note is empty or unintelligible. Try speaking closer to the mic.',
            });
            return;
          }
          // Da qui in poi è un messaggio di testo come gli altri.
          testoFinale = trascrizione;
          invia({ tipo: 'trascrizione', testo: trascrizione });
        }

        // --- Foto: la guarda Claude nella stessa chiamata che decide -------
        let immagine;
        if (image) {
          if (!isSupportedImageType(image.mediaType)) {
            clearInterval(battito);
            invia({ tipo: 'errore', messaggio: 'Unsupported image format.' });
            return;
          }
          immagine = { data: image.data, mediaType: image.mediaType };
          // Senza didascalia serve comunque un turno di testo: è la stessa
          // frase che usa index.js per le foto WhatsApp.
          if (!testoFinale) testoFinale = 'Il cliente ha inviato questa foto.';
        }

        invia({ tipo: 'stato', valore: 'ragiono' });

        // Corsa contro la scadenza: se il modello non ha finito in tempo
        // chiudiamo NOI con un messaggio comprensibile. Senza, Netlify
        // taglierebbe la connessione e il browser mostrerebbe un errore di rete.
        let scadenzaTimer;
        const scaduta = Symbol('scaduta');
        const d = await Promise.race([
          think(testoFinale, history, {
            image: immagine,
            maxWebSearches: MAX_RICERCHE_WEB_DEMO,
            maxTokens: MAX_TOKEN_DEMO,
          }),
          // Quel che resta della scadenza: la trascrizione di un vocale ha
          // già consumato parte del budget prima di arrivare qui.
          new Promise((r) => {
            const resta = Math.max(500, SCADENZA_MS - (Date.now() - t0));
            scadenzaTimer = setTimeout(() => r(scaduta), resta);
          }),
        ]);
        clearTimeout(scadenzaTimer);
        clearInterval(battito);

        if (d === scaduta) {
          console.warn(`⏱️  Scadenza a ${SCADENZA_MS}ms superata (ricerca web lenta).`);
          invia({
            tipo: 'errore',
            messaggio:
              'The web search took too long. Try again, or ask something about the ' +
              'house (check-in, appliances): those answers are immediate.',
          });
          return;
        }

        invia({
          tipo: 'decisione',
          category: d.category,
          action: d.action,
          language: d.language,
          // Il modello a volte escala con bozza vuota: il frontend deve poter
          // mostrare qualcosa di sensato invece di una bolla vuota.
          draft: d.draft || '',
          reason: d.reason,
          sources: d.sources ?? [],
          usage: d.usage ?? {},
          steps: d.steps ?? 1,
          ms: Date.now() - t0,
          // Cosa il modello ha DAVVERO ricevuto: per un vocale è la
          // trascrizione, non l'audio. L'host deve poterlo vedere, perché una
          // trascrizione può sbagliare.
          trascrizione,
          conImmagine: Boolean(immagine),
          rimanenti: limiti.rimanenti ?? null,
          limite: limiti.limite,
          rimanentiOggi: limiti.rimanentiOggi ?? null,
          riparteFraMinuti: limiti.riparteFraMinuti ?? null,
        });
      } catch (err) {
        clearInterval(battito);
        console.error('Errore nella pipeline della demo:', err);
        invia({
          tipo: 'errore',
          messaggio:
            'The model did not answer (overloaded or rate limited). Try again shortly.',
        });
      } finally {
        clearInterval(battito); // rete di sicurezza: nessun percorso deve lasciarlo vivo
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no', // niente buffering intermedio: lo streaming deve arrivare
    },
  });
};

export const config = { path: '/api/chat' };
