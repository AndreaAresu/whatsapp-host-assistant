import 'dotenv/config';

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL || 'claude-haiku-4-5-20251001',
  // Modalità rodaggio: se true, anche le risposte "sicure" passano da te come bozza.
  reviewEverything: process.env.REVIEW_EVERYTHING !== 'false',
  // Bot Telegram di controllo (per approvare le bozze).
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  // Trascrizione dei vocali (Google Gemini). Claude non accetta audio in
  // ingresso: senza questa chiave i vocali restano una semplice notifica.
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
};

if (!config.anthropicApiKey) {
  console.warn(
    '⚠️  ANTHROPIC_API_KEY non impostata. Crea un file .env partendo da .env.example.'
  );
}
