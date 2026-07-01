// server.js — Backend Express + SQLite (via sql.js) per Orto.
// Persiste i dati in un singolo file (orto.db) montato come volume Docker.

const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
// DB_PATH configurabile via env (default = cartella del progetto, sovrascritto
// dall'entrypoint Docker a /data/orto.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'orto.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;
let saveTimer = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS vegetables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS harvests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vegetable_id INTEGER NOT NULL,
      weight REAL NOT NULL,
      date TEXT NOT NULL DEFAULT (date('now','localtime')),
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (vegetable_id) REFERENCES vegetables(id) ON DELETE CASCADE
    )
  `);

  // Crea /data se serve (utile anche fuori Docker)
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  saveDB();
  console.log('Database initialized at', DB_PATH);
}

// Salva con un piccolo debounce per evitare scritture I/O continue sotto carico
function saveDB() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    } catch (e) {
      console.error('saveDB error:', e.message);
    }
  }, 50);
}

// Salva sincrono (usato in caso di uscita)
function saveDBSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('saveDBSync error:', e.message);
  }
}

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function lastInsertId() {
  const result = db.exec('SELECT last_insert_rowid()');
  return result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;
}

// --- Vegetables ---

app.get('/api/vegetables', (req, res) => {
  res.json(queryAll('SELECT id, name FROM vegetables ORDER BY name COLLATE NOCASE'));
});

app.post('/api/vegetables', (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
  try {
    db.run('INSERT INTO vegetables (name) VALUES (?)', [name]);
    const id = lastInsertId();
    saveDB();
    res.json({ id, name });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      const existing = queryAll('SELECT id, name FROM vegetables WHERE name = ?', [name]);
      if (existing.length > 0) return res.json(existing[0]);
      return res.status(500).json({ error: 'Duplicate ma non trovato' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/vegetables/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Nome obbligatorio' });
  if (queryAll('SELECT id FROM vegetables WHERE id = ?', [id]).length === 0) {
    return res.status(404).json({ error: 'Ortaggio non trovato' });
  }
  try {
    db.run('UPDATE vegetables SET name = ? WHERE id = ?', [name, id]);
    saveDB();
    res.json({ id, name });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Esiste già un ortaggio con questo nome' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/vegetables/:id', (req, res) => {
  db.run('DELETE FROM vegetables WHERE id = ?', [parseInt(req.params.id)]);
  saveDB();
  res.json({ ok: true });
});

// --- Export CSV ---

app.get('/api/export/csv', (req, res) => {
  const rows = queryAll(`
    SELECT h.id, v.name AS vegetable_name, h.weight, h.date, h.notes, h.created_at
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC
  `);
  const header = 'ID,Ortaggio,Peso (kg),Data,Note,Creato il\n';
  const body = rows.map(r => {
    const name = (r.vegetable_name || '').replace(/"/g, '""');
    const notes = (r.notes || '').replace(/"/g, '""');
    return `${r.id},"${name}",${r.weight},${r.date},"${notes}",${r.created_at}`;
  }).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="raccolto-orto-' + new Date().toISOString().slice(0, 10) + '.csv"');
  res.send('\uFEFF' + header + body);
});

// --- Import CSV ---
// Modalità:
//   mode=append   (default): aggiunge le righe a quelle esistenti, crea ortaggi
//                           mancanti, salta duplicati esatti.
//   mode=replace:             cancella PRIMA harvests e vegetables, poi importa.

// Parser CSV tollerante: gestisce virgolette, escape `""`, virgole interne.
// Non gestisce newline dentro campi virgolettati (non usati dall'esportazione).
function parseCSV(text) {
  const cleaned = String(text || '').replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/).filter(l => l.length > 0);
  return lines.map(line => {
    const out = [];
    let val = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i], nx = line[i + 1];
      if (inQuotes && c === '"' && nx === '"') { val += '"'; i++; }
      else if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) { out.push(val); val = ''; }
      else val += c;
    }
    out.push(val);
    return out;
  }).filter(row => row.length > 1 || (row[0] || '').length > 0);
}

const importTextParser = express.text({ type: '*/*', limit: '10mb' });

app.post('/api/import/csv', importTextParser, (req, res) => {
  const mode = req.query.mode === 'replace' ? 'replace' : 'append';
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'Nessun CSV ricevuto. Invia il file come body text/csv.' });
  }

  const rows = parseCSV(req.body);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV vuoto o senza righe dati.' });

  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  const idxVeg = header.findIndex(h => h.includes('ortaggio') || h.includes('vegetable') || h === 'name');
  const idxWeight = header.findIndex(h => h.includes('peso') || h.includes('weight'));
  const idxDate = header.findIndex(h => h === 'data' || h.includes('date'));
  const idxNotes = header.findIndex(h => h === 'note' || h.includes('notes'));

  if (idxVeg === -1 || idxWeight === -1 || idxDate === -1) {
    return res.status(400).json({ error: 'CSV senza colonne obbligatorie (servono Ortaggio/Vegetable, Peso/Weight, Data/Date).' });
  }

  let imported = 0;
  let vegetablesCreated = 0;
  let skipped = 0;
  const errors = [];

  try {
    db.exec('BEGIN TRANSACTION;');

    if (mode === 'replace') {
      // PRIMA harvests (FK), POI vegetables. Con ON DELETE CASCADE l'ordine è
      // logico ma non strettamente necessario in SQLite. Comunque meglio esplicito.
      db.run('DELETE FROM harvests;');
      db.run('DELETE FROM vegetables;');
    }

    const vegMap = new Map(
      queryAll('SELECT id, name FROM vegetables')
        .map(v => [String(v.name).toLowerCase(), v.id])
    );

    // Dedup solo in modalità append: salta righe identiche a quelle già presenti.
    const existingKeys = mode === 'append'
      ? new Set(
          queryAll('SELECT vegetable_id, weight, date, notes FROM harvests')
            .map(h => `${h.vegetable_id}|${h.weight}|${h.date}|${String(h.notes || '').trim()}`)
        )
      : new Set();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const neededMax = Math.max(idxVeg, idxWeight, idxDate);
      if (!row || row.length <= neededMax) { skipped++; continue; }

      const vegName = String(row[idxVeg] || '').trim();
      const weight = parseFloat(String(row[idxWeight] || '').replace(',', '.'));
      let date = String(row[idxDate] || '').trim();
      const notes = idxNotes !== -1 ? String(row[idxNotes] || '').trim() : '';

      if (!vegName || isNaN(weight) || weight <= 0) {
        skipped++;
        if (errors.length < 20) errors.push(`Riga ${i + 1}: ortaggio o peso non valido.`);
        continue;
      }

      // Accetta anche "DD/MM/YYYY" convertendolo in "YYYY-MM-DD".
      if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)) {
        const [d, m, y] = date.split('/');
        date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        skipped++;
        if (errors.length < 20) errors.push(`Riga ${i + 1}: data non valida (atteso YYYY-MM-DD).`);
        continue;
      }

      let vegId = vegMap.get(vegName.toLowerCase());
      if (!vegId) {
        db.run('INSERT INTO vegetables (name) VALUES (?)', [vegName]);
        vegId = lastInsertId();
        vegMap.set(vegName.toLowerCase(), vegId);
        vegetablesCreated++;
      }

      const dedupeKey = `${vegId}|${weight}|${date}|${notes}`;
      if (existingKeys.has(dedupeKey)) { skipped++; continue; }

      db.run('INSERT INTO harvests (vegetable_id, weight, date, notes) VALUES (?, ?, ?, ?)',
        [vegId, weight, date, notes]);
      existingKeys.add(dedupeKey);
      imported++;
    }

    db.exec('COMMIT;');
    saveDB();

    res.json({
      ok: true,
      mode,
      imported,
      vegetables_created: vegetablesCreated,
      skipped,
      errors
    });
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    console.error('import error:', err.message);
    res.status(500).json({ error: 'Errore DB durante import: ' + err.message });
  }
});

// --- Harvests ---

app.get('/api/harvests', (req, res) => {
  res.json(queryAll(`
    SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC
  `));
});

app.post('/api/harvests', (req, res) => {
  const vegId = parseInt(req.body.vegetable_id);
  const weight = parseFloat(req.body.weight);
  if (isNaN(vegId) || isNaN(weight) || weight <= 0) {
    return res.status(400).json({ error: 'Ortaggio e peso validi obbligatori' });
  }
  if (queryAll('SELECT id FROM vegetables WHERE id = ?', [vegId]).length === 0) {
    return res.status(400).json({ error: 'Ortaggio non trovato' });
  }
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  try {
    db.run('INSERT INTO harvests (vegetable_id, weight, date, notes) VALUES (?, ?, ?, ?)',
      [vegId, weight, date, req.body.notes || '']);
    const id = lastInsertId();
    saveDB();
    const row = queryAll(`
      SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
      FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
      WHERE h.id = ?`, [id]);
    if (row.length === 0) return res.status(500).json({ error: 'Errore post-insert' });
    res.json(row[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/harvests/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const vegId = parseInt(req.body.vegetable_id);
  const weight = parseFloat(req.body.weight);
  if (isNaN(id) || isNaN(vegId) || isNaN(weight) || weight <= 0) {
    return res.status(400).json({ error: 'Dati non validi' });
  }
  try {
    db.run('UPDATE harvests SET vegetable_id = ?, weight = ?, date = ?, notes = ? WHERE id = ?',
      [vegId, weight, req.body.date, req.body.notes || '', id]);
    saveDB();
    const row = queryAll(`
      SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
      FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
      WHERE h.id = ?`, [id]);
    if (row.length === 0) return res.status(404).json({ error: 'Non trovato' });
    res.json(row[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/harvests/:id', (req, res) => {
  db.run('DELETE FROM harvests WHERE id = ?', [parseInt(req.params.id)]);
  saveDB();
  res.json({ ok: true });
});

// --- Stats ---

app.get('/api/stats', (req, res) => {
  const byVeg = queryAll(`
    SELECT v.name, SUM(h.weight) AS total_weight, COUNT(*) AS count
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    GROUP BY h.vegetable_id
    ORDER BY total_weight DESC
  `);
  const grandTotalRow = queryAll('SELECT COALESCE(SUM(weight), 0) AS total FROM harvests');
  const grandTotal = grandTotalRow.length > 0 ? grandTotalRow[0].total : 0;
  const recent = queryAll(`
    SELECT h.id, h.vegetable_id, v.name AS vegetable_name, h.weight, h.date, h.notes
    FROM harvests h JOIN vegetables v ON h.vegetable_id = v.id
    ORDER BY h.date DESC, h.id DESC LIMIT 10
  `);
  const monthly = queryAll(`
    SELECT strftime('%Y-%m', h.date) AS month, SUM(h.weight) AS total_weight, COUNT(*) AS count
    FROM harvests h
    GROUP BY month
    ORDER BY month DESC
  `);
  res.json({ by_vegetable: byVeg, grand_total: grandTotal, recent, monthly });
});

// SPA fallback (per la PWA, ogni route non-API serve index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Salva il DB in modo sincrono all'uscita
process.on('SIGINT', () => { saveDBSync(); process.exit(0); });
process.on('SIGTERM', () => { saveDBSync(); process.exit(0); });

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌿 Orto running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
