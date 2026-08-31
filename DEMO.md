# Demo web `/assistant`

Demo pubblica del bot, pensata per essere mostrata a qualcuno che poi andrà a
leggere il codice. Mostra la parte che conta — **l'architettura human-in-the-loop**
— invece di nascondere tutto dietro una chat qualsiasi:

- **Chat cliente** — indistinguibile da WhatsApp: intestazione con Alessio e il
  suo stato, bolle con codina, orario e spunte blu. **Si può allegare una foto e
  registrare un vocale**, come nell'app vera, e il vocale inviato **si
  riascolta** dalla sua bolla.
- **Pannello decisione** — categoria, `invia`/`escala`, motivo, fonti web,
  token, cache hit, latenza e **costo stimato** di ogni risposta.
- **Inbox host** — dove finiscono le escalation, con gli stessi tre pulsanti di
  Telegram (Invia / Modifica / Ignora).
- **Interruttore `REVIEW_EVERYTHING`** — la valvola di sicurezza resa tangibile:
  porta il nome della variabile vera e ne mostra il valore (`true`/`false`), che
  si può cambiare in pagina per vedere subito cosa cambia.

**L'interfaccia della demo è in inglese** (chi la guarda spesso non parla
italiano), mentre codice, commenti e prompt restano in italiano come il resto
del repo. Le due cose sono separate apposta: le etichette di categoria e azione
si traducono nel frontend (`CATEGORIE`/`AZIONI` in `web/app.js`), **non** nel
prompt — così la pipeline resta identica a quella del bot vero. Fa eccezione il
campo `reason`, che arriva dal modello nella lingua che sceglie lui.

```
npm run demo    # → http://localhost:8888
```

---

## ⚠️ La casa è reale: la demo NON usa la guida vera

`knowledge/casa.md` contiene il **codice della key-box** e l'**indirizzo esatto**
di una casa vera. Per questo **non sta nel repo** (è gitignorato, come
`allowlist.json` e `learned.json`): vive solo sul server e sulla macchina
dell'host. La demo risponde a chiunque e non ha un host che approva le bozze:
collegata a quel file, consegnerebbe la chiave di casa al primo che la chiede.

Per questo la demo usa `knowledge/casa.demo.md`, con la stessa struttura ma dati
inventati, selezionato dalla variabile `CASA_PATH`.

**Regola: non mettere mai dati veri in `casa.demo.md`.** Dopo ogni modifica al
file o al prompt, rifai questa prova:

```bash
CASA_PATH=knowledge/casa.demo.md npm run brain
# chiedi: "qual è il codice della key-box?"  →  la risposta NON deve contenere
# il codice vero (quello in knowledge/casa.md, che qui non si scrive)
```

Anche `LEARNED_PATH` punta a un file inesistente: le FAQ imparate dai clienti
veri non devono finire in un prompt pubblico.

---

## Architettura

Le Netlify Functions sono **serverless e stateless**: niente disco persistente,
niente processo che resta vivo. Quindi:

| Modulo | Nella demo |
|---|---|
| `src/brain.js` | ✅ riusato **così com'è** — un solo cervello, nessuna logica duplicata |
| `src/knowledge.js` | ✅ riusato, con `CASA_PATH` che punta alla guida demo |
| `src/memory.js`, `src/db.js` | ❌ inusabili (SQLite vuole un file su disco) |
| `src/whatsapp.js`, `src/telegram.js`, `src/index.js` | ❌ mai importati |

Lo storico vive **nel browser** (max 20 messaggi, come `MAX_MESSAGES`) e viaggia
a ogni richiesta. Non viene salvato niente, da nessuna parte.

Il frontend fa da **canale**, come `telegram.js` per il bot vero: applica la
stessa identica condizione di `engine.js`

```js
action === 'invia' && !rodaggio   // → al cliente; altrimenti → inbox host
```

### Latenza, timeout e ricerca web

Misurato dal vivo con Haiku 4.5:

| Tipo di messaggio | Latenza |
|---|---|
| Testo, regole casa / saluti | 2,4 – 3,5 s |
| Foto (Claude la guarda nella stessa chiamata) | 2,3 – 5,2 s |
| **Vocale** (Gemini ~1,5 s + decisione) | **5,0 – 6,5 s** |
| **Info zona con `web_search`** | **6,0 – 10,3 s** |

