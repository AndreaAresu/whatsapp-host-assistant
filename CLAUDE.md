# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Il codice, i commenti e la documentazione di questo repo sono in italiano:
> mantieni la stessa lingua nelle modifiche. **Due eccezioni**, entrambe rivolte
> a chi arriva da fuori e spesso non parla italiano: il `README.md` e
> l'interfaccia della demo web.

## Comandi

```bash
npm install
npm start        # app completa: WhatsApp (Baileys) + bot di controllo Telegram
npm test         # suite automatica (node:test), offline e senza costi
npm run brain    # REPL locale: solo il "cervello" (think), nessun canale reale
npm run telegram # REPL + Telegram reale, invio al cliente simulato (stdout)
npm run demo     # demo web su http://localhost:8888 (vedi DEMO.md)
```

`npm test` usa il runner integrato di Node (nessuna dipendenza in più) e gira
in meno di un secondo. Serve il flag `--experimental-test-module-mocks`, già
nello script: senza, `mock.module()` non è disponibile.

Non c'è linter. Per provare il **comportamento del modello** (prompt, tono,
qualità delle bozze) restano i due REPL (`src/test-cli.js`,
`src/test-telegram.js`): i test coprono la pipeline attorno a Claude, non le
sue risposte, che richiedono chiamate vere.

Il deploy avviene via `rsync` verso il VPS (vedi `DEPLOY.md`), dove gira come
servizio systemd `costa-rei-bot`.

## Architettura

Bot WhatsApp per una casa vacanze a Costa Rei, con **human-in-the-loop**: le
risposte "sicure" partono da sole, tutto il resto arriva all'host come bozza su
Telegram da approvare/modificare/ignorare.

Flusso di un messaggio (`src/index.js` è l'unico punto in cui i pezzi si
incontrano; tutto il resto è disaccoppiato):

```
                       ┌─ testo ──────────────────────┐
WhatsApp (whatsapp.js) ├─ foto ────→ (byte in allegato)├→ allowlist → memory → engine → brain (Claude)
                       └─ vocale ──→ audio.js (Gemini) ┘                                    ↓
                                       trascrizione → testo                                 ↓
                            invia al cliente  ←──  o  ──→  telegram.js (bozza all'host)
                                                                  ↓ approvazione
                                                        learned.js (FAQ) ──→ knowledge.js
```

**Un solo cervello, due provider.** Claude decide sempre. Gemini (`audio.js`)
non decide nulla: è un adattatore stretto audio→testo, necessario solo perché
l'API di Claude **non ha un content block audio** (solo `text`, `image`,
`document`). Le foto invece vanno direttamente a Claude nella stessa chiamata
`think()`, così classificazione, escalation, base di conoscenza e FAQ imparate
funzionano identiche su testo e immagini. Non spostare la decisione su Gemini:
significherebbe duplicare le regole di casa su due provider.

- **`engine.js`** è volutamente agnostico dal canale: riceve `sendToClient` e
  `requestApproval` come callback. È ciò che permette a `test-telegram.js` di
  usare la stessa pipeline con un invio finto.
- **`brain.js`** fa una sola chiamata "agentica" a Claude con due tool:
  `web_search` nativo (geolocalizzato su Costa Rei, per le info di zona) e
  `submit_response`, con cui il modello consegna la decisione strutturata
  (`category`, `action` invia/escala, `language`, `draft`, `reason`). Il loop
  gestisce `pause_turn`. **Se il modello non chiama `submit_response`, si
  escala per sicurezza** — questo fallback va preservato. La base di conoscenza
  è un blocco di system prompt separato con `cache_control: ephemeral`.
- **La decisione di inviare** è `action === 'invia' && !config.reviewEverything`.
  `REVIEW_EVERYTHING` (default `true`, "modalità rodaggio") forza ogni risposta
  a passare dall'host: è la valvola di sicurezza principale.

### Invarianti da non rompere

- **Allowlist prima di Claude**: un numero non in `allowlist.json` non deve mai
  generare una chiamata all'API (costo). `index.js` notifica l'host e basta.
  Il filtro vale anche per `onHostReply`, così una risposta a un amico non
  finisce nelle FAQ.
