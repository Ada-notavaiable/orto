// auth.js — autenticazione client-side per OrtPWA (GitHub Pages).
//
// ⚠️ SICUREZZA: il valore hashato della password è nel sorgente.
// Chiunque ispezioni la pagina può trovarlo. Adatto SOLO per uso
// personale su PWA singolo-utente. NON usare per dati sensibili
// o multi-utente (per quello serve un backend autenticato).
//
// Per cambiare credenziali: modifica USERNAME, poi genera l'hash della
// nuova password con:
//   node -e "const c=require('crypto');console.log(c.createHash('sha256').update('NUOVA_PASS'+'orto-salt-2024').digest('hex'))"
// e incolla il risultato in HASHED_PW.

// Pagine di destinazione consentite dopo login (anti open-redirect).
const ALLOWED_PAGES = ['index.html', 'stats.html', 'login.html'];
function safeNextTarget(raw) {
  if (!raw || typeof raw !== 'string') return 'index.html';
  const base = raw.split('/').pop();
  return ALLOWED_PAGES.includes(base) ? base : 'index.html';
}

const Auth = {
  USERNAME: 'ada',
  // SHA-256 di "4321" + SALT
  HASHED_PW: 'e7c37bc6918ed4f592ed1dc3eb9326440290b34e0831b25f4ab53d44f1d02c5f',
  SALT: 'orto-salt-2024',
  SESSION_KEY: 'ortopwa_session',

  // SHA-256 di (input + SALT), hex.
  async hash(input) {
    const enc = new TextEncoder().encode(input + this.SALT);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  },

  async login(username, password) {
    if (username !== this.USERNAME) return false;
    const h = await this.hash(password);
    if (h !== this.HASHED_PW) return false;
    sessionStorage.setItem(this.SESSION_KEY, JSON.stringify({
      user: username,
      at: Date.now()
    }));
    return true;
  },

  isAuthed() {
    try {
      return !!JSON.parse(sessionStorage.getItem(this.SESSION_KEY) || 'null');
    } catch { return false; }
  },

  logout() {
    sessionStorage.removeItem(this.SESSION_KEY);
  },

  // Guardia di pagina: redirect a login.html se non autenticati.
  // Aggiungere "Auth.requireAuth()" come prima riga di ogni <script> di pagina protetta.
  requireAuth() {
    if (!this.isAuthed()) {
      const here = safeNextTarget(location.pathname.split('/').pop());
      location.replace('login.html?next=' + encodeURIComponent(here));
    }
  },

  // Helper pubblico: valida e normalizza un parametro "next"
  safeNext: safeNextTarget
};

window.Auth = Auth;
window.ALLOWED_PAGES = ALLOWED_PAGES;
