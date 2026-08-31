/* Demo assistente Casa Costa Rei — frontend.
 *
 * Questo file fa da CANALE, esattamente come telegram.js fa per il bot vero:
 * riceve la decisione del modello e decide se la risposta va al cliente o
 * all'host. La regola è la stessa riga di engine.js:
 *
 *     invia automaticamente  ⟺  action === 'invia' && !rodaggio
 *
 * Lo storico vive qui nel browser (max 20 messaggi, come MAX_MESSAGES in
 * memory.js) perché le Netlify Functions sono serverless: nessuno stato lato
 * server, nessun messaggio salvato da nessuna parte.
 */

const $ = (id) => document.getElementById(id);

const el = {
  messaggi: $('messaggi'), form: $('scrivi'), input: $('input'), invia: $('invia'),
  rodaggio: $('rodaggio'), rodaggioVal: $('rodaggio-val'),
  suggerimenti: $('suggerimenti'),
  stato: $('wa-stato'),
  graffetta: $('graffetta'), file: $('file'),
  allegato: $('allegato'), allegatoImg: $('allegato-img'),
  allegatoPeso: $('allegato-peso'), allegatoVia: $('allegato-via'),
  registra: $('registra'), regTempo: $('reg-tempo'),
  regInvia: $('reg-invia'), regAnnulla: $('reg-annulla'),
  iconaInvia: $('icona-invia'), iconaMicro: $('icona-micro'),
  decisione: $('decisione'), decisioneVuota: $('decisione-vuota'),
  inbox: $('inbox'), inboxVuota: $('inbox-vuota'), contaInbox: $('conta-inbox'),
};

const MAX_STORICO = 20;

/** Storico inviato al modello: SOLO ciò che il cliente ha davvero visto. */
let storico = [];
let inAttesa = false;
let bozzeAperte = 0;
let fotoInAttesa = null; // { data, mediaType, anteprima, byte }
let registratore = null; // MediaRecorder attivo
let esaurito = false; // messaggi di prova finiti: i controlli restano spenti

const sessione = { messaggi: 0, costo: 0, riscattato: 0 };

/* ── Prezzi Claude Haiku 4.5 ($ per milione di token) ───────────────────── */
const PREZZI = { in: 1.0, out: 5.0, cacheScrittura: 1.25, cacheLettura: 0.10 };

function calcolaCosto(u = {}) {
  const m = 1e6;
  return (
    ((u.input_tokens ?? 0) * PREZZI.in +
      (u.output_tokens ?? 0) * PREZZI.out +
      (u.cache_creation_input_tokens ?? 0) * PREZZI.cacheScrittura +
      (u.cache_read_input_tokens ?? 0) * PREZZI.cacheLettura) / m
  );
}

/** Quanto sarebbe costato senza prompt caching, meno quanto è costato davvero. */
function risparmioCache(u = {}) {
  const letti = u.cache_read_input_tokens ?? 0;
  return (letti * (PREZZI.in - PREZZI.cacheLettura)) / 1e6;
}

const soldi = (n) => '$' + n.toFixed(4);

/* ── Foto ───────────────────────────────────────────────────────────────── */

const MAX_LATO = 1024;   // oltre questo Claude non guadagna nulla, e i token sì
const QUALITA_JPEG = 0.82;

/**
 * Ridimensiona la foto NEL BROWSER prima di spedirla. Due motivi:
 *  · costo — una foto da 4000px costa token senza aggiungere informazione utile
 *    su un guasto in casa, e il tetto della funzione è 1,5 MB;
 *  · privacy — ridisegnarla su un canvas butta via i metadati EXIF, quindi le
 *    coordinate GPS della foto non lasciano il dispositivo.
 */
async function preparaFoto(file) {
  const bitmap = await createImageBitmap(file);
  const scala = Math.min(1, MAX_LATO / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scala);
  const h = Math.round(bitmap.height * scala);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITA_JPEG);
  const data = dataUrl.split(',')[1];
  return { data, mediaType: 'image/jpeg', anteprima: dataUrl, byte: Math.floor(data.length * 0.75) };
}