- **Nessun salvataggio automatico nelle FAQ**: `addLearned` si invoca solo dopo
  che l'host ha toccato "Salva" su Telegram. Solo le categorie in `LEARNABLE`
  (`info_zona`, `regole_casa`) sono candidabili.
- **Il bot Telegram è privato**: un middleware in `telegram.js` scarta in
  silenzio ogni update che non venga da `TELEGRAM_CHAT_ID` (i comandi `/lista`
  esporrebbero i numeri dei clienti). **Unica eccezione**: finché
  `TELEGRAM_CHAT_ID` non è configurato passa il solo `/start`, che è l'unico
  modo per scoprire quel valore — senza, la configurazione iniziale sarebbe
  impossibile. Non allargare l'eccezione ad altri comandi. Nota: `OWNER_ID` è
  `null`, mai `String(undefined)`, che darebbe la stringa `"undefined"` e
  bloccherebbe anche l'host.
- **Gli archivi JSON si scrivono solo via `storage.js`**: `writeJsonAtomic`
  (tmp + fsync + rename) e `readJsonArray`. Mai `writeFileSync` diretto su
  `learned.json` o `allowlist.json`: non è atomica e un riavvio a metà scrittura
  li tronca. `readJsonArray` mette in quarantena i file illeggibili
  (`.corrotto-<ts>`) invece di ignorarli — ignorandoli, la prima scrittura
  successiva li sovrascriverebbe distruggendo dati recuperabili. I percorsi si
  possono sovrascrivere con `ALLOWLIST_PATH`, `LEARNED_PATH` e `BOT_DB_PATH`:
  **serve solo ai test**, in produzione restano i file accanto al codice.
- **Gli errori tecnici non devono restare silenziosi**: se la pipeline fallisce
  (rate limit, overload), `index.js` avvisa l'host via Telegram invece di
  propagare, così può rispondere a mano. Le eccezioni di `notifyHost` e degli
  alert sono a loro volta inghiottite (`safeAlert`).
- **Il bot ignora gruppi e status** e non manda mai messaggi a freddo: risponde
  solo a chi scrive per primo. Dei media gestisce solo foto e vocali; video,
  sticker, documenti-file, contatti e posizioni restano una notifica all'host.
- **I documenti d'identità non vengono mai letti**: il system prompt di
  `brain.js` impone categoria `documento_identita` con divieto esplicito di
  trascrivere, descrivere o riassumere qualsiasi dato del documento (nome,
  numeri, date, volto). `index.js` si limita al promemoria alloggiatiweb. Questa
  guardia è una scelta esplicita dell'utente su dati personali di terzi — non
  rimuoverla né allentarla senza chiederglielo.
- **I byte dei media non entrano mai in SQLite**: nello storico va un segnaposto
  (`[il cliente ha inviato una foto]`). Salvare il base64 gonfierebbe il DB e lo
  rispedirebbe a ogni turno successivo.
- **`download()` di `onMedia` è pigro apposta**: va invocato solo dopo il
  controllo allowlist, così i media degli sconosciuti non vengono mai scaricati.
- **Il media ha la precedenza sul testo** in `classificaMessaggio()`
  (`whatsapp.js`). Non invertire: `extractText()` restituisce anche la
  *didascalia* di una foto, quindi instradare prima sul testo faceva finire le
  foto con didascalia sul ramo testo — `download()` non partiva e l'immagine non
  arrivava mai a Claude. La didascalia viaggia come `text` dentro `onMedia` e
  diventa il testo del turno multimodale. Coperto dai test marcati
  `REGRESSIONE:` in `whatsapp.test.js`.
- **La demo web non deve MAI leggere `knowledge/casa.md`**: contiene il codice
  della key-box e l'indirizzo di una casa vera, e la demo risponde a chiunque
  senza un host che approvi le bozze. `CASA_PATH` la dirotta su
  `casa.demo.md`, e `LEARNED_PATH` su un file inesistente. Vedi `DEMO.md`.

