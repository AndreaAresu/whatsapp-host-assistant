// Utilità comuni ai test.
//
// REGOLA: nessun test deve poter toccare i file veri del bot (allowlist.json,
// knowledge/learned.json, data/bot.db, knowledge/casa.md). Non basta isolare i
// moduli che si stanno provando: basta che uno importi telegram.js, che a sua
// volta importa allowlist.js, per ritrovarsi collegato agli archivi veri. Per
// questo cartellaTemporanea() dirotta TUTTI i percorsi in una cartella usa-e-
// getta, e va chiamata in cima a ogni file di test — anche in quelli che gli
// archivi non li usano.
//
// La guida casa segue la stessa regola per un motivo in più: `knowledge/casa.md`
// è un file di runtime (contiene indirizzo e codice della key-box di una casa
// vera), quindi NON sta nel repo. Un test che lo legge passa solo sulla macchina
// di chi ce l'ha — o, peggio, solo perché un `.env` locale dirotta CASA_PATH
// sulla guida demo. Qui la guida è una finta, scritta nella cartella usa-e-getta.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

/**
 * Guida casa finta. Volutamente minima: ai test serve solo qualcosa di
 * riconoscibile dentro il prompt, non una copia della guida vera.
 */
export const GUIDA_FINTA = `## Informazioni essenziali
- **WiFi** — nome rete: «RETE-DI-PROVA» · password: «prova12345»
- **Check-in** — dalle 16:00 · **Check-out** — entro le 10:00
- **Indirizzo** — DA COMPLETARE
`;

/**
 * Crea una cartella temporanea, ci punta gli archivi del bot e la cancella
 * alla fine del file di test. Va chiamata PRIMA di importare qualunque modulo
 * di src/, perché i percorsi vengono letti una volta sola al caricamento.
 */
export function cartellaTemporanea(nome) {
  const dir = mkdtempSync(join(tmpdir(), `costa-rei-${nome}-`));

  process.env.ALLOWLIST_PATH = join(dir, 'allowlist.json');
  process.env.LEARNED_PATH = join(dir, 'learned.json');
  process.env.BOT_DB_PATH = join(dir, 'bot.db');

  const casa = join(dir, 'casa.md');
  writeFileSync(casa, GUIDA_FINTA);
  process.env.CASA_PATH = casa;

  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Silenzia console.error per i test che si aspettano un errore stampato. */
export function silenziaErrori(t) {
  t.mock.method(console, 'error', () => {});
}

/** Silenzia console.log (alcuni percorsi loggano volutamente). */
export function silenziaLog(t) {
  t.mock.method(console, 'log', () => {});
}
