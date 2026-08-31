import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLearned, isExpired } from './learned.js';

// NB: la costante NON si chiama `__dirname`. Il bundler ESM di Netlify
// aggiunge un proprio shim con quel nome DOPO il bundling, quindi esbuild non
// sa di doverlo rinominare: due dichiarazioni omonime nello stesso modulo
// finale sono un SyntaxError, e la funzione non carica affatto (502).
const QUI = dirname(fileURLToPath(import.meta.url));
// Come per ALLOWLIST_PATH / LEARNED_PATH / BOT_DB_PATH, la variabile d'ambiente
// serve a puntare altrove senza toccare il codice. Qui il caso d'uso è la DEMO
// WEB PUBBLICA, che deve usare `casa.demo.md`: la guida vera contiene il codice
// della key-box e l'indirizzo esatto di una casa reale, e la demo risponde a
// chiunque senza un host che approvi le bozze.
// In produzione (bot WhatsApp) resta il file accanto al codice.
const CASA_PATH =
  process.env.CASA_PATH || join(QUI, '..', 'knowledge', 'casa.md');

/**
 * Carica la base di conoscenza: la guida casa (statica) + le FAQ imparate
 * (risposte già approvate dall'host). Restituisce un testo unico, pensato per
 * essere messo nel system prompt con prompt caching.
 */
export function loadKnowledge() {
  const casa = readFileSync(CASA_PATH, 'utf8');
  const learned = loadLearned();

  const learnedText = learned.length
    ? learned
        .map((f) => {
          const stato = isExpired(f) ? ' — ⚠️ SCADUTA (da riverificare, non fidarti)' : '';
          return `- [${f.categoria}] D: ${f.domanda}\n  R: ${f.risposta} (approvata il ${f.data})${stato}`;
        })
        .join('\n')
    : '(nessuna FAQ imparata finora)';

  const text =
    `# GUIDA CASA\n${casa}\n\n` +
    `# FAQ IMPARATE (risposte già approvate dall'host, riutilizzabili)\n${learnedText}`;

  return { casa, learned, text };
}