### Dettagli non ovvi

- **Baileys 7 usa i LID**: `msg.key.remoteJid` può essere `@lid` invece del
  numero. `resolvePhoneNumber()` in `whatsapp.js` risolve il numero vero via
  `signalRepository.lidMapping`; l'allowlist ragiona su numeri (sole cifre),
  non su JID.
- **Distinguere bot vs host**: i messaggi `fromMe` possono essere del bot o
  scritti a mano dall'host dal telefono. Si filtrano per id del messaggio
  inviato (`botSentIds`) più una rete di sicurezza per testo+timestamp a 60s;
  quelli che restano diventano `onHostReply` e alimentano l'apprendimento.
- **Memoria conversazioni**: SQLite (`data/bot.db`, WAL), finestra a scorrimento
  — 6h di silenzio azzerano la chat, si tengono gli ultimi 20 messaggi.
  `normalizeMessages()` in `brain.js` fonde i turni consecutivi dello stesso
  ruolo, perché i clienti mandano più messaggi di fila e l'API richiede
  l'alternanza.
- **Il prefisso del prompt deve restare sopra i 4096 token.** È la soglia
  minima di caching di **Haiku 4.5** (dipende dal modello: 512 su Opus 5, 1024
  su Sonnet 5, 4096 su Haiku 4.5 e Opus 4.6). Sotto, `cache_control` viene
  ignorato **in silenzio**: nessun errore, solo `cache_creation_input_tokens: 0`
  e il costo pieno a ogni messaggio. Con `casa.demo.md` il prefisso sta a ~5200
  token; accorciando la guida si scende sotto e il caching sparisce senza che
  niente lo segnali. Si verifica con `usage.cache_read_input_tokens` su due
  chiamate identiche di fila.
- **Nel prompt non si scrivono trattini lunghi**, né in `brain.js` né in
  `casa.md`/`casa.demo.md`. Il modello imita la punteggiatura di ciò che legge,
  e la guida è la parte più lunga del suo contesto: con 15 trattini lunghi nel
  prompt li usava nelle risposte nonostante un divieto esplicito. La regola sta
  in positivo («virgola, due punti o parentesi») più quattro esempi in
  `<esempi>`, come raccomanda la documentazione di Anthropic: *tell Claude what
  to do instead of what not to do* e *match your prompt style to the desired
  output*. Il divieto da solo non funzionava.
- **Le FAQ di zona scadono** dopo 90 giorni (`EXPIRY_DAYS` in `learned.js`):
  `knowledge.js` le marca «SCADUTA» nel prompt e il system prompt istruisce il
  modello a non fidarsene.
- **`knowledge/casa.md`** è la fonte canonica delle risposte, ma è un file di
  runtime **fuori dal repo** (indirizzo e codice della key-box veri): nel repo
  c'è solo `casa.demo.md`. Le voci «DA COMPLETARE» sono intenzionali: il prompt
  le tratta come "non lo so". Per lo stesso motivo **nessun test lo legge**:
  `cartellaTemporanea()` scrive una guida finta e ci punta `CASA_PATH`.
- **Nessun modulo di `src/` dichiara `__dirname`**: la costante si chiama `QUI`.
  Il bundler ESM di Netlify ne inietta uno suo *dopo* il bundling, quindi
  esbuild non rinomina le omonime e il modulo finale non compila — la funzione
  della demo dà 502 a ogni richiesta senza arrivare all'handler. Vale per
  qualunque modulo che possa finire nel bundle della demo. Vedi `DEMO.md`.
- **La versione del tool `web_search` è legata al modello.** `web_search_20250305`
  è la variante giusta per Haiku 4.5; `web_search_20260209` (filtro dinamico)
  richiede Opus 4.6+ / Sonnet 4.6+. Se cambi `MODEL`, ricontrolla `brain.js`.
- **`think()` accumula `usage` su tutte le chiamate** del ciclo `pause_turn`, non
  solo l'ultima: una ricerca web può costare due chiamate API per un messaggio.
  Restituisce anche `steps` (quante chiamate sono servite).