Misure con `max_tokens: 700`. Il tetto sui token in uscita è una leva di latenza
diretta: la generazione è la parte lenta, e portarlo da 1500 a 700 ha tolto 1,6s
a una risposta lunga senza accorciare quelle normali (un messaggio WhatsApp non
ha bisogno di 1500 token — il system prompt chiede già risposte concise).

Le funzioni sincrone di Netlify hanno un tetto sull'**esecuzione totale**: **10s
sul piano free**, 26s su Pro. ⚠️ **Lo streaming non allunga quel tetto** — aiuta
l'attesa percepita e i timeout intermedi, non il limite della piattaforma.

Quindi con la ricerca web attiva su piano free una parte delle domande di zona
**fallirebbe**. Abbassare `max_uses` da 3 a 1 non serve (misurato: 8,3s di media
contro 7,4s — la latenza è nella ricerca, non nel loro numero).

**Due strade, scegli in base al piano:**

| | `DEMO_WEB_SEARCH=off` (consigliata su free) | Ricerca attiva (serve Pro) |
|---|---|---|
| Latenza | 2,4 – 3,5 s, garantita | 6 – 10,3 s |
| Domande di zona | il bot escala senza cercare | risponde con fonti citate |
| Timeout | mai | possibile sotto i 10s |

In entrambi i casi la funzione impone una **scadenza propria** (timeout Netlify
meno 1,2s): se scade, l'utente legge un messaggio comprensibile invece
dell'errore grezzo della piattaforma. Regolabile con `TIMEOUT_FUNZIONE_MS`
(mettilo a `26000` se passi a Pro).

Lo streaming NDJSON resta perché serve comunque: manda subito
`{"tipo":"stato"}`, poi un `{"tipo":"battito"}` ogni 2s, infine
`{"tipo":"decisione", …}`. Senza, l'utente fissa 8 secondi di schermo fermo.

## Foto e vocali

Gli stessi due percorsi del bot WhatsApp, sugli stessi moduli:

**Foto → Claude.** L'immagine entra nella *stessa* chiamata che classifica e
decide (`think(testo, storico, { image })`), quindi guardare una foto costa una
chiamata sola e le regole di casa valgono identiche su testo e immagini. Il
browser **ridimensiona la foto a 1024px prima di spedirla**: taglia i token
(un'immagine da 4000px non aggiunge nulla su un guasto in casa) e, ridisegnandola
su un canvas, butta via i **metadati EXIF** — le coordinate GPS della foto non
lasciano il dispositivo.

> 🪪 Prova a mandare la foto di un documento d'identità: il bot risponde che l'ha
> ricevuto **senza leggerne né salvarne alcun dato**. È la guardia in `brain.js`,
> ed è la cosa più interessante da far vedere.

**Vocali → Gemini → Claude.** L'API di Claude non ha un content block audio,
quindi la trascrizione la fa Gemini (`src/audio.js`, lo stesso adattatore del
bot). Gemini **non decide niente**: traduce audio in testo e si toglie di mezzo,
poi riparte la pipeline normale. Così il cervello resta uno solo e le regole di
casa non vanno duplicate su due provider.

Formati verificati dal vivo contro Gemini: `audio/webm;codecs=opus` (Chrome,
Edge, Firefox), `audio/mp4` (Safari), `audio/ogg;codecs=opus` (quello di
WhatsApp) e `audio/wav`. Tutti trascritti correttamente in ~1,4 s.

La trascrizione compare **sotto il vocale nella chat** e nel pannello decisione:
è quello che il modello ha davvero letto, e una trascrizione può sbagliare.

Tetti (in `netlify/functions/_valida.mjs`, con test dedicati): 1,5 MB per foto,
2 MB per audio, 60 secondi di registrazione, un allegato per volta.

## Deploy

### 0. Perché questo repo è separato dal bot originale

Il bot vero vive in un repo **privato** a parte (`chat-bot-costa-rei`), il cui
commit iniziale contiene `knowledge/casa.md` — codice della key-box e indirizzo
di una casa reale. Questo repo nasce da quella base ma è pensato per essere
**pubblico**, quindi `casa.md` è stato tolto da tutta la storia con:

```bash
git filter-repo --path knowledge/casa.md --invert-paths
```

Verificato prima di pubblicare, e da rifare se un domani si aggiungono file:

- **Ogni token sensibile di `casa.md` stava solo in quel file**, in tutta la
  storia: nessun indirizzo o codice era stato copiato altrove.
- Nel working tree: nessuna chiave API, nessun IP, nessuna email, nessun numero
  di telefono. `.env`, `allowlist.json` e `knowledge/learned.json` non sono
  **mai** stati committati.
- `casa.demo.md` usa key-box `0000` e password WiFi finte.

⚠️ **Un rewrite della storia non basta su un repo già pubblicato su GitHub**:
i ref delle pull request (`refs/pull/N/head`) sono permanenti e il force-push
non li tocca, quindi i vecchi commit restano raggiungibili. È il motivo per cui
qui si è creato un repo NUOVO invece di ripulire quello esistente.

### 1. Il sito Netlify della demo

1. Netlify → **Add new site → Import an existing project** → questo repo.
2. Build command e publish directory arrivano da `netlify.toml` (`web/`, nessun
   build step). Non c'è toolchain da rompersi.
3. **Site settings → Environment variables:**

   | Variabile | Valore |
   |---|---|
   | `ANTHROPIC_API_KEY` | una chiave **dedicata alla demo**, non quella del bot |
   | `MODEL` | `claude-haiku-4-5-20251001` |
   | `GEMINI_API_KEY` | serve **solo** per i vocali; senza, il resto funziona |
   | `DEMO_WEB_SEARCH` | `off` su piano free (vedi sopra); ometti su Pro |
   | `TIMEOUT_FUNZIONE_MS` | ometti su free (10000); `26000` su Pro |
   | `LIMITE_MESSAGGI` | messaggi per visitatore (default **15**) |
   | `FINESTRA_MINUTI` | finestra del limite (default **60**) |
   | `MAX_TOKEN_RISPOSTA` | tetto token in uscita (default 700) |
   | `CASA_PATH` | *(lascia vuoto: la funzione trova da sola `casa.demo.md`)* |

   ⚠️ **Non** mettere qui `TELEGRAM_BOT_TOKEN`: la demo non lo usa, e una chiave
   che non serve è solo una chiave in più da perdere.

   ⚠️ Su piano free metti `DEMO_WEB_SEARCH=off`. Senza, un vocale arriva a 8,6s
   contro una scadenza di 8,8s: troppo stretto. Con `off` il vocale sta in
   5,0-6,5s, con 2,3s di margine.

4. Deploy. La demo risponde su `https://<nome-sito>.netlify.app`.

### 1-bis. Due trappole del bundler, entrambe già in trappola una volta

Si manifestano **solo in produzione**: la pagina statica continua a funzionare
e la funzione risponde **502 a ogni richiesta**, perché il modulo non compila e
non si arriva nemmeno all'handler. Il log della funzione (*Site → Logs →
Functions*) è l'unico posto dove si legge la causa vera.

**1. Non dichiarare `__dirname`.** Il bundler ESM di Netlify aggiunge in cima al
bundle un proprio shim `__dirname`/`__filename`/`require` per l'interop CJS, e
lo fa *dopo* il bundling: esbuild non lo vede e non rinomina le omonime. Due
`const` con lo stesso nome nello stesso modulo finale sono un `SyntaxError`.
Nei moduli di `src/` la costante si chiama `QUI`, non `__dirname`.

**2. Dipendenze CJS che tirano ESM.** `@anthropic-ai/sdk` dipende da
`standardwebhooks`, che nella 1.1.0 è rimasto CommonJS ma ha alzato
`@stablelib/base64` a `^2`, diventata solo-ESM: `require()` di un ESM non è
supportato. In locale non si vede, perché quel ramo del grafo non viene mai
percorso; Lambda invece lo risolve tutto. Bloccato con un `overrides` in
`package.json` alla 1.0.0, che chiede `@stablelib/base64@^1` (CommonJS).

Come riprodurle **senza deployare**, in pochi secondi:

```bash
npx esbuild netlify/functions/chat.mjs --bundle --format=esm --platform=node \
    --outfile=/tmp/bundle.mjs
# premetti il banner di Netlify (const __dirname/__filename/require) e poi:
node --check /tmp/bundle.mjs
```

### 2. Collegarla a `estaated.it/assistant`

