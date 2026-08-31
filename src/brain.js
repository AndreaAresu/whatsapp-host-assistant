import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadKnowledge } from './knowledge.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_INSTRUCTIONS = `Sei Alessio, l'host che risponde su WhatsApp di una casa vacanze a Costa Rei (Sardegna) alle richieste dei clienti.

COME SCRIVI
Scrivi come scrive una persona dal telefono: frasi corte, parole di tutti i giorni, il punto fermo come segno principale. Dove ti verrebbe un inciso lungo, spezza in due frasi. Dove serve una pausa dentro la frase, usa la virgola, i due punti o una parentesi.
Vai dritto alla risposta. Niente premesse tipo "Certo!" o "Ottima domanda", niente riepilogo finale, niente elenchi puntati quando bastano due righe. Le forme contratte vanno bene. Un'emoji ogni tanto va bene, al massimo una per messaggio.
Il cliente sta scrivendo ad Alessio e deve avere l'impressione di parlare con lui. Quindi non nominare mai un assistente, un bot, un'intelligenza artificiale o una base di conoscenza, e non dire che stai controllando o verificando dei documenti: di' quello che sai, e quando non lo sai di' che controlli e fai sapere.

<esempi>
<esempio lingua="it">
Cliente: A che ora posso fare il check-in?
draft: Ciao! Il check-in è dalle 16 alle 23.30. Le chiavi le trovi nella key-box a destra della porta, il codice è 0000. Buon viaggio!
</esempio>
<esempio lingua="en">
Cliente: Can I pay the deposit next week?
draft: Hi! Let me check that with my booking details and get back to you shortly.
</esempio>
<esempio lingua="it">
Cliente: Il condizionatore fa un rumore strano quando lo spengo, è normale?
draft: Sì, tranquillo. Quando lo spegni parte lo svuotamento della cassetta dell'acqua e sul display vedi un caricamento. Basta aspettare che finisca senza toccare niente.
</esempio>
<esempio lingua="es">
Cliente: ¿Hay algún supermercado cerca?
draft: ¡Hola! Sí, el Supermercato G. Tre está a unos 800 metros, 10 minutos andando. En temporada alta abre también el domingo por la mañana.
</esempio>
</esempi>

REGOLE FONDAMENTALI:
1. La lingua del messaggio del cliente è la lingua in cui scrivi il campo "draft" E il campo "reason". Cliente in inglese: draft in inglese e reason in inglese. Cliente in spagnolo: entrambi in spagnolo. Cliente in italiano: entrambi in italiano. Vale per qualsiasi altra lingua.
2. Il cliente può aver scritto più messaggi di fila senza ricevere risposta: succede ogni volta che una bozza precedente è ancora in attesa dell'approvazione dell'host, e per il cliente è come se l'host non avesse ancora letto. In quel caso il suo turno arriva diviso in due parti: dentro <messaggi_precedenti_senza_risposta> ci sono le domande vecchie, dentro <messaggio_attuale> quella a cui il cliente sta aspettando risposta ADESSO. Rispondi a <messaggio_attuale>. Le precedenti sono contesto: se stanno bene insieme puoi toccarle nella stessa risposta, ma il punto di partenza è sempre <messaggio_attuale>. Non nominare mai questi tag al cliente.
3. Usa SOLO le informazioni presenti nella BASE DI CONOSCENZA fornita o, per le domande sulla zona, quelle trovate con la ricerca web. NON inventare mai dati (orari, password WiFi, indirizzi, prezzi della casa, ecc.). Se un'informazione sulla casa è segnata «DA COMPLETARE» o non è presente, consideralo come "non lo so".
4. Scrivi SEMPRE una bozza di risposta pronta da inviare (nella lingua del cliente), anche quando vai in escalation: così all'host basta confermarla o modificarla. Se non sai qualcosa, la bozza dev'essere onesta e non deve inventare.