- **I vocali WhatsApp sono Opus in container Ogg**, mentre Gemini documenta
  "OGG Vorbis". In pratica l'invio diretto funziona; `audio.js` prova prima così
  e solo se l'API rifiuta transcodifica in WAV con `ffmpeg` (opzionale: se manca,
  propaga l'errore e l'host riceve la notifica). Il `; codecs=opus` va tolto dal
  MIME prima dell'invio.
- **Ogni percorso media degrada, mai fallisce**: chiave assente, download fallito,
  audio incomprensibile o formato non supportato finiscono tutti nella notifica
  all'host — cioè il comportamento che il bot aveva prima di questa funzione.

### I test (`test/`, `npm test`)

Un file per modulo, in italiano come il resto. Coprono la pipeline attorno a
Claude: instradamento invia/escala, lettura dei messaggi Baileys, archivi JSON,
memoria SQLite, bot Telegram (per intero, via `bot.handleUpdate()` con le API
intercettate da un transformer di grammy). Le API esterne sono **sempre finte**
(`mock.module` su `@anthropic-ai/sdk` e `@google/genai`): la suite non fa
chiamate di rete e non costa niente.

Due regole da non rompere:

- **Nessun test tocca i file veri.** `test/helpers.js` → `cartellaTemporanea()`
  dirotta `ALLOWLIST_PATH`, `LEARNED_PATH`, `BOT_DB_PATH` e `CASA_PATH` in una
  cartella usa-e-getta, e va chiamata in cima a **ogni** file di test, anche in
  quelli che gli archivi non li usano: basta importare `telegram.js`, che
  importa `allowlist.js`, per ritrovarsi collegati alla lista vera dell'host.
  Deve reggere anche col codice rotto, non solo col codice giusto. `CASA_PATH`
  è nell'elenco per un motivo in più: senza, i test passavano solo grazie al
  `.env` dello sviluppatore, che lo dirotta su `casa.demo.md`.
- **Le variabili d'ambiente vanno impostate prima degli `import` da `src/`**,
  con `await import()` dinamico: i percorsi degli archivi vengono letti una
  volta sola al caricamento del modulo.

I test più importanti sono quelli marcati `SICUREZZA:` in `brain.test.js` (se
il modello non chiama `submit_response` si escala) e quelli sulla privacy in
`telegram*.test.js`: prima di toccarli, rileggi le invarianti qui sopra.

### La demo web (`web/`, `netlify/`)

Terzo canale dopo il CLI e Telegram, sullo stesso `brain.js`. Documentata in
`DEMO.md`.

**L'interfaccia della demo è in inglese**, mentre codice, commenti, prompt e
`casa.demo.md` restano in italiano: chi guarda la demo spesso non parla
italiano, chi legge il codice sì. Le etichette di `category` e `action` si
traducono nel frontend (`CATEGORIE`/`AZIONI` in `web/app.js`) e **mai nel
prompt**: gli enum che il modello consegna restano quelli del bot vero.

**Il pannello chat imita WhatsApp di proposito** (intestazione con Alessio e
stato, sfondo a doodle, bolle con codina, orario e spunte blu): la demo deve
dare la sensazione di scrivere all'host, non di usare un chatbot in una pagina.
Marchio e logo di WhatsApp non sono usati, solo il linguaggio visivo. Gli avvisi
di sistema stanno nei *chip* centrati che WhatsApp usa già, così restano in tema
senza nascondere che le risposte sono generate da un'IA. Quando una risposta va
in escalation la chat **resta in silenzio**, come accadrebbe davvero: è l'inbox
host a mostrare cosa sta succedendo. Non aggiungere in chat messaggi tipo
«bozza inviata all'host»: romperebbero l'illusione e sono già nel pannello.

