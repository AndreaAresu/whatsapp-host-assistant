import readline from 'node:readline';
import { createControlBot } from './telegram.js';
import { handleClientMessage } from './engine.js';
import { config } from './config.js';

if (!config.telegramToken) {
  console.error('⚠️  TELEGRAM_BOT_TOKEN non impostato nel .env. Crea un bot con @BotFather.');
  process.exit(1);
}

// Per ora "inviare al cliente" è simulato: WhatsApp (Baileys) arriva nel prossimo step.
async function sendToClient(conversationId, text) {
  console.log(`\n📤 [WhatsApp simulato] → ${conversationId}:\n${text}\n`);
}

const { bot, requestApproval } = createControlBot({
  onApprove: async (item, finalText) => {
    await sendToClient(item.conversationId, finalText);
  },
});

await bot.init();
bot.start(); // long polling in background
console.log(`🤖 Bot Telegram avviato come @${bot.botInfo.username}.`);
if (!config.telegramChatId) {
  console.log(
    'ℹ️  Scrivi /start al bot su Telegram per ottenere il tuo chat id, poi mettilo in .env e riavvia.'
  );
}
console.log('Simula un messaggio di un cliente qui sotto; le bozze arriveranno su Telegram.\n');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask() {
  rl.question('Cliente (simulato)> ', async (text) => {
    if (!text.trim()) return ask();
    try {
      const { routed, decision } = await handleClientMessage({
        conversationId: 'cliente-di-prova',
        clientName: 'Cliente di prova',
        text,
        sendToClient,
        requestApproval,
      });
      if (routed === 'auto-sent') {
        console.log(`(risposta automatica inviata · categoria: ${decision.category})\n`);
      } else {
        console.log(
          `(bozza inviata su Telegram · categoria: ${decision.category} · ${decision.action})\n`
        );
      }
    } catch (err) {
      console.error('Errore:', err.message);
    }
    ask();
  });
}

ask();
