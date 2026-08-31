// Server di sviluppo della demo web: serve `web/` e instrada /api/chat alla
// stessa funzione che gira su Netlify.
//
// Esiste per non dover installare la CLI di Netlify solo per dare un'occhiata.
// Non è il server di produzione: in produzione il frontend lo serve la CDN di
// Netlify e la funzione gira su Lambda. Qui gira tutto in un processo solo.
//
//   npm run demo   →   http://localhost:8888
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(RADICE, 'web');
const PORTA = Number(process.env.PORT) || 8888;

process.chdir(RADICE); // la funzione cerca knowledge/casa.demo.md da qui

const { default: chat } = await import('../netlify/functions/chat.mjs');

const TIPI = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const srv = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);

  // --- API: passa alla funzione Netlify ---
  if (url.pathname === '/api/chat') {
    const corpo = req.method === 'POST' ? await leggiCorpo(req) : undefined;
    const richiesta = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: corpo,
    });

    let risposta;
    try {
      risposta = await chat(richiesta, { ip: req.socket.remoteAddress ?? '127.0.0.1' });
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errore: 'Errore interno: ' + err.message }));
    }

    res.writeHead(risposta.status, Object.fromEntries(risposta.headers));
    if (!risposta.body) return res.end();
    // Inoltra lo stream così com'è: è il punto da verificare (i battiti devono
    // arrivare mentre il modello sta ancora pensando, non tutti alla fine).
    const reader = risposta.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  }

  // --- File statici ---
  const richiesto = url.pathname === '/' ? '/index.html' : url.pathname;
  const percorso = join(WEB, normalize(richiesto).replace(/^(\.\.[/\\])+/, ''));
  if (!percorso.startsWith(WEB) || !existsSync(percorso)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Non trovato');
  }
  res.writeHead(200, {
    'content-type': TIPI[extname(percorso)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(await readFile(percorso));
});


srv.on('error', (err) => {
  // Senza questo il messaggio è uno stack trace di node:net, e la trappola è
  // sottile: un server vecchio rimasto vivo continua a rispondere con il CODICE
  // VECCHIO, quindi sembra che le modifiche non abbiano effetto.
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ La porta ${PORTA} è già occupata da un altro server.`);
    console.error('   Probabilmente è una demo rimasta aperta: chiudila con');
    console.error(`   pkill -f dev-demo.mjs   (oppure usa PORT=8889 npm run demo)\n`);
    process.exit(1);
  }
  throw err;
});

srv.listen(PORTA, () => {
  console.log(`\n🏖️  Demo assistente Costa Rei`);
  console.log(`    → http://localhost:${PORTA}\n`);
  console.log('    Base di conoscenza: knowledge/casa.demo.md (dati fittizi)');
  console.log('    Rate limiting: disattivo in locale (serve Netlify Blobs)\n');
});

function leggiCorpo(req) {
  return new Promise((risolvi, rifiuta) => {
    const pezzi = [];
    req.on('data', (c) => pezzi.push(c));
    req.on('end', () => risolvi(Buffer.concat(pezzi)));
    req.on('error', rifiuta);
  });
}