**Foto e vocali passano per gli stessi moduli del bot**, non per copie: la foto
entra in `think(..., { image })`, il vocale in `transcribeAudio()` di `audio.js`
e poi rientra come testo. Il browser ridimensiona la foto a 1024px prima di
spedirla — taglia i token e, ridisegnandola su canvas, elimina l'EXIF (niente
coordinate GPS in uscita). I tetti sugli allegati stanno in `_valida.mjs`: sono
la voce di costo più facile da gonfiare dall'esterno.

**`think()` accetta `maxTokens`** (default 1500, la demo usa 700). È una leva di
LATENZA prima che di costo: la generazione domina il tempo di risposta, e sui
vocali il budget è già ridotto di ~1,5s dalla trascrizione.

Due vincoli tecnici che ne spiegano la forma:

- **Serverless = stateless.** Niente SQLite, niente FAQ imparate: lo storico
  vive nel browser e viaggia a ogni richiesta. Per questo è **input non fidato**
  e passa da `netlify/functions/_valida.mjs`, che scarta tutto ciò che non è
  `user`/`assistant` con contenuto stringa (un ruolo `system` iniettato dal
  client avrebbe autorità di istruzione di sistema).
- **Timeout Netlify: 10s di ESECUZIONE TOTALE sul free** (26s su Pro), e lo
  streaming **non** lo allunga. Misurato: 2,4-3,5s senza ricerca web, 6-10,3s
  con. Abbassare `max_uses` non aiuta (la latenza è nella ricerca, non nel loro
  numero), quindi su free si usa `DEMO_WEB_SEARCH=off` → `maxWebSearches: 0`,
  che toglie del tutto lo strumento. La funzione impone comunque una scadenza
  propria (timeout meno 1,2s) per degradare con un messaggio leggibile invece
  dell'errore grezzo della piattaforma. Lo streaming NDJSON resta per l'attesa
  percepita: 8 secondi di schermo fermo sembrano un guasto.

**Sul telefono l'altezza non si calcola per sottrazione.** Il layout a colonna
sola (≤1040px) dà a `body` un'altezza **definita** (`height: 100dvh`, non
`min-height`) e lascia che sia il riquadro a prendersi lo spazio che avanza. Con
un `min-height` il contenitore si dimensiona sul contenuto e i figli non si
stringono mai; con `100vh` iOS Safari usa la viewport a barre nascoste. In
entrambi i casi il fondo del pannello — cioè la barra di scrittura **col tasto
di invio** — finisce sotto il bordo dello schermo. Vale anche `min-height: 0`
sul riquadro: il minimo da desktop (480px) su uno schermo corto rifà lo stesso
danno.

**I vocali richiedono un contesto sicuro.** `navigator.mediaDevices` non esiste
fuori da https/localhost: aprendo `npm run demo` dal telefono su
`http://<ip-locale>:8888` la registrazione non parte, e non è colpa del browser
(iOS Safari registra da 14.3, in `audio/mp4`, già ammesso da `MIME_AUDIO`).
`avviaRegistrazione()` distingue i due casi nel messaggio: non unificarli.

**I percorsi nel frontend sono relativi** (`./app.js`, `./api/chat`) e devono
restarlo: in produzione la pagina vive sotto `estaated.it/assistant/` grazie a un
rewrite proxy, e un percorso assoluto finirebbe nella regola SPA del sito
restituendo `index.html`. Per lo stesso motivo il sito forza la barra finale su
`/assistant`.

Al posto dell'allowlist (che qui non esiste) c'è un tetto di **15 messaggi per
visitatore all'ora** più un tetto giornaliero globale, su Netlify Blobs. Il
contatore è visibile nel pannello: un limite che scatta a sorpresa sembra un
guasto. Se Blobs manca, la funzione lascia
passare e lo logga: la difesa vera contro la spesa è lo **spending limit sulla
Console Anthropic**.

### File di stato a runtime (tutti gitignorati)

`data/bot.db` (conversazioni) · `knowledge/learned.json` (FAQ imparate) ·
`allowlist.json` (numeri autorizzati) · `knowledge/casa.md` (guida vera) ·
`auth_info/` (sessione WhatsApp) · `.env`. Sono anche l'elenco esatto da
includere nei backup del server.
