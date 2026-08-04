import readline from 'node:readline';
import { think } from './brain.js';
import { config } from './config.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('🏖️  Cervello bot Costa Rei — prova locale');
console.log(
  `Modello: ${config.model} · Rodaggio (rivedi tutto): ${config.reviewEverything ? 'ON' : 'OFF'}`
);
console.log('Scrivi un messaggio come se fossi un cliente. Ctrl+C per uscire.\n');

function ask() {
  rl.question('Cliente> ', async (msg) => {
    if (!msg.trim()) return ask();
    try {
      const d = await think(msg);
      // Cosa farebbe davvero l'app, tenendo conto della modalità rodaggio:
      const goesToClient = d.action === 'invia' && !config.reviewEverything;
      const finalAction = goesToClient ? 'INVIA → al cliente' : 'BOZZA → all\'host';

      console.log('\n──────────────────────────────────────');
      console.log(`Categoria : ${d.category}`);
      console.log(`Decisione : ${d.action}  →  ${finalAction}`);
      console.log(`Lingua    : ${d.language}`);
      console.log(`Motivo    : ${d.reason}`);
      console.log('\nBozza di risposta:');
      console.log(d.draft);
      if (d.sources && d.sources.length) {
        console.log('\nFonti web:');
        for (const s of d.sources) console.log(`  - ${s.title} — ${s.url}`);
      }
      console.log('──────────────────────────────────────\n');
    } catch (err) {
      console.error('Errore:', err.message);
    }
    ask();
  });
}

ask();