IMMAGINI:
- Il cliente può allegare una foto. Guardala e tieni conto di quello che mostra: di solito è un guasto o un problema in casa (elettrodomestico, perdita d'acqua, danno), oppure un dettaglio della casa o della zona su cui sta chiedendo.
- ⚠️ ECCEZIONE ASSOLUTA, DOCUMENTI D'IDENTITÀ: se la foto è (anche solo in parte) una carta d'identità, un passaporto, una patente, una tessera sanitaria o un altro documento personale, FERMATI SUBITO. Metti categoria "documento_identita", action "escala", e NON trascrivere, NON descrivere e NON riassumere NIENTE di quello che c'è nel documento: né nome, né numeri, né date, né indirizzi, né volto. Nel campo "reason" scrivi solo che è un documento. Nel campo "draft" scrivi un messaggio neutro al cliente che conferma di aver ricevuto il documento, senza citarne alcun dato.
- Le foto dei documenti servono all'host per la registrazione su alloggiatiweb: se ne occupa lui a mano, tu non devi estrarne i dati.
- Non identificare né descrivere le persone ritratte nelle foto.

RICERCA WEB:
- Per le domande di tipo "info_zona" (spiagge, ristoranti, supermercati, farmacie, come arrivare, cosa fare in zona), se l'informazione non è già nella base di conoscenza, USA lo strumento web_search per trovarla, poi scrivi la bozza basandoti sui risultati.
- NON usare web_search per le regole della casa né per i temi sensibili.

FAQ IMPARATE:
- Le "FAQ IMPARATE" nella base di conoscenza sono risposte già approvate dall'host in passato: sono affidabili. Se una di esse risponde alla domanda del cliente ed è ancora valida (NON marcata «SCADUTA»), usala come fonte e metti action "invia", anche per le domande sulla zona.
- Se la FAQ corrispondente è marcata «SCADUTA», NON fidarti: trattala come assente (per le info di zona, cerca sul web e metti "escala").

COME CLASSIFICARE E DECIDERE (campo "action"):
- "regole_casa": uso della casa, elettrodomestici, raccolta differenziata, check-out, regole. Se l'informazione è nella base di conoscenza → action "invia".
- "info_zona": spiagge, ristoranti, supermercati, farmacie, come arrivare, cosa fare in zona. → se la risposta è già in una FAQ IMPARATA ancora valida, usala e metti action "invia"; altrimenti cerca sul web e metti SEMPRE action "escala" (serve la conferma dell'host), proponendo comunque una bozza completa.
- "sensibile": prenotazioni, pagamenti, prezzi, disponibilità, date, modifiche o cancellazioni, lamentele o problemi/guasti, documenti d'identità. → SEMPRE action "escala". Non confermare mai prezzi, date o disponibilità.
- "saluto_altro": saluti e convenevoli → puoi rispondere ("invia") in modo cordiale.
- "documento_identita": la foto contiene un documento personale → SEMPRE action "escala", senza estrarne alcun dato (vedi la sezione IMMAGINI).
- Se l'informazione richiesta NON è disponibile, oppure sei in dubbio → action "escala".

Quando hai la risposta, concludi SEMPRE chiamando lo strumento submit_response con la tua decisione. Non terminare mai con solo testo libero.`;

// Strumento di ricerca web nativo, con posizione impostata su Costa Rei per
// avere risultati locali (farmacie, supermercati, ristoranti vicini...).
// NB: la versione del tool è legata al modello. `web_search_20250305` è la
// variante corretta per Haiku 4.5; la più recente `web_search_20260209` (con
// filtro dinamico) richiede Opus 4.6+ / Sonnet 4.6+. Se cambi MODEL, ricontrolla
// anche questa riga.
const MAX_RICERCHE_WEB = 3;

// Tetto ai token della risposta. Conta soprattutto per la LATENZA: la
// generazione è la parte lenta, e una risposta lunga il doppio impiega il
// doppio. Un messaggio WhatsApp non ne ha comunque bisogno — il system prompt
// chiede già risposte concise.
const MAX_TOKEN_RISPOSTA = 1500;

const webSearchTool = (maxUses = MAX_RICERCHE_WEB) => ({
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: maxUses,
  user_location: {
    type: 'approximate',
    city: 'Costa Rei',
    region: 'Sardegna',
    country: 'IT',
    timezone: 'Europe/Rome',
  },
});

// Strumento con cui il modello consegna la sua decisione finale.
const RESPONSE_TOOL = {
  name: 'submit_response',
  description: 'Registra la decisione del bot e la bozza di risposta per il cliente.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['regole_casa', 'info_zona', 'sensibile', 'saluto_altro', 'documento_identita'],
        description: 'La categoria della domanda del cliente.',
      },
      action: {
        type: 'string',
        enum: ['invia', 'escala'],
        description:
          '"invia" se la risposta può partire da sola, "escala" se serve la conferma dell\'host.',
      },
      language: {
        type: 'string',
        description: 'Lingua del cliente (es. "it", "en", "es").',
      },
      draft: {
        type: 'string',
        description: 'La bozza di risposta per il cliente, già pronta, nella sua lingua.',
      },
      reason: {
        type: 'string',
        // Segue la lingua del cliente, come "draft": la demo web mostra questo
        // campo a chi scrive, e una spiegazione in una lingua che non legge non
        // spiega niente. Per l'host cambia poco: il messaggio a cui si
        // riferisce ce l'ha davanti nella stessa lingua.
        description:
          "Breve spiegazione per l'host del perché di questa decisione, scritta nella STESSA lingua del messaggio del cliente.",
      },
    },
    required: ['category', 'action', 'language', 'draft', 'reason'],
  },
};

// L'API richiede messaggi che si alternano user/assistant a partire da "user".
// I clienti spesso mandano più messaggi di fila: qui li uniamo in un turno solo.
/**
 * Fonde i turni consecutivi dello stesso ruolo (i clienti mandano più messaggi
 * di fila) e taglia in testa finché non si parte da un turno "user".
 *
 * Più messaggi del CLIENTE di fila vogliono dire che a quelli prima non è mai
 * stata consegnata una risposta: succede a ogni escalation, e in rodaggio
 * l'escalation è sempre. Incollandoli con un semplice a capo il confine
 * spariva e il modello rispondeva al primo della pila invece che all'ultimo
 * (misurato: rispondeva al check-in mentre il cliente chiedeva del WiFi). I tag
 * rendono il confine esplicito. Sul turno singolo, che è il caso normale, non
 * si aggiunge niente.
 */
function normalizeMessages(messages) {
  const gruppi = [];
  for (const m of messages) {
    const ultimo = gruppi[gruppi.length - 1];
    if (ultimo && ultimo.role === m.role) ultimo.parti.push(m.content);
    else gruppi.push({ role: m.role, parti: [m.content] });
  }

  const out = [];
  for (const g of gruppi) {
    const testuali = g.parti.every((c) => typeof c === 'string');
    if (g.parti.length === 1 || !testuali) {
      // Con un allegato il contenuto è un array di blocchi: non si fonde, e
      // l'API accetta comunque turni consecutivi dello stesso ruolo.
      for (const c of g.parti) out.push({ role: g.role, content: c });
    } else if (g.role !== 'user') {
      out.push({ role: g.role, content: g.parti.join('\n') });
    } else {
      const attuale = g.parti[g.parti.length - 1];
      const precedenti = g.parti.slice(0, -1).join('\n');
      out.push({
        role: 'user',
        content:
          `<messaggi_precedenti_senza_risposta>\n${precedenti}\n</messaggi_precedenti_senza_risposta>\n` +
          `<messaggio_attuale>\n${attuale}\n</messaggio_attuale>`,
      });
    }
  }

  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}


function systemBlocks(knowledgeText) {
  return [
    { type: 'text', text: SYSTEM_INSTRUCTIONS },
    {
      type: 'text',
      text: `BASE DI CONOSCENZA:\n\n${knowledgeText}`,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

// Formati immagine accettati dall'API Claude.
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isSupportedImageType(mimetype) {
  return SUPPORTED_IMAGE_TYPES.has(String(mimetype || '').split(';')[0].trim().toLowerCase());
}

/**
 * Costruisce il contenuto del turno del cliente. Con una foto allegata il
 * turno diventa multimodale: l'immagine PRIMA del testo, come raccomandato
 * (Claude lavora meglio con l'immagine in testa).
 */
function buildUserContent(text, image) {
  if (!image) return text;
  return [
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
    { type: 'text', text: text || '(il cliente ha inviato una foto senza testo)' },
  ];
}

// Campi di `usage` che ha senso sommare fra un giro e l'altro del ciclo.
const CAMPI_USAGE = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
];

/**
 * Somma l'uso di token di più risposte. Serve perché una ricerca web può far
 * tornare `pause_turn` e quindi generare PIÙ chiamate all'API per un solo
 * messaggio del cliente: prendere solo l'ultima risposta (com'era prima)
 * sottostima il consumo reale, e quindi il costo.
 */
function sommaUsage(totale, usage) {
  if (!usage) return totale;
  for (const campo of CAMPI_USAGE) {
    const v = usage[campo];
    if (typeof v === 'number') totale[campo] = (totale[campo] ?? 0) + v;
  }
  return totale;
}

/**
 * Dato il messaggio di un cliente (ed eventuale storico), restituisce la
 * decisione del bot: categoria, action (invia/escala), bozza, motivo e le
 * eventuali fonti web usate.
 *
 * `image` è opzionale: { data: <base64>, mediaType: 'image/jpeg' }. Se c'è, il
 * modello guarda la foto insieme al testo. Le foto di documenti d'identità
 * vengono classificate "documento_identita" senza estrarne alcun dato.
 *
 * `maxTokens` limita la lunghezza della risposta (default 1500). Abbassarlo
 * riduce la latenza in modo diretto: è la generazione a dominare il tempo.
 *
 * `maxWebSearches` limita quante ricerche web il modello può fare in un turno
 * (default 3). Con 0 lo strumento non viene proprio offerto al modello: serve
 * alla demo web, dove la latenza ha un tetto rigido e la ricerca è la parte
 * lenta (2-3s senza, 6-10s con).
 *
 * Il modello può usare web_search (per le domande sulla zona) e poi conclude
 * chiamando submit_response. Il ciclo sotto gestisce i tool server-side e gli
 * eventuali "pause_turn".
 */
export async function think(
  clientMessage,
  history = [],
  { image, maxWebSearches = MAX_RICERCHE_WEB, maxTokens = MAX_TOKEN_RISPOSTA } = {}
) {
  const knowledge = loadKnowledge();
  const messages = normalizeMessages([
    ...history,
    { role: 'user', content: buildUserContent(clientMessage, image) },
  ]);
  const sourcesByUrl = new Map();
  const usage = {};
  let finalResponse;
  let steps = 0;

  for (let step = 0; step < 5; step++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system: systemBlocks(knowledge.text),
      tools: maxWebSearches > 0
        ? [webSearchTool(maxWebSearches), RESPONSE_TOOL]
        : [RESPONSE_TOOL], // 0 = niente ricerca web (demo con latenza garantita)
      messages,
    });

    // Raccogli le fonti dalle ricerche web (per farle vedere all'host).
    for (const block of response.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === 'web_search_result' && !sourcesByUrl.has(r.url)) {
            sourcesByUrl.set(r.url, { title: r.title, url: r.url });
          }
        }
      }
    }

    finalResponse = response;
    steps++;
    sommaUsage(usage, response.usage);

    // Il server chiede di proseguire (ricerca web lunga): rimanda e continua.
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    break;
  }

  const sources = [...sourcesByUrl.values()];

  const toolUse = finalResponse.content.find(
    (block) => block.type === 'tool_use' && block.name === 'submit_response'
  );

  if (!toolUse) {
    return {
      category: 'sensibile',
      action: 'escala',
      language: 'it',
      draft: '',
      reason: 'The model returned no structured decision: escalating for safety.',
      sources,
      usage,
      steps,
    };
  }

  const decisione = { ...toolUse.input, sources, usage, steps };

  // SICUREZZA: un "invia" senza bozza manderebbe al cliente un messaggio vuoto.
  // Non è teorico: se la generazione sbatte contro max_tokens a metà della
  // chiamata al tool, l'input arriva troncato e i campi finali mancano, mentre
  // category e action ci sono già. Stessa regola del ramo qui sopra: nel dubbio
  // si escala, così l'host se ne accorge invece del cliente. Una bozza vuota
  // con "escala" invece è legittima, il modello a volte non sa cosa proporre.
  if (decisione.action === 'invia' && !String(decisione.draft ?? '').trim()) {
    return {
      ...decisione,
      action: 'escala',
      draft: '',
      reason:
        decisione.reason ||
        'The model delivered no draft (likely truncated): escalating for safety.',
    };
  }

  return decisione;
}

const LEARN_TOOL = {
  name: 'valuta_apprendimento',
  description:
    "Valuta se la risposta dell'host a un cliente è una FAQ riutilizzabile da salvare.",
  input_schema: {
    type: 'object',
    properties: {
      reusable: {
        type: 'boolean',
        description:
          'true se è la risposta a una domanda informativa che potrebbe rifare un altro cliente.',
      },
      categoria: {
        type: 'string',
        enum: ['regole_casa', 'info_zona', 'sensibile', 'saluto_altro'],
      },
      domanda: {
        type: 'string',
        description: 'La domanda a cui risponde, formulata in modo generale e riutilizzabile.',
      },
    },
    required: ['reusable', 'categoria', 'domanda'],
  },
};

/**
 * Valuta se uno scambio (domanda cliente + risposta manuale dell'host) è una
 * FAQ riutilizzabile da salvare. Usato per imparare dalle risposte scritte a
 * mano dal telefono.
 */
export async function evaluateForLearning(question, answer) {
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 300,
    system:
      "Valuti se uno scambio host-cliente di una casa vacanze contiene una FAQ riutilizzabile da salvare. Sono riutilizzabili solo informazioni generali (regole della casa, info sulla zona). NON sono riutilizzabili: saluti, convenevoli e i temi sensibili specifici di una prenotazione (prezzi concordati, date, pagamenti di quel cliente).",
    tools: [LEARN_TOOL],
    tool_choice: { type: 'tool', name: 'valuta_apprendimento' },
    messages: [
      {
        role: 'user',
        content: `Domanda del cliente:\n"${question}"\n\nRisposta dell'host:\n"${answer}"\n\nÈ una FAQ riutilizzabile?`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  return toolUse ? toolUse.input : { reusable: false, categoria: 'saluto_altro', domanda: question };
}
