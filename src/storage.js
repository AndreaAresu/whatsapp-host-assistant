// Lettura e scrittura dei piccoli archivi JSON su disco (FAQ imparate,
// allowlist). Sono file piccoli ma preziosi: contengono mesi di risposte
// approvate a mano e la lista di chi può parlare col bot.
import {
  readFileSync, existsSync, renameSync, unlinkSync,
  openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs';

/**
 * Scrittura atomica: scrive su un file temporaneo, forza il flush su disco e
 * solo allora rinomina sul file definitivo.
 *
 * Perché non basta writeFileSync: non è atomica. Se il processo muore a metà
 * (riavvio del VPS, `systemctl restart`, OOM) il file resta troncato e il JSON
 * diventa illeggibile. rename() invece è atomico sullo stesso filesystem: o
 * vede il file vecchio integro, o quello nuovo completo, mai una via di mezzo.
 * L'fsync serve perché senza di esso il rename potrebbe arrivare su disco
 * prima del contenuto, lasciando un file vuoto dopo un calo di corrente.
 */
export function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* già chiuso */ }
    }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nulla da pulire */ }
    throw err;
  }
}

/**
 * Legge un archivio JSON che deve contenere un array. Restituisce sempre un
 * array: non lancia mai, così un file rovinato non impedisce l'avvio del bot.
 *
 * Se il file è illeggibile lo mette DA PARTE rinominandolo, invece di ignorarlo
 * in silenzio. Il motivo è concreto: ignorandolo restituiremmo un array vuoto,
 * e la prima scrittura successiva sovrascriverebbe il file rovinato
 * distruggendo dati ancora recuperabili a mano. Spostandolo, il contenuto
 * originale resta lì da recuperare e l'errore è visibile nei log
 * (`journalctl -u costa-rei-bot`).
 */
export function readJsonArray(path, etichetta) {
  if (!existsSync(path)) return [];

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`⚠️  Non riesco a leggere ${etichetta} (${path}): ${err.message}`);
    return [];
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    quarantena(path, etichetta, `non è JSON valido (${err.message})`);
    return [];
  }

  if (!Array.isArray(data)) {
    quarantena(path, etichetta, 'non contiene un elenco');
    return [];
  }

  return data;
}

function quarantena(path, etichetta, motivo) {
  const backup = `${path}.corrotto-${Date.now()}`;
  let salvato = false;
  try {
    renameSync(path, backup);
    salvato = true;
  } catch { /* se non riusciamo a spostarlo, almeno lo segnaliamo */ }

  console.error(
    `❌ ${etichetta} (${path}) ${motivo}: riparto da zero.\n` +
      (salvato
        ? `   Il file originale è stato messo da parte in ${backup}: recuperalo a mano prima di continuare.`
        : '   ATTENZIONE: non sono riuscito a spostarlo, potrebbe venire sovrascritto.')
  );
}
