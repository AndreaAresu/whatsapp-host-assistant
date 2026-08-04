# Deploy su VPS (24/7)

Guida per tenere il bot sempre attivo su un piccolo server Linux (Ubuntu/Debian).

## 1. Il server
- Basta un VPS piccolo: **1 vCPU, 1 GB RAM**. Es. Hetzner (CX22), DigitalOcean, Contabo.
- OS consigliato: **Ubuntu 24.04 LTS**.
- Accedi via SSH: `ssh utente@IP_DEL_SERVER`

## 2. Installa Node.js 20 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential
node -v   # deve stampare v20.x
```
(`build-essential` serve a compilare `better-sqlite3` se manca il binario precompilato.)

## 3. Porta il codice sul server
Dal tuo computer (niente git necessario), con rsync:
```bash
rsync -av --exclude node_modules --exclude .git --exclude auth_info \
  --exclude data --exclude .env \
  ./ utente@IP_DEL_SERVER:~/chat-bot-costa-rei/
```

## 4. Configura sul server
```bash
cd ~/chat-bot-costa-rei
npm ci                      # installa ESATTAMENTE le versioni di package-lock.json
sudo apt install -y ffmpeg  # opzionale: rete di sicurezza per i vocali (vedi README)
cp .env.example .env
nano .env    # inserisci ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY
```

> ⚠️ Usa `npm ci`, **non** `npm install`. `npm ci` installa esattamente le
> versioni bloccate in `package-lock.json`, cioè quelle provate; `npm install`
> può risolvere versioni più recenti e mettere in produzione codice mai testato.
> Serve che `package-lock.json` sia arrivato con l'rsync (lo è: non è escluso).

## 5. Primo avvio: scansiona il QR (una volta sola)
```bash
node src/index.js
```
Appare il QR nel terminale → su WhatsApp: **Impostazioni → Dispositivi collegati →
Collega un dispositivo** → scansiona. Quando vedi `✅ WhatsApp connesso`, premi
`Ctrl+C`. La sessione resta salvata in `auth_info/` (non serve più riscansionare).

## 6. Servizio sempre attivo (systemd)
```bash
sudo cp deploy/costa-rei-bot.service /etc/systemd/system/
sudo nano /etc/systemd/system/costa-rei-bot.service   # metti il tuo utente e il path completo
sudo systemctl daemon-reload
sudo systemctl enable --now costa-rei-bot
```
Comandi utili:
- stato: `systemctl status costa-rei-bot`
- log dal vivo: `journalctl -u costa-rei-bot -f`
- riavvio: `sudo systemctl restart costa-rei-bot`

> Alternativa con pm2: `sudo npm i -g pm2 && pm2 start src/index.js --name costa-rei-bot && pm2 save && pm2 startup`

## 7. Backup
Salva periodicamente (es. cron giornaliero che fa un tar e lo copia altrove):
`data/` · `auth_info/` · `knowledge/` · `allowlist.json` · `.env`

## 8. Aggiornare il bot
```bash
# dal tuo computer: ripeti l'rsync del punto 3, poi sul server:
cd ~/chat-bot-costa-rei && npm ci && sudo systemctl restart costa-rei-bot
```

Per aggiornare davvero una libreria, fallo **sul tuo computer** (`npm update` o
`npm install <pacchetto>@<versione>`), provalo in locale con `npm run brain`,
committa il `package-lock.json` aggiornato e solo allora fai l'rsync. Così sul
server non finisce mai una versione che non hai visto funzionare.