function mostraAllegato(foto) {
  fotoInAttesa = foto;
  el.allegatoImg.src = foto.anteprima;
  el.allegatoPeso.textContent = `${Math.round(foto.byte / 1024)} KB · ready to send`;
  el.allegato.hidden = false;
  aggiornaIconaInvio();
  el.input.focus();
}

function togliAllegato() {
  fotoInAttesa = null;
  el.allegato.hidden = true;
  el.allegatoImg.removeAttribute('src');
  aggiornaIconaInvio();
}

/* ── Vocali ─────────────────────────────────────────────────────────────── */

// MediaRecorder produce formati diversi a seconda del browser. Verificati dal
// vivo contro Gemini: webm/opus (Chrome, Edge, Firefox) e mp4 (Safari) vengono
// trascritti entrambi correttamente.
const MIME_REGISTRAZIONE = [
  'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus',
];
const MAX_SECONDI = 60;

const mimeSupportato = () =>
  MIME_REGISTRAZIONE.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? '';

async function avviaRegistrazione() {
  // `navigator.mediaDevices` esiste SOLO in contesto sicuro (https, o
  // localhost). Aprendo il server di sviluppo dal telefono su
  // http://<ip-locale>:8888 non c'è, e Safari non distingue: senza questo
  // controllo il messaggio dava la colpa al browser, che invece va benissimo
  // (iOS Safari registra da 14.3, in audio/mp4). In produzione la pagina è in
  // https e il ramo non scatta.
  if (!window.isSecureContext) {
    nota('Voice notes need a secure (https) connection — this page is served over plain http.', 'attesa');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    nota('Your browser will not record audio. Type the message instead.', 'attesa');
    return;
  }

  let flusso;
  try {
    flusso = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Permesso negato: non è un errore da nascondere, ma nemmeno da drammatizzare.
    nota('Microphone permission is needed to record a voice note.', 'attesa');
    return;
  }

  const mimeType = mimeSupportato();
  const rec = new MediaRecorder(flusso, mimeType ? { mimeType } : undefined);
  const pezzi = [];
  let annullato = false;
  const iniziato = Date.now();

  rec.ondataavailable = (e) => { if (e.data.size) pezzi.push(e.data); };

  rec.onstop = async () => {
    clearInterval(tickTimer);
    flusso.getTracks().forEach((t) => t.stop()); // spegne la spia del microfono
    el.registra.hidden = true;
    el.form.hidden = false;
    registratore = null;
    if (annullato || !pezzi.length) return;

    const blob = new Blob(pezzi, { type: rec.mimeType || 'audio/webm' });
    const secondi = Math.max(1, Math.round((Date.now() - iniziato) / 1000));
    const data = await blobInBase64(blob);
    // L'URL del blob serve solo alla bolla in pagina: al server va il base64.
    // Non lo revochiamo — il vocale resta riascoltabile finché la chat è aperta.
    manda('', { audio: { data, mediaType: blob.type, secondi, url: URL.createObjectURL(blob) } });
  };

  // Timer + taglio automatico: un vocale lungo costa e la demo non ne ha bisogno.
  const tickTimer = setInterval(() => {
    const s = Math.floor((Date.now() - iniziato) / 1000);
    el.regTempo.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= MAX_SECONDI) rec.stop();
  }, 200);

  registratore = { rec, annulla: () => { annullato = true; rec.stop(); } };
  el.regTempo.textContent = '0:00';
  el.form.hidden = true;
  el.registra.hidden = false;
  rec.start();
}

const blobInBase64 = (blob) =>
  new Promise((risolvi) => {
    const lettore = new FileReader();
    lettore.onload = () => risolvi(String(lettore.result).split(',')[1]);
    lettore.readAsDataURL(blob);
  });

