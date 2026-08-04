# Chat-bot WhatsApp — Casa Costa Rei

Assistente che risponde ai clienti della casa vacanze, con **human-in-the-loop**:
il bot risponde da solo alle domande sicure, e per i casi incerti o delicati ti
manda una bozza da approvare.

**Stato attuale:** Fase 2 — il "cervello" (classificazione + decisione + bozza),
testabile in locale senza WhatsApp.

## Come provarlo
1. Installa le dipendenze:
   ```
   npm install
   ```
2. Copia `.env.example` in `.env` e inserisci la tua `ANTHROPIC_API_KEY`.
3. Avvia la prova interattiva:
   ```
   npm run brain
   ```
4. Scrivi messaggi come farebbe un cliente (in qualsiasi lingua) e osserva la
   decisione del bot: categoria, se invia o escala, e la bozza di risposta.

## Test
```
npm test
```
Girano in locale in meno di un secondo: non serve rete, non chiamano né Claude
né Gemini né Telegram (le API sono finte) e non toccano i tuoi file veri
(`allowlist.json`, `knowledge/learned.json`, `data/bot.db`), che vengono
dirottati in una cartella temporanea. Falli girare dopo ogni modifica al codice.

## Struttura
- `knowledge/casa.md` — base di conoscenza, fonte delle risposte. **Riempi i «DA COMPLETARE».**
- `src/brain.js` — chiamata a Claude: classifica, decide invia/escala, scrive la bozza.
- `src/knowledge.js` — carica la base di conoscenza + le FAQ imparate.
- `src/config.js` — configurazione (chiave API, modello, modalità rodaggio).
- `src/test-cli.js` — prova interattiva in locale.

## Provare il canale Telegram (con cliente simulato)
1. Crea un bot con [@BotFather](https://t.me/BotFather) su Telegram e copia il token.
2. Mettilo in `.env` come `TELEGRAM_BOT_TOKEN`.
3. Avvia l'harness:
   ```
   npm run telegram
   ```
4. Su Telegram scrivi `/start` al tuo bot: ti dirà il tuo **chat id**. Mettilo in
   `.env` come `TELEGRAM_CHAT_ID` e riavvia.
5. Nel terminale scrivi un messaggio "da cliente": le bozze che richiedono
   conferma arrivano su Telegram con i pulsanti **Invia / Modifica / Ignora**.
   L'invio al cliente è per ora simulato (stampato a video); WhatsApp arriva dopo.

## Avvio completo (WhatsApp + Telegram)
Collega il bot al tuo numero WhatsApp come dispositivo aggiuntivo.
1. Nel `.env` servono: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
2. Avvia:
   ```
   npm start
   ```
3. Al primo avvio compare un **QR code** nel terminale: su WhatsApp vai in
   *Impostazioni → Dispositivi collegati → Collega un dispositivo* e scansionalo.
   La sessione resta salvata in `auth_info/` (non serve riscansionare ogni volta).
4. Da ora i messaggi dei clienti vengono gestiti: le risposte sicure partono da
   sole (se il rodaggio è OFF), il resto arriva come bozza su Telegram. In
   modalità rodaggio (default) **ogni** risposta passa da te.

> ⚠️ Baileys non è ufficiale: usi il tuo numero a tuo rischio. Il bot risponde
> solo a chi ti scrive per primo, non manda messaggi a freddo e ignora i gruppi.

## Lista numeri autorizzati (allowlist)
Per non spendere in chiamate a Claude per chi non c'entra con la casa, il bot
risponde **solo** ai numeri in lista (`allowlist.json`).
- **Gestione dal telefono** (comandi al bot Telegram): `/lista`,
  `/aggiungi <numero>`, `/rimuovi <numero>`. Usa il prefisso internazionale
  senza `+` (es. `39333xxxxxxx`).
- **Numero sconosciuto:** quando scrive un numero non in lista, ricevi su
  Telegram una notifica con `[➕ Aggiungi e rispondi]` / `[🚫 Ignora]` —
  nessuna chiamata a Claude finché non lo aggiungi.
- Il filtro vale sia per i messaggi in arrivo sia per l'apprendimento dalle
  risposte manuali (così una risposta a un amico non finisce nelle FAQ).
- Lista vuota = il bot non risponde automaticamente a nessuno, ti avvisa e basta.

## Foto e messaggi vocali
Il bot capisce anche i media, non solo il testo.

**Foto** — le guarda Claude, nella stessa chiamata che già classifica e decide:
una foto vale quanto un messaggio scritto (guasto in casa, elettrodomestico,
dettaglio della casa). Nello storico resta solo un segnaposto: i byte
dell'immagine non entrano mai nel database.

> 🪪 **Documenti d'identità:** se la foto è una carta d'identità, un passaporto
> o simili, il bot si ferma: **non ne legge né salva alcun dato** (niente nomi,
> numeri, date). Ti manda solo un promemoria per la registrazione su
> alloggiatiweb, che resta un lavoro tuo, a mano.

**Vocali** — l'API di Claude non accetta audio, quindi la trascrizione la fa
**Google Gemini** (`GEMINI_API_KEY` nel `.env`); il testo poi rientra nella
pipeline normale e risponde Claude. Sulle bozze in arrivo su Telegram i vocali
sono marcati 🎤 così sai che stai leggendo una trascrizione, che può sbagliare.
Senza la chiave, i vocali ti arrivano come semplice notifica, come prima.

Tutto il resto (video, sticker, documenti-file, contatti, posizioni) resta una
notifica: rispondi a mano. I media dei numeri **non** in lista non vengono
nemmeno scaricati.

> Nota: i vocali WhatsApp sono Opus in container Ogg. Di norma Gemini li accetta
> così com'è; se li rifiuta, il bot li transcodifica con `ffmpeg` (se installato)
> e riprova. Su un VPS: `sudo apt install ffmpeg`.

## Apprendimento (FAQ che cresce)
Il bot impara dalle risposte che approvi, così la stessa domanda non la rispondi
due volte:
- **Da Telegram:** quando approvi/modifichi una bozza che era in escalation
  (info zona o regola casa non ancora nota), la risposta finale viene salvata
  in `knowledge/learned.json` e riusata in futuro.
- **Dal telefono:** se rispondi a mano a un cliente, il bot lo nota e — se è una
  risposta riutilizzabile — ti chiede su Telegram se salvarla (**Salva / No**).
- **Scadenza:** le info sulla zona scadono dopo ~3 mesi (un ristorante può
  chiudere): alla scadenza tornano in revisione invece di partire da sole.

## Persistenza dati
- **Conversazioni**: SQLite in `data/bot.db` (sopravvive ai riavvii). Una chat si
  "azzera" dopo 6h di silenzio; si tengono gli ultimi 20 messaggi.
- **FAQ imparate**: `knowledge/learned.json` · **Allowlist**: `allowlist.json` ·
  **Sessione WhatsApp**: `auth_info/`.
- Da salvare nei backup del server: `data/`, `auth_info/`, `knowledge/`,
  `allowlist.json`, `.env`.

## Prossimi passi
- [x] Ricerca web nativa per le domande sulla zona
- [x] Canale Telegram per approvare/modificare le bozze
- [x] Connessione WhatsApp (Baileys) + memoria conversazioni
- [x] Apprendimento: salvataggio delle risposte approvate nelle FAQ
- [x] Lettura delle foto (Claude) e trascrizione dei vocali (Gemini)
- [ ] Deploy su un VPS per tenerlo attivo 24/7 — vedi [DEPLOY.md](DEPLOY.md)
