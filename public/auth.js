// auth.js — autenticazione client-side per OrtPWA.
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

// ──────────────────────────────────────────────────────────────────
// SHA-256 puro JavaScript (fallback se Web Crypto non disponibile).
// Funziona su HTTP e HTTPS, su qualsiasi browser, anche vecchio.
// Implementazione compatta ispirata a FIPS 180-4.
// ──────────────────────────────────────────────────────────────────
const Sha256 = (function () {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function utf8ToBytes(str) {
    // Converte stringa UTF-8 → Uint8Array (no TextEncoder, massima compatibilità)
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      else { i++; c = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(out);
  }

  function hashBytes(bytes) {
    const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
    const len = bytes.length;
    const bitLen = len * 8;
    // Padding
    const padLen = (len + 9 + 63) & ~63;
    const buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[len] = 0x80;
    // Lunghezza in bit, big-endian a 64 bit
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 4, bitLen >>> 0, false);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

    const W = new Uint32Array(64);
    for (let i = 0; i < padLen; i += 64) {
      for (let t = 0; t < 16; t++) {
        W[t] = dv.getUint32(i + t * 4, false);
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(W[t-15], 7) ^ rotr(W[t-15], 18) ^ (W[t-15] >>> 3);
        const s1 = rotr(W[t-2], 17) ^ rotr(W[t-2], 19) ^ (W[t-2] >>> 10);
        W[t] = (W[t-16] + s0 + W[t-7] + s1) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const T1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const T2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + T1) >>> 0;
        d = c; c = b; b = a; a = (T1 + T2) >>> 0;
      }
      H[0] = (H[0]+a)>>>0; H[1] = (H[1]+b)>>>0; H[2] = (H[2]+c)>>>0; H[3] = (H[3]+d)>>>0;
      H[4] = (H[4]+e)>>>0; H[5] = (H[5]+f)>>>0; H[6] = (H[6]+g)>>>0; H[7] = (H[7]+h)>>>0;
    }
    let hex = '';
    for (let i = 0; i < 8; i++) hex += H[i].toString(16).padStart(8, '0');
    return hex;
  }

  return { utf8ToBytes, hashBytes };
})();

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
  // Usa Web Crypto se disponibile (più veloce), altrimenti fallback puro-JS.
  async hash(input) {
    const data = input + this.SALT;
    // Preferisci Web Crypto (HTTPS / localhost): molto più veloce
    if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      try {
        const enc = new TextEncoder().encode(data);
        const buf = await crypto.subtle.digest('SHA-256', enc);
        return Array.from(new Uint8Array(buf))
          .map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (_) { /* fallthrough al fallback */ }
    }
    // Fallback puro-JS (funziona anche su HTTP, dove subtle è bloccato)
    return Sha256.hashBytes(Sha256.utf8ToBytes(data));
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