/** Forma d'onda decorativa, deterministica sulla durata: non è l'audio vero. */
function onda(secondi) {
  const n = 26;
  return Array.from({ length: n }, (_, i) => {
    const h = 5 + Math.abs(Math.sin(i * 1.7 + secondi)) * 15;
    return `<i style="height:${h.toFixed(0)}px"></i>`;
  }).join('');
}

const SVG_PLAY = '<path fill="currentColor" d="M8 5v14l11-7z"/>';
const SVG_PAUSA = '<path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
const icona = (d) => `<svg viewBox="0 0 24 24" width="20" height="20">${d}</svg>`;

const mmss = (secondi) => {
  const s = Math.max(0, Math.round(secondi));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Un solo vocale alla volta, come nell'app. */
let vocaleInCorso = null;

/**
 * Riproduttore del vocale dentro la bolla. Il file non lascia mai il browser
 * due volte: al server è già andato in base64, qui si riascolta l'URL del blob.
 */
function vocale(secondi, url) {
  const v = document.createElement('div');
  v.className = 'wa-vocale';

  const tasto = document.createElement('button');
  tasto.type = 'button';
  tasto.innerHTML = icona(SVG_PLAY);
  tasto.setAttribute('aria-label', 'Play voice message');

  const onde = document.createElement('span');
  onde.className = 'wa-onda';
  onde.innerHTML = onda(secondi);

  const durata = document.createElement('span');
  durata.className = 'durata';
  durata.textContent = mmss(secondi);

  v.append(tasto, onde, durata);

  // Senza sorgente (non dovrebbe capitare) resta il disegno, senza tasto morto.
  if (!url) { tasto.disabled = true; return v; }

  const suono = new Audio(url);
  const barre = [...onde.children];

  // L'avanzamento si calcola sui secondi misurati durante la registrazione:
  // i blob di MediaRecorder spesso non portano metadati e `suono.duration`
  // torna Infinity, che riempirebbe la forma d'onda tutta in una volta.
  const avanzamento = (frazione) => {
    const n = Math.round(Math.min(1, Math.max(0, frazione)) * barre.length);
    barre.forEach((b, i) => b.classList.toggle('suonata', i < n));
  };

  const fermo = () => {
    tasto.innerHTML = icona(SVG_PLAY);
    tasto.setAttribute('aria-label', 'Play voice message');
  };

  suono.addEventListener('play', () => {
    tasto.innerHTML = icona(SVG_PAUSA);
    tasto.setAttribute('aria-label', 'Pause voice message');
  });
  suono.addEventListener('pause', fermo);
  suono.addEventListener('timeupdate', () => {
    durata.textContent = mmss(suono.currentTime);
    avanzamento(suono.currentTime / secondi);
  });
  suono.addEventListener('ended', () => {
    fermo();
    durata.textContent = mmss(secondi);
    avanzamento(0);
  });

  tasto.addEventListener('click', () => {
    if (!suono.paused) { suono.pause(); return; }
    if (vocaleInCorso && vocaleInCorso !== suono) vocaleInCorso.pause();
    vocaleInCorso = suono;
    suono.play().catch(() => nota('Your browser refused to play the recording.', 'attesa'));
  });

  return v;
}

/** Il microfono diventa aeroplanino quando c'è qualcosa da mandare. */
function aggiornaIconaInvio() {
  const c = Boolean(el.input.value.trim() || fotoInAttesa);
  el.iconaInvia.hidden = !c;
  el.iconaMicro.hidden = c;
}

/**
 * Unico punto che accende e spegne la barra di scrittura. Tenerlo in un posto
 * solo evita lo stato misto di prima, con il tasto di invio vivo e il resto no.
 */
function aggiornaControlli() {
  const spenti = esaurito || inAttesa;
  el.input.disabled = spenti;
  el.invia.disabled = spenti;
  el.graffetta.disabled = spenti;
}

/* ── Chat (aspetto WhatsApp) ────────────────────────────────────────────── */

// La pagina è in inglese per i lettori stranieri, quindi ora e numeri seguono
// la stessa lingua. Orario a 24h: è quello dello screenshot di WhatsApp.
const ora = () =>
  new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

const SPUNTE =
  '<span class="spunte"><svg viewBox="0 0 16 11" width="16" height="11">' +
  '<path fill="currentColor" d="M11.07.65 5.4 8.2 3.2 6l-.9.9 3.1 3.1L12 1.5zM15.5.65 9.8 8.2 8.9 7l-.75 1 1.65 2.1L16.4 1.5z"/>' +
  '</svg></span>';

/**
 * Una bolla, entrante (Alessio) o uscente (l'ospite, con le spunte blu).
 * `extra` può portare una foto ({ anteprima }) o un vocale ({ secondi }).
 */
function bolla(testo, chi, extra = {}) {
  const riga = document.createElement('div');
  riga.className = `wa-riga ${chi === 'utente' ? 'out' : 'in'}`;

  const b = document.createElement('div');
  b.className = 'wa-bolla';

  if (extra.anteprima) {
    const img = document.createElement('img');
    img.className = 'wa-foto';
    img.src = extra.anteprima;
    img.alt = 'Photo sent';
    b.append(img);
  }

  if (extra.secondi) b.append(vocale(extra.secondi, extra.audioUrl));

  const t = document.createElement('span');
  t.className = 'wa-testo';
  t.textContent = testo;
  if (!testo) t.hidden = true;

  const o = document.createElement('span');
  o.className = 'wa-ora';
  o.innerHTML = ora() + (chi === 'utente' ? ' ' + SPUNTE : '');

  b.append(t, o);
  riga.append(b);
  el.messaggi.append(riga);
  giu();
  return riga;
}

/** Chip centrato, lo stesso che WhatsApp usa per i messaggi di sistema. */
function nota(testo, classe = '') {
  const d = document.createElement('div');
  d.className = 'wa-chip ' + classe;
  d.textContent = testo;
  el.messaggi.append(d);
  giu();
}

const giu = () => { el.messaggi.scrollTop = el.messaggi.scrollHeight; };

const stato = (testo, scrive = false) => {
  el.stato.textContent = testo;
  el.stato.classList.toggle('scrive', scrive);
};

/** "sta scrivendo…" nell'intestazione + la bolla coi puntini, come nell'app. */
function mostraAttesa() {
  stato('typing…', true);

  const riga = document.createElement('div');
  riga.className = 'wa-riga in';
  riga.innerHTML = '<div class="wa-bolla"><span class="wa-puntini"><i></i><i></i><i></i></span></div>';
  el.messaggi.append(riga);
  giu();

  return {
    via: () => { riga.remove(); stato('online'); },
    ascolta: () => stato('listening to the voice note…', true),
  };
}

/** Registra una risposta come consegnata all'ospite (come memory.appendAssistant). */
function consegnaAlCliente(testo) {
  bolla(testo, 'bot');
  storico.push({ role: 'assistant', content: testo });
  if (storico.length > MAX_STORICO) storico = storico.slice(-MAX_STORICO);
}

/* ── Pannello decisione ─────────────────────────────────────────────────── */

// Solo etichette da mostrare: il modello continua a consegnare gli enum
// italiani di submit_response, che restano nel `title` per chi guarda il
// codice. Tradurre qui, e non nel prompt, tiene la pipeline identica a quella
// del bot vero.
const CATEGORIE = {
  regole_casa: 'house rules',
  info_zona: 'local info',
  sensibile: 'sensitive',
  saluto_altro: 'greeting / other',
  documento_identita: 'ID document',
};
const AZIONI = { invia: 'send', escala: 'escalate' };

function mostraDecisione(d) {
  el.decisioneVuota.hidden = true;
  el.decisione.hidden = false;

  const cat = $('d-categoria');
  cat.textContent = CATEGORIE[d.category] ?? d.category;
  cat.title = d.category;
  const az = $('d-azione');
  az.textContent = AZIONI[d.action] ?? d.action;
  az.title = d.action;
  az.className = 'dist ' + (d.action === 'invia' ? 'invia' : 'escala');
  $('d-lingua').textContent = d.language || '–';
  $('d-motivo').textContent = d.reason || '—';

  const fonti = d.sources ?? [];
  $('d-fonti-blocco').hidden = fonti.length === 0;
  $('d-fonti').innerHTML = '';
  for (const f of fonti.slice(0, 8)) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = f.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = f.title || f.url;
    li.append(a);
    $('d-fonti').append(li);
  }

  const u = d.usage ?? {};
  $('m-ms').textContent = (d.ms / 1000).toFixed(1) + ' s';
  $('m-steps').textContent = d.steps ?? 1;
  $('m-in').textContent = (u.input_tokens ?? 0).toLocaleString('en-US');
  $('m-out').textContent = (u.output_tokens ?? 0).toLocaleString('en-US');
  $('m-cache').textContent = (u.cache_read_input_tokens ?? 0).toLocaleString('en-US');
  $('m-costo').textContent = soldi(calcolaCosto(u));

  // Quanti messaggi restano a questo visitatore: è un tetto di spesa, e va
  // detto prima che finiscano, non dopo.
  if (typeof d.rimanenti === 'number') {
    $('s-rimasti').textContent = `${d.rimanenti} / ${d.limite}`;
    if (d.rimanenti === 3) nota('3 demo messages left.', 'attesa');
    if (d.rimanenti === 0) {
      const fra = d.riparteFraMinuti
        ? ` They reset in about ${d.riparteFraMinuti} minutes.`
        : '';
      nota(`You have used every demo message for this hour.${fra}`, 'attesa');
      // Il flag, non i soli .disabled: il blocco finally di manda() gira DOPO
      // questa funzione e riaccendeva il pulsante di invio, lasciando campo e
      // graffetta spenti. Mezza barra viva e mezza morta sembra un guasto.
      esaurito = true;
      aggiornaControlli();
    }
  }

  sessione.messaggi++;
  sessione.costo += calcolaCosto(u);
  sessione.riscattato += risparmioCache(u);
  $('s-msg').textContent = sessione.messaggi;
  $('s-costo').textContent = soldi(sessione.costo);
  $('s-cache').textContent = soldi(sessione.riscattato);
}