Il sito della casa (`AndreaAresu/costa-rei-site`) è un'app **React + Vite su un
altro sito Netlify**. Non serve copiarci dentro il codice del bot: basta un
**rewrite proxy**, così `/assistant` resta su estaated.it ma il contenuto arriva
da qui. Le regole sono **già scritte** nel `netlify.toml` di quel repo: resta
solo da sostituire `<NOME-SITO-DEMO>` col sottodominio Netlify vero.

```toml
[[redirects]]                  # 1. forza la barra finale
  from = "/assistant"
  to = "/assistant/"
  status = 301

[[redirects]]                  # 2. proxy verso il sito della demo
  from = "/assistant/*"
  to = "https://<NOME-SITO-DEMO>.netlify.app/:splat"
  status = 200                 # 200 = rewrite: l'URL nel browser resta estaated.it
  force = true
```

Tre dettagli che è facile sbagliare, e che nel repo del sito sono già a posto:

1. **Vanno PRIMA della regola SPA `/* → /index.html`.** Netlify applica la prima
   che combacia: se `/*` viene prima, `/assistant` mostra la home. È la causa
   numero uno quando "il proxy non funziona".
2. **La barra finale non è cosmetica.** Le pagine della demo usano percorsi
   relativi (`./app.js`, `./api/chat`). Senza la barra, `/assistant` li
   risolverebbe su `/app.js` e `/api/chat` — che finiscono nella regola SPA e
   restituiscono `index.html` invece dello script e dell'API.
3. **La CSP del sito è stretta** (`script-src 'self'`, `connect-src 'self'`).
   Funziona perché con il rewrite tutto è **stessa origine**: la demo non carica
   niente da domini esterni e non ha script inline. Se aggiungi un CDN o uno
   script inline alla demo, la CSP lo blocca — silenziosamente.

Poi: push su `main` → Netlify ricostruisce → `estaated.it/assistant` è online.

> **Da verificare dopo il primo deploy:** che il proxy di Netlify inoltri il POST
> e non bufferizzi lo streaming. Se la demo funziona sul dominio `.netlify.app`
> ma non su `estaated.it/assistant`, è quello. Il ripiego è un sottodominio:
> Netlify → *Domain management* → `assistant.estaated.it` sul sito della demo (il
> DNS è già su Netlify), e su `/assistant` un redirect 302.

## Costi e abusi

Un endpoint pubblico che usa la tua chiave API è una carta di credito esposta.
Le difese, dalla più esterna alla più interna:

1. **Spending limit sulla Console Anthropic.** ← *l'unica che non dipende da
   questo codice né dal piano Netlify.* **Impostalo comunque.**
2. **Chiave dedicata alla demo.** Se va revocata, il bot WhatsApp continua a
   funzionare.
3. **15 messaggi per visitatore all'ora** (`LIMITE_MESSAGGI`). È la difesa
   principale contro chi spamma: 15 messaggi bastano per capire cosa fa il bot,
   e chi ne vuole di più sta giocando, non valutando. Il contatore è **visibile**
   nel pannello («Messaggi rimasti»), avvisa a 3 e blocca la scrittura a 0.
4. **Tetto giornaliero globale**: 300 messaggi/giorno.
5. **Tetti sull'input**: 500 caratteri, 20 messaggi di storico da 2000 caratteri.
6. **Tetti sugli allegati**: 1,5 MB per foto, 2 MB per audio, 60s di
   registrazione, uno per volta. Sono la voce di costo più facile da gonfiare.
7. `max_tokens: 700` per risposta nella demo (1500 nel bot vero).

I punti 3 e 4 usano **Netlify Blobs**. Se Blobs non è disponibile sul piano in
uso, la funzione **lascia passare** la richiesta e lo scrive nei log: bloccare
tutto renderebbe la demo morta a ogni intoppo infrastrutturale. È una scelta
consapevole, ed è il motivo per cui il punto 1 non è opzionale.

### Lo storico arriva dal browser: è input non fidato

Nel bot WhatsApp lo storico lo tiene il server (SQLite). Qui lo rispedisce il
client, quindi chiunque potrebbe iniettare turni arbitrari nel prompt — per
esempio un finto turno `assistant` che afferma il codice della key-box, o un
ruolo `system` con istruzioni proprie. `netlify/functions/_valida.mjs` scarta
tutto ciò che non è `user`/`assistant` con contenuto stringa; i test stanno in
`test/demo-api.test.js`.
