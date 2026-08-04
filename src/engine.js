import { randomUUID } from 'node:crypto';
import { think } from './brain.js';
import { config } from './config.js';

/**
 * Cuore del bot: dato un messaggio di un cliente, decide cosa farne.
 * - se la risposta è "sicura" e non siamo in rodaggio → invia da solo al cliente
 * - altrimenti → manda la bozza all'host per l'approvazione
 *
 * `image` è opzionale ({ data: <base64>, mediaType }): serve per le foto
 * inviate dai clienti, che il modello guarda insieme al testo.
 *
 * È indipendente dal canale: `sendToClient` e `requestApproval` vengono passati
 * da chi lo usa (ora l'harness di prova, domani WhatsApp + Telegram).
 */
export async function handleClientMessage({
  conversationId,
  clientName,
  text,
  history = [],
  image,
  sendToClient,
  requestApproval,
}) {
  const decision = await think(text, history, { image });
  const autoSend = decision.action === 'invia' && !config.reviewEverything;

  if (autoSend) {
    await sendToClient(conversationId, decision.draft);
    return { routed: 'auto-sent', decision };
  }

  await requestApproval({
    draftId: randomUUID(),
    conversationId,
    clientName,
    question: text,
    decision,
  });
  return { routed: 'escalated', decision };
}
