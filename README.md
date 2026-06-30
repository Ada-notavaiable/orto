# 🌿 OrtPWA — Raccolto Orto

PWA (Progressive Web App) per tracciare il peso degli ortaggi raccolti dall'orto. Backend **Express + SQLite** in container **Docker**, gestibile via **Portainer** su Raspberry Pi, Orange Pi, o qualsiasi Docker host. **Niente SSH** — pubblichi il codice su GitHub e Portainer fa build + deploy da solo.

---

## ✨ Funzionalità

- 🔐 Login protetto (utente + password hashata con SHA-256, lato client)
- 🥬 Menu a tendina con gli ortaggi aggiunti nella scheda Ortaggi
- ⚖️ Registra pesi, data e note per ogni raccolta
- ✏️ Modifica o elimina raccolte toccando una riga
- 📊 Pagina statistiche con totali **in tempo reale** (auto-refresh 2s)
- 📈 Grafici a barre per ortaggio e per mese
- 📥 Esporta in CSV (Excel/LibreOffice)
- 🔄 Bottone "Aggiorna app" per scaricare subito l'ultima versione del Service Worker
- 📱 Installabile come app su iOS e Android

---

## 🧱 Stack tecnico

| Layer | Tecnologia | Note |
|---|---|---|
| Frontend | HTML/CSS/JS vanilla | PWA, no build step |
| Backend | Node.js 20 + Express | Express per REST API |
| Database | SQLite via `sql.js` | Singolo file `orto.db` |
| Container | Docker multi-arch (armv7/arm64/amd64) | Testato su Orange Pi Zero |
| Auth | SHA-256 + sessionStorage | Client-side, personale |
| Deploy | **GitHub → Portainer** | Zero SSH |

---

## 🚀 Installazione (workflow GitHub → Portainer)

### Prerequisiti

- Un Docker host (Orange Pi Zero, Raspberry Pi, NAS, VPS, anche il tuo PC) con **Portainer** installato
- Un account GitHub (gratuito)

### Passo 1 — Metti il codice su GitHub

```bash
# Nella cartella del progetto, inizializza il repo e fai il primo push
cd orto
git init
git add .
git commit -m "Initial commit: OrtPWA"
git branch -M main
git remote add origin https://github.com/<tuo-username>/orto.git
git push -u origin main
```

> 💡 Se non hai mai usato git, GitHub Desktop o GitHub Codespaces sono alternative visuali.

### Passo 2 — Deploy con Portainer (lettura del git repo)

1. Apri Portainer (es. `http://192.168.1.42:9000`)
2. **Stacks** → **Add stack**
3. Name: `ortopwa`
4. **Build method**: scegli **Repository**
5. Compila:
   - **Repository URL**: `https://github.com/<tuo-username>/orto`
   - **Repository reference**: `refs/heads/main` (o il tuo branch)
   - **Compose path**: `docker-compose.yml`
6. (Opzionale) Spunta **Automatic updates** → **Pull image and redeploy on webhook** — copia il webhook URL
7. Clicca **Deploy the stack**

Portainer scarica il codice, builda l'immagine Docker, e avvia il container. In ~2-3 minuti vedrai:

```
✅ Stack ortopwa started
Container ortopwa  Up (healthy)
```

### Passo 3 — Accedi dal telefono

Trova l'IP del Docker host:
```bash
hostname -I | awk '{print $1}'
# Es: 192.168.1.42
```

Dal telefono (collegato al **Wi-Fi di casa**), apri:
```
http://192.168.1.42:3000
```

Login: `ada` / `4321` (cambialo subito, vedi sotto).

### Passo 4 — Installa come PWA

| OS | Procedura |
|---|---|
| **iOS Safari** | Apri il sito → icona "Condividi" (↑) → "Aggiungi alla schermata Home" |
| **Android Chrome** | Apri il sito → menu ⋮ → "Installa app" (o banner automatico) |

L'icona 🌿 appare sulla home. Da quel momento si apre a tutto schermo.

---

## 🔄 Aggiornare l'app dopo modifiche al codice

### Metodo 1 — Push su GitHub + auto-redeploy (consigliato)

Se hai configurato il webhook in Portainer:

1. Modifica i file in locale (es. cambi un colore in `style.css`)
2. `git add . && git commit -m "cambio colore" && git push`
3. Portainer rileva il push → rebuilda l'immagine → riavvia il container
4. Sul telefono: apri l'app → tocca **🔄 Aggiorna app** (nella pagina principale) → cache svuotata

Se non hai il webhook:
1. Pusha il codice
2. Portainer → Stacks → `ortopwa` → **Pull and redeploy**

### Metodo 2 — Bump del CACHE_NAME (per aggiornamenti PWA sui client)

