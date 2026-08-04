# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> Il codice, i commenti e la documentazione di questo repo sono in italiano: mantieni la stessa lingua nelle modifiche.

## Comandi

```bash
npm install
npm start        # app completa: WhatsApp (Baileys) + bot di controllo Telegram
npm run brain    # REPL locale: solo il "cervello" (think), nessun canale reale
npm run telegram # REPL + Telegram reale, invio al cliente simulato (stdout)
```

Non ci sono test automatici né linter: la verifica si fa con i due REPL sopra
(`src/test-cli.js`, `src/test-telegram.js`), che sono l'unico modo per provare
una modifica al prompt o alla pipeline senza toccare WhatsApp.

Non è un repository git: il deploy avviene via `rsync` verso il VPS (vedi
`DEPLOY.md`), dove gira come servizio systemd `costa-rei-bot`.

## Architettura

Bot WhatsApp per una casa vacanze a Costa Rei, con **human-in-the-loop**: le
risposte "sicure" partono da sole, tutto il resto arriva all'host come bozza su
Telegram da approvare/modificare/ignorare.

Flusso di un messaggio (`src/index.js` è l'unico punto in cui i pezzi si
incontrano; tutto il resto è disaccoppiato):

```
WhatsApp (whatsapp.js) → allowlist → memory (SQLite) → engine → brain (Claude)
                                                          ↓
                            invia al cliente  ←──  o  ──→  telegram.js (bozza all'host)
                                                                  ↓ approvazione
                                                        learned.js (FAQ) ──→ knowledge.js
```

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
  esporrebbero i numeri dei clienti).
- **Gli errori tecnici non devono restare silenziosi**: se la pipeline fallisce
  (rate limit, overload), `index.js` avvisa l'host via Telegram invece di
  propagare, così può rispondere a mano. Le eccezioni di `notifyHost` e degli
  alert sono a loro volta inghiottite (`safeAlert`).
- **Il bot ignora gruppi, status e media** e non manda mai messaggi a freddo:
  risponde solo a chi scrive per primo.

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
- **Le FAQ di zona scadono** dopo 90 giorni (`EXPIRY_DAYS` in `learned.js`):
  `knowledge.js` le marca «SCADUTA» nel prompt e il system prompt istruisce il
  modello a non fidarsene.
- **`knowledge/casa.md`** è la fonte canonica delle risposte. Le voci
  «DA COMPLETARE» sono intenzionali: il prompt le tratta come "non lo so".

### File di stato a runtime (tutti gitignorati)

`data/bot.db` (conversazioni) · `knowledge/learned.json` (FAQ imparate) ·
`allowlist.json` (numeri autorizzati) · `auth_info/` (sessione WhatsApp) ·
`.env`. Sono anche l'elenco esatto da includere nei backup del server.