/* ── Inbox host ─────────────────────────────────────────────────────────── */

function aggiornaConta() {
  el.contaInbox.textContent = bozzeAperte;
  el.contaInbox.hidden = bozzeAperte === 0;
  el.inboxVuota.hidden = bozzeAperte > 0;
}

function chiediApprovazione({ domanda, decisione }) {
  const card = document.createElement('article');
  card.className = 'scheda-bozza';

  const perche = document.createElement('p');
  perche.className = 'domanda';
  const etichetta = CATEGORIE[decisione.category] ?? decisione.category;
  perche.textContent = `Guest asked: "${domanda}" · ${etichetta} · ${decisione.reason}`;

  const testoBozza = document.createElement('div');
  testoBozza.className = 'bozza';
  testoBozza.textContent = decisione.draft || '';

  const bottoni = document.createElement('div');
  bottoni.className = 'bottoni';
  const bInvia = Object.assign(document.createElement('button'), { className: 'azione', textContent: '✅ Send' });
  const bMod   = Object.assign(document.createElement('button'), { className: 'azione sec', textContent: '✏️ Edit' });
  const bIgn   = Object.assign(document.createElement('button'), { className: 'azione terzo', textContent: '🚫 Discard' });
  bottoni.append(bInvia, bMod, bIgn);

  card.append(perche, testoBozza, bottoni);
  el.inbox.append(card);
  bozzeAperte++;
  aggiornaConta();
aggiornaIconaInvio();

  const chiudi = (esito) => {
    card.remove();
    bozzeAperte--;
    aggiornaConta();
    if (esito) nota(esito);
  };

  bInvia.onclick = () => {
    const t = (decisione.draft || '').trim();
    if (!t) { bMod.click(); return; } // niente bozza: passa direttamente alla scrittura
    chiudi(null);
    consegnaAlCliente(t);
  };

  bIgn.onclick = () => chiudi('🚫 The host discarded the draft — nothing was sent to the guest.');

  // La modifica SOSTITUISCE l'anteprima invece di affiancarla: prima si vedeva
  // lo stesso testo due volte, in sola lettura e nella casella, e il pulsante
  // «Edit» restava lì senza fare più niente. Ora fa da annulla.
  const inviaOriginale = bInvia.onclick;
  let ta = null;

  const chiudiModifica = () => {
    ta.remove();
    ta = null;
    testoBozza.hidden = false;
    bMod.textContent = '✏️ Edit';
    bInvia.textContent = '✅ Send';
    bInvia.onclick = inviaOriginale;
  };

  bMod.onclick = () => {
    if (ta) { chiudiModifica(); return; }

    ta = document.createElement('textarea');
    ta.value = decisione.draft || '';
    ta.placeholder = 'Write the reply to send to the guest…';
    testoBozza.hidden = true;
    card.insertBefore(ta, bottoni);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    bMod.textContent = '↩︎ Cancel';
    bInvia.textContent = '✅ Send the edited text';
    bInvia.onclick = () => {
      const t = ta.value.trim();
      if (!t) { ta.focus(); return; }
      chiudi('✏️ The host edited the draft before sending it.');
      consegnaAlCliente(t);
    };
  };
}

