import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dirname, '..', 'allowlist.json');

/** Tiene solo le cifre (es. "+39 333 12 34" -> "393331234"). */
export function normalizeNumber(input) {
  return String(input ?? '').replace(/\D/g, '');
}

/** Estrae il numero (cifre) da un JID WhatsApp (es. "39333...@s.whatsapp.net"). */
export function jidToNumber(jid) {
  return normalizeNumber(String(jid ?? '').split('@')[0].split(':')[0]);
}

export function loadAllowlist() {
  if (!existsSync(PATH)) return [];
  try {
    const data = JSON.parse(readFileSync(PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(list) {
  writeFileSync(PATH, JSON.stringify(list, null, 2));
}

export function isAllowed(jid) {
  return isAllowedNumber(jidToNumber(jid));
}

/** Controlla un numero di telefono già normalizzato (sole cifre). */
export function isAllowedNumber(num) {
  const n = normalizeNumber(num);
  return n ? loadAllowlist().includes(n) : false;
}

/** Aggiunge un numero (accetta sia un numero scritto sia un JID). */
export function addNumber(input) {
  const num = String(input).includes('@') ? jidToNumber(input) : normalizeNumber(input);
  if (!num) return { added: false, number: num, reason: 'numero non valido' };
  const list = loadAllowlist();
  if (list.includes(num)) return { added: false, number: num, reason: 'già presente' };
  list.push(num);
  save(list);
  return { added: true, number: num };
}

export function removeNumber(input) {
  const num = String(input).includes('@') ? jidToNumber(input) : normalizeNumber(input);
  const list = loadAllowlist();
  const idx = list.indexOf(num);
  if (idx === -1) return { removed: false, number: num };
  list.splice(idx, 1);
  save(list);
  return { removed: true, number: num };
}

export function listNumbers() {
  return loadAllowlist();
}
