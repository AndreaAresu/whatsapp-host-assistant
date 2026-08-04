import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { loadKnowledge } from './knowledge.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_INSTRUCTIONS = `Sei l'assistente WhatsApp di una casa vacanze a Costa Rei (Sardegna).
Rispondi ai clienti come se fossi **Alessio**, l'host: tono cordiale, caloroso e conciso, come un host italiano su WhatsApp. Niente formalismi eccessivi né risposte chilometriche.

REGOLE FONDAMENTALI:
1. Rispondi SEMPRE nella stessa lingua del messaggio del cliente (italiano, inglese, spagnolo o qualsiasi altra).
2. Usa SOLO le informazioni presenti nella BASE DI CONOSCENZA fornita o, per le domande sulla zona, quelle trovate con la ricerca web. NON inventare mai dati (orari, password WiFi, indirizzi, prezzi della casa, ecc.). Se un'informazione sulla casa è segnata «DA COMPLETARE» o non è presente, consideralo come "non lo so".
3. Scrivi SEMPRE una bozza di risposta pronta da inviare (nella lingua del cliente), anche quando vai in escalation: così all'host basta confermarla o modificarla. Se non sai qualcosa, la bozza dev'essere onesta e non deve inventare.

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
- Se l'informazione richiesta NON è disponibile, oppure sei in dubbio → action "escala".

Quando hai la risposta, concludi SEMPRE chiamando lo strumento submit_response con la tua decisione. Non terminare mai con solo testo libero.`;

// Strumento di ricerca web nativo, con posizione impostata su Costa Rei per
// avere risultati locali (farmacie, supermercati, ristoranti vicini...).
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 3,
  user_location: {
    type: 'approximate',
    city: 'Costa Rei',
    region: 'Sardegna',
    country: 'IT',
    timezone: 'Europe/Rome',
  },
};

// Strumento con cui il modello consegna la sua decisione finale.
const RESPONSE_TOOL = {
  name: 'submit_response',
  description: 'Registra la decisione del bot e la bozza di risposta per il cliente.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['regole_casa', 'info_zona', 'sensibile', 'saluto_altro'],
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
        description: "Breve spiegazione in italiano per l'host del perché di questa decisione.",
      },
    },
    required: ['category', 'action', 'language', 'draft', 'reason'],
  },
};

// L'API richiede messaggi che si alternano user/assistant a partire da "user".
// I clienti spesso mandano più messaggi di fila: qui li uniamo in un turno solo.
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (
      last &&
      last.role === m.role &&
      typeof last.content === 'string' &&
      typeof m.content === 'string'
    ) {
      last.content += '\n' + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
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

/**
 * Dato il messaggio di un cliente (ed eventuale storico), restituisce la
 * decisione del bot: categoria, action (invia/escala), bozza, motivo e le
 * eventuali fonti web usate.
 *
 * Il modello può usare web_search (per le domande sulla zona) e poi conclude
 * chiamando submit_response. Il ciclo sotto gestisce i tool server-side e gli
 * eventuali "pause_turn".
 */
export async function think(clientMessage, history = []) {
  const knowledge = loadKnowledge();
  const messages = normalizeMessages([...history, { role: 'user', content: clientMessage }]);
  const sourcesByUrl = new Map();
  let finalResponse;

  for (let step = 0; step < 5; step++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: 1500,
      system: systemBlocks(knowledge.text),
      tools: [WEB_SEARCH_TOOL, RESPONSE_TOOL],
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
      reason: 'Il modello non ha restituito una decisione strutturata: escalation per sicurezza.',
      sources,
      usage: finalResponse.usage,
    };
  }

  return { ...toolUse.input, sources, usage: finalResponse.usage };
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