/* ── Invio ──────────────────────────────────────────────────────────────── */

async function manda(testo, allegati = {}) {
  const foto = allegati.foto ?? fotoInAttesa;
  const audio = allegati.audio ?? null;
  if (inAttesa) return;
  if (!testo.trim() && !foto && !audio) return;

  if (esaurito) return;
  inAttesa = true;
  aggiornaControlli();
  el.input.value = '';
  togliAllegato();
  aggiornaIconaInvio();

  // La bolla uscente mostra subito foto o vocale, come nell'app.
  const rigaInviata = bolla(testo, 'utente', {
    anteprima: foto?.anteprima,
    secondi: audio?.secondi,
    audioUrl: audio?.url,
  });

  const storicoDaMandare = storico.slice(-MAX_STORICO);
  // Nello storico va un SEGNAPOSTO, mai i byte del media: gonfierebbero ogni
  // richiesta successiva. È la stessa regola di index.js per WhatsApp.
  const perStorico = audio
    ? testo || '[vocale]'
    : foto
      ? `[il cliente ha inviato una foto]${testo ? ' ' + testo : ''}`
      : testo;
  storico.push({ role: 'user', content: perStorico });
  if (storico.length > MAX_STORICO) storico = storico.slice(-MAX_STORICO);

  const attesa = mostraAttesa();

  try {
    // Relativo, non assoluto: in produzione la pagina vive sotto
    // estaated.it/assistant/ e il rewrite proxy inoltra /assistant/api/chat.
    const risposta = await fetch('./api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: testo,
        history: storicoDaMandare,
        ...(foto && { image: { data: foto.data, mediaType: foto.mediaType } }),
        ...(audio && { audio: { data: audio.data, mediaType: audio.mediaType } }),
      }),
    });

    // Un errore (rate limit, validazione) torna come JSON semplice, non in streaming.
    if (!risposta.ok) {
      const { errore } = await risposta.json().catch(() => ({}));
      attesa.via();
      nota(errore || `Error ${risposta.status}. Try again shortly.`, 'attesa');
      return;
    }

    // Streaming NDJSON: una riga = un evento.
    const reader = risposta.body.getReader();
    const decoder = new TextDecoder();
    let resto = '';
    let decisione = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resto += decoder.decode(value, { stream: true });
      const righe = resto.split('\n');
      resto = righe.pop() ?? '';
      for (const riga of righe) {
        if (!riga.trim()) continue;
        let ev;
        try { ev = JSON.parse(riga); } catch { continue; }
        if (ev.tipo === 'decisione') decisione = ev;
        else if (ev.tipo === 'stato' && ev.valore === 'ascolto') attesa.ascolta();
        else if (ev.tipo === 'trascrizione') {
          // La trascrizione compare sotto il vocale, come fa WhatsApp: rende
          // visibile che il modello legge un TESTO, non l'audio.
          const t = document.createElement('div');
          t.className = 'wa-trascrizione';
          t.textContent = ev.testo;
          rigaInviata.querySelector('.wa-bolla').append(t);
          giu();
        }
        else if (ev.tipo === 'errore') { attesa.via(); nota(ev.messaggio, 'attesa'); return; }
      }
    }

    attesa.via();
    if (!decisione) { nota('Message not delivered. Try again.', 'attesa'); return; }

    mostraDecisione(decisione);

    // ⬇️ La riga che conta: è la stessa condizione di engine.js.
    const inviaDaSolo = decisione.action === 'invia' && !el.rodaggio.checked;

    if (inviaDaSolo) {
      consegnaAlCliente(decisione.draft);
    } else {
      // Nella realtà l'ospite non vede NIENTE: aspetta che Alessio risponda.
      // Riprodurlo è più onesto che scrivergli "bozza inviata all'host", ed è
      // il momento in cui si capisce a cosa serve l'inbox. Il chip resta
      // sobrio, nello stile dei messaggi di sistema di WhatsApp.
      nota('Alessio hasn\u2019t replied yet — the draft is waiting for approval', 'attesa');
      stato('online');
      chiediApprovazione({ domanda: testo, decisione });
    }
  } catch (err) {
    attesa.via();
    nota('Connection lost. Check your network and try again.', 'attesa');
    console.error(err);
  } finally {
    inAttesa = false;
    aggiornaControlli();
    if (!esaurito) el.input.focus();
  }
}

