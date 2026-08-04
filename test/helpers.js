// Utilità comuni ai test.
//
// REGOLA: nessun test deve poter toccare i file veri del bot (allowlist.json,
// knowledge/learned.json, data/bot.db). Non basta isolare i moduli che si
// stanno provando: basta che uno importi telegram.js, che a sua volta importa
// allowlist.js, per ritrovarsi collegato agli archivi veri. Per questo
// cartellaTemporanea() dirotta TUTTI e tre i percorsi in una cartella usa-e-
// getta, e va chiamata in cima a ogni file di test — anche in quelli che gli
// archivi non li usano.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

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
