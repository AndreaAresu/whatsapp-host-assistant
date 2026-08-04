import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// BOT_DB_PATH serve ai test, che girano su un database usa-e-getta invece che
// sullo storico vero delle conversazioni.
const DB_PATH = process.env.BOT_DB_PATH || join(__dirname, '..', 'data', 'bot.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

// Database SQLite persistente (sopravvive ai riavvii). WAL = letture/scritture
// concorrenti più robuste.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conv_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, ts);
`);

export default db;