/* ── Eventi ─────────────────────────────────────────────────────────────── */

// Come su WhatsApp: a campo vuoto il pulsante è un microfono e avvia la
// registrazione; appena c'è testo (o una foto) diventa l'aeroplanino di invio.
el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (el.input.value.trim() || fotoInAttesa) manda(el.input.value);
  else avviaRegistrazione();
});

el.input.addEventListener('input', aggiornaIconaInvio);

el.graffetta.addEventListener('click', () => el.file.click());

el.file.addEventListener('change', async () => {
  const file = el.file.files?.[0];
  el.file.value = ''; // così riselezionare la stessa foto rifà scattare l'evento
  if (!file) return;
  try {
    mostraAllegato(await preparaFoto(file));
  } catch (err) {
    console.error(err);
    nota('That image could not be read. Try a JPEG or a PNG.', 'attesa');
  }
});

// L'interruttore È la variabile d'ambiente: mostrarne il valore e dire in chat
// cosa cambia è il modo più diretto di spiegare a cosa serve.
el.rodaggio.addEventListener('change', () => {
  const acceso = el.rodaggio.checked;
  el.rodaggioVal.textContent = String(acceso);
  nota(acceso
    ? 'REVIEW_EVERYTHING=true — every reply now waits for the host, even the safe ones.'
    : 'REVIEW_EVERYTHING=false — replies the model considers safe now go out on their own.');
});

el.allegatoVia.addEventListener('click', togliAllegato);
el.regInvia.addEventListener('click', () => registratore?.rec.stop());
el.regAnnulla.addEventListener('click', () => registratore?.annulla());

el.suggerimenti.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  // Il suggerimento sui media non è una domanda: apre il selettore di file.
  if (b.dataset.media === 'foto') { el.file.click(); return; }
  manda(b.textContent);
});

// Schede (solo mobile)
document.querySelectorAll('.scheda').forEach((scheda) => {
  scheda.addEventListener('click', () => {
    document.querySelectorAll('.scheda').forEach((s) => s.classList.remove('attiva'));
    document.querySelectorAll('.riquadro').forEach((r) => r.classList.remove('attivo'));
    scheda.classList.add('attiva');
    $(scheda.dataset.pannello).classList.add('attivo');
  });
});
$('p-chat').classList.add('attivo');

aggiornaConta();
aggiornaIconaInvio();