Quando cambi asset statici (HTML, CSS, JS, icone), il telefono potrebbe ancora usare la versione cached. Per forzare l'aggiornamento:

1. Apri `sw.js`
2. Cambia `CACHE_NAME = 'ortopwa-v3-backend'` → `'ortopwa-v4-backend'`
3. Pusha

Alla prossima apertura, il nuovo SW sostituisce la cache.

---

## 🔐 Login & credenziali

### Default

- **Utente**: `ada`
- **Password**: `4321`

### Cambiarle

1. Apri `auth.js`
2. Modifica `USERNAME`
3. Calcola l'hash della nuova password:
   ```bash
   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('NUOVA_PASSWORD'+'orto-salt-2024').digest('hex'))"
   ```
4. Sostituisci `HASHED_PW` con l'output
5. `git commit -m "nuove credenziali" && git push`
6. Portainer rebuilda → tutti i dispositivi devono riautenticarsi

---

## 💾 Backup del database

Il database è un singolo file `orto.db` montato come volume Docker (`ortodb:/data`).

### Backup automatico giornaliero via crontab

Sulla macchina che ospita Docker (Orange Pi / Pi / NAS):

```bash
# Aggiungi a crontab: crontab -e
0 3 * * * docker run --rm -v ortodb:/data -v ~/backups:/backup alpine tar czf /backup/orto-$(date +\%Y\%m\%d).tar.gz -C /data . && echo "Backup $(date)" >> ~/backups/orto-backup.log
```

### Backup manuale

```bash
docker run --rm -v ortodb:/data -v $(pwd):/backup alpine cp /data/orto.db /backup/orto-backup-$(date +%Y%m%d).db
```

### Esportare in CSV (dal telefono o PC)

Dalla pagina principale → bottone **📥 Esporta CSV**. Salva un CSV con tutte le raccolte (apribile in Excel).

---

## 📂 Struttura del progetto

```
orto/
├── server.js              # Backend Express + SQLite
├── package.json           # Dipendenze Node
├── Dockerfile             # Immagine multi-arch (armv7 + arm64 + amd64)
├── docker-compose.yml     # Stack Portainer-ready
├── entrypoint.sh          # Chown /data + drop a utente node
├── .dockerignore
├── public/                # Asset statici serviti da Express dalla cartella /public
│   ├── index.html         # Pagina principale
│   ├── stats.html         # Statistiche live
│   ├── login.html         # Login
│   ├── style.css          # Tema
│   ├── auth.js            # Auth client-side (SHA-256 + sessionStorage)
│   ├── sw.js              # Service Worker (cache-first static, /api sempre network)
│   ├── manifest.json      # Manifest PWA
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## 🛡️ Sicurezza (per contesto domestico)

Questo setup è pensato per **uso famiglia su LAN**:

- ✅ **Dati centralizzati** sul tuo Docker host (non sul telefono)
- ✅ Più dispositivi accedono agli stessi dati
- ✅ **Backup centralizzati** automatici via cron
- ⚠️ **L'auth è puramente client-side**: chiunque sia sulla LAN può fare `curl http://pi:3000/api/harvests -d '{...}'` e modificare i dati. L'auth impedisce l'accesso casuale dal browser, **non** è una protezione server-side.
- ⚠️ L'hash della password è nel sorgente del frontend (SHA-256 + sale), visibile a chiunque ispezioni la pagina
- ⚠️ Non esporre la porta 3000 direttamente a Internet (Portainer + Cloudflare Tunnel o Tailscale se serve accesso remoto)

Per multi-utente o accesso remoto sicuro, valuta di aggiungere un auth server-side (OAuth, JWT, reverse-proxy con BasicAuth, ecc.).

---

## 🐛 Risoluzione problemi

**Portainer fallisce il build con "manifest unknown" o errori ARM?**
→ Il Dockerfile è multi-arch ma il builder deve supportarlo. Portainer CE 2.x+ lo fa. Aggiorna Portainer se hai una versione vecchia.

**Il container parte ma "Backend non raggiungibile" sul telefono?**
→ Controlla che il telefono sia sulla stessa rete Wi-Fi. Verifica l'IP con `hostname -I`. Controlla i log: `docker logs ortopwa`.

**Vedo i dati vecchi anche dopo un push?**
→ Bump `CACHE_NAME` in `sw.js` e pusha. Oppure tocca **🔄 Aggiorna app** dal telefono.

**L'auth non funziona più dopo un cambio password?**
→ Il browser ha ancora il vecchio `auth.js` in cache. Hard-refresh o bump CACHE_NAME.

**Portainer dice "permission denied" su GitHub?**
→ Per repo privati, in Portainer vai su **Settings → Git Credentials** e configura un Personal Access Token di GitHub.

---

## 📜 Licenza

MIT — usalo liberamente per il tuo orto 🌱
