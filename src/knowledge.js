import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLearned, isExpired } from './learned.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASA_PATH = join(__dirname, '..', 'knowledge', 'casa.md');

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
